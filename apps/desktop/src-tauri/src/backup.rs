use std::{
    collections::{HashMap, HashSet},
    fs::{self, File},
    io::{Read, Write},
    path::{Component, Path, PathBuf},
};

use chrono::Utc;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;
use zip::{write::FileOptions, CompressionMethod, ZipArchive, ZipWriter};

use crate::{
    cache::{
        self, ActivityKind, ActivityScope, ActivityStatus, BackupArtifactFormat, NewActivityRecord,
    },
    codex::{self, ThreadRecord},
};

const BACKUP_FORMAT_VERSION: u32 = 1;
const BACKUP_EXTENSION: &str = ".threaddock-backup.zip";
const BACKUP_FOLDER_EXTENSION: &str = ".threaddock-backup";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupRecord {
    pub backup_id: String,
    pub created_at: String,
    pub label: String,
    pub format: String,
    pub target_path: String,
    pub thread_count: usize,
    pub family_mode: bool,
    pub total_bytes: u64,
    pub manifest_version: u32,
    pub source_codex_home: String,
    pub thread_ids: Vec<String>,
    pub family_roots: Vec<String>,
    pub artifact_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupInventorySnapshot {
    pub backup_directory: String,
    pub scanned_at: String,
    pub issues: Vec<BackupInventoryIssue>,
    pub records: Vec<BackupRecord>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupInventoryIssue {
    pub message: String,
    pub path: String,
    pub severity: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupExportRequest {
    pub thread_ids: Vec<String>,
    #[serde(default)]
    pub destination_dir: Option<String>,
    #[serde(default)]
    pub format: BackupArtifactFormat,
    pub mode: BackupExportMode,
    #[serde(default)]
    pub families: Vec<BackupFamilyInput>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupImportRequest {
    pub artifact_path: String,
    pub collision_mode: BackupImportCollisionMode,
    pub restore_mode: BackupImportRestoreMode,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupPreviewRequest {
    pub artifact_path: String,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BackupImportCollisionMode {
    Skip,
    Replace,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BackupImportRestoreMode {
    ArchiveOnly,
    PreserveStatus,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupImportResult {
    pub artifact_path: String,
    pub imported_count: usize,
    pub imported_thread_ids: Vec<String>,
    pub skipped_count: usize,
    pub skipped_thread_ids: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupFamilyInput {
    pub family_id: String,
    #[serde(default)]
    pub root_thread_id: Option<String>,
    pub label: String,
    pub thread_ids: Vec<String>,
    #[serde(default)]
    pub orphaned: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum BackupExportMode {
    Threads,
    Family,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BackupManifest {
    backup_format_version: u32,
    created_at: String,
    threaddock_version: String,
    label: String,
    mode: BackupExportMode,
    source_codex_home: String,
    exported_thread_ids: Vec<String>,
    exported_family_roots: Vec<String>,
    total_rollout_bytes: u64,
    files: Vec<ManifestFileEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManifestFileEntry {
    thread_id: String,
    archive_path: String,
    rollout_bytes: u64,
    sha256: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BackupFamilyMetadata {
    family_id: String,
    root_thread_id: Option<String>,
    label: String,
    thread_ids: Vec<String>,
    total_rollout_bytes: u64,
    orphaned: bool,
}

#[derive(Debug)]
struct VerifiedImportMetadata {
    manifest: BackupManifest,
    threads_by_id: HashMap<String, ThreadRecord>,
}

#[derive(Debug)]
struct PlannedImport {
    destination_path: PathBuf,
    existing_path: Option<PathBuf>,
    temp_path: PathBuf,
    thread_id: String,
}

#[derive(Debug)]
struct CommittedImport {
    destination_path: PathBuf,
    existing_path: Option<PathBuf>,
    replacement_backup_path: Option<PathBuf>,
    thread_id: String,
}

pub fn load_backup_inventory(
    destination_dir: Option<String>,
) -> Result<BackupInventorySnapshot, String> {
    let backup_directory = resolve_backup_directory(destination_dir.as_deref())?;
    fs::create_dir_all(&backup_directory).map_err(|error| {
        format!(
            "Failed to create backup directory {}: {error}",
            backup_directory.display()
        )
    })?;

    let mut records = Vec::new();
    let mut issues = Vec::new();

    for entry in fs::read_dir(&backup_directory).map_err(|error| {
        format!(
            "Failed to read backup directory {}: {error}",
            backup_directory.display()
        )
    })? {
        let Ok(entry) = entry else {
            continue;
        };

        let path = entry.path();
        match inspect_backup_artifact(&path) {
            Ok(Some(record)) => records.push(record),
            Ok(None) => {}
            Err(error) => {
                log::warn!("Failed to inspect backup {}: {error}", path.display());
                issues.push(BackupInventoryIssue {
                    message: error,
                    path: path.display().to_string(),
                    severity: "warning".to_string(),
                });
            }
        }
    }

    records.sort_by(|left, right| {
        right
            .created_at
            .cmp(&left.created_at)
            .then_with(|| left.label.cmp(&right.label))
    });

    if let Err(error) = cache::sync_backup_inventory(
        &records
            .iter()
            .map(|record| cache::BackupCacheRecord {
                artifact_bytes: record.artifact_bytes,
                backup_id: record.backup_id.clone(),
                created_at: record.created_at.clone(),
                family_mode: record.family_mode,
                family_roots: record.family_roots.clone(),
                format: record.format.clone(),
                label: record.label.clone(),
                manifest_version: record.manifest_version,
                source_codex_home: record.source_codex_home.clone(),
                target_path: record.target_path.clone(),
                thread_count: record.thread_count,
                thread_ids: record.thread_ids.clone(),
                total_bytes: record.total_bytes,
            })
            .collect::<Vec<_>>(),
    ) {
        log::warn!("Failed to synchronize cached backup records: {error}");
    }

    Ok(BackupInventorySnapshot {
        backup_directory: backup_directory.display().to_string(),
        issues,
        scanned_at: Utc::now().to_rfc3339(),
        records,
    })
}

pub fn export_backup(request: BackupExportRequest) -> Result<BackupRecord, String> {
    let snapshot = codex::load_thread_library()?;
    let backup_directory = resolve_backup_directory(request.destination_dir.as_deref())?;
    fs::create_dir_all(&backup_directory).map_err(|error| {
        format!(
            "Failed to create backup directory {}: {error}",
            backup_directory.display()
        )
    })?;

    let thread_map = snapshot
        .threads
        .iter()
        .cloned()
        .map(|thread| (thread.thread_id.clone(), thread))
        .collect::<HashMap<_, _>>();

    let mut unique_thread_ids = Vec::new();
    let mut seen = HashSet::new();
    for thread_id in request.thread_ids {
        if seen.insert(thread_id.clone()) {
            unique_thread_ids.push(thread_id);
        }
    }

    if unique_thread_ids.is_empty() {
        return Err("Select at least one thread before exporting a backup.".to_string());
    }

    let mut selected_threads = Vec::new();
    for thread_id in &unique_thread_ids {
        let thread = thread_map
            .get(thread_id)
            .cloned()
            .ok_or_else(|| format!("Thread {thread_id} is no longer available for export."))?;
        selected_threads.push(thread);
    }

    let label = build_backup_label(&request.mode, &request.families, &selected_threads);
    let timestamp = Utc::now();
    let backup_id = Uuid::new_v4().to_string();
    let base_name = format!("{}-{}", slugify(&label), timestamp.format("%Y%m%dT%H%M%SZ"));
    let target_path = next_available_path(&backup_directory, &base_name, &request.format);

    let mut manifest_files = Vec::new();
    let mut thread_payloads = Vec::new();
    for thread in &selected_threads {
        validate_safe_component(&thread.thread_id, "thread id")?;
        let rollout_path = materialized_rollout_path(thread)?;
        let bytes = fs::read(&rollout_path).map_err(|error| {
            format!(
                "Failed to read rollout file {} for export: {error}",
                rollout_path.display()
            )
        })?;
        let archive_path = format!("threads/{}.jsonl", thread.thread_id);
        let checksum = sha256_hex(&bytes);
        let rollout_bytes = bytes.len() as u64;

        manifest_files.push(ManifestFileEntry {
            thread_id: thread.thread_id.clone(),
            archive_path: archive_path.clone(),
            rollout_bytes,
            sha256: checksum,
        });
        thread_payloads.push(redacted_thread_metadata(thread, &archive_path));
    }

    let family_metadata = build_family_metadata(&request.families, &thread_map);
    let family_roots = family_metadata
        .iter()
        .filter_map(|family| family.root_thread_id.clone())
        .collect::<Vec<_>>();
    let total_bytes = manifest_files
        .iter()
        .map(|entry| entry.rollout_bytes)
        .sum::<u64>();

    let manifest = BackupManifest {
        backup_format_version: BACKUP_FORMAT_VERSION,
        created_at: timestamp.to_rfc3339(),
        threaddock_version: env!("CARGO_PKG_VERSION").to_string(),
        label: label.clone(),
        mode: request.mode,
        source_codex_home: snapshot.codex_home.clone(),
        exported_thread_ids: unique_thread_ids.clone(),
        exported_family_roots: family_roots.clone(),
        total_rollout_bytes: total_bytes,
        files: manifest_files,
    };

    let artifact_bytes = match request.format {
        BackupArtifactFormat::Zip => write_zip_backup(
            &target_path,
            &selected_threads,
            &thread_payloads,
            &family_metadata,
            &manifest,
        )?,
        BackupArtifactFormat::Folder => write_folder_backup(
            &target_path,
            &selected_threads,
            &thread_payloads,
            &family_metadata,
            &manifest,
        )?,
    };

    let record = BackupRecord {
        backup_id,
        created_at: manifest.created_at.clone(),
        label,
        format: backup_format_label(&request.format).to_string(),
        target_path: target_path.display().to_string(),
        thread_count: unique_thread_ids.len(),
        family_mode: matches!(manifest.mode, BackupExportMode::Family),
        total_bytes,
        manifest_version: BACKUP_FORMAT_VERSION,
        source_codex_home: "redacted".to_string(),
        thread_ids: unique_thread_ids,
        family_roots,
        artifact_bytes,
    };

    if let Err(error) = cache::append_activity(NewActivityRecord {
        artifact_path: Some(record.target_path.clone()),
        created_at: record.created_at.clone(),
        detail: format!(
            "Exported {} thread{} as a {} backup artifact.",
            record.thread_count,
            if record.thread_count == 1 { "" } else { "s" },
            record.format
        ),
        kind: ActivityKind::Backup,
        label: record.label.clone(),
        scope: if record.family_mode {
            ActivityScope::Family
        } else if record.thread_count > 1 {
            ActivityScope::Threads
        } else {
            ActivityScope::Thread
        },
        status: ActivityStatus::Success,
        thread_ids: record.thread_ids.clone(),
    }) {
        log::warn!("Failed to record ThreadDock backup activity: {error}");
    }

    Ok(record)
}

pub fn import_backup_artifact(request: BackupImportRequest) -> Result<BackupImportResult, String> {
    let snapshot = codex::load_thread_library()?;
    let artifact_path = PathBuf::from(request.artifact_path.trim());
    if !artifact_path.exists() {
        return Err(format!(
            "Backup artifact {} does not exist.",
            artifact_path.display()
        ));
    }

    let verified_artifact = read_verified_import_metadata_from_artifact(&artifact_path)?;
    let existing_threads = snapshot
        .threads
        .iter()
        .map(|thread| (thread.thread_id.clone(), thread.clone()))
        .collect::<HashMap<_, _>>();
    let codex_root = PathBuf::from(&snapshot.codex_home);
    let canonical_codex_root = codex_root.canonicalize().map_err(|error| {
        format!(
            "Failed to canonicalize Codex home {} before import: {error}",
            codex_root.display()
        )
    })?;
    let trashed_thread_ids = crate::trash::trashed_thread_ids()
        .map_err(|error| format!("Failed to inspect ThreadDock trash before import: {error}"))?;
    let mut imported_thread_ids = Vec::new();
    let mut skipped_thread_ids = Vec::new();
    let mut staged_temp_paths = Vec::new();

    let plan_result = (|| {
        let mut plans = Vec::new();

        for file in &verified_artifact.manifest.files {
            let thread = verified_artifact
                .threads_by_id
                .get(&file.thread_id)
                .cloned()
                .ok_or_else(|| format!("Backup metadata is missing thread {}.", file.thread_id))?;
            validate_safe_component(&thread.thread_id, "thread id")?;

            if trashed_thread_ids.contains(&thread.thread_id) {
                match request.collision_mode {
                    BackupImportCollisionMode::Skip => {
                        skipped_thread_ids.push(thread.thread_id.clone());
                        continue;
                    }
                    BackupImportCollisionMode::Replace => {
                        return Err(format!(
                            "Thread {} is currently in ThreadDock Trash. Restore or purge the trash item before replacing it from a backup.",
                            thread.thread_id
                        ));
                    }
                }
            }

            let existing_path = if let Some(existing) = existing_threads.get(&thread.thread_id) {
                match request.collision_mode {
                    BackupImportCollisionMode::Skip => {
                        skipped_thread_ids.push(thread.thread_id.clone());
                        continue;
                    }
                    BackupImportCollisionMode::Replace => {
                        if existing.read_only {
                            return Err(format!(
                                "Thread {} is read-only and cannot be replaced.",
                                existing.thread_id
                            ));
                        }

                        let path = PathBuf::from(&existing.rollout_path);
                        if path.exists() {
                            ensure_existing_path_is_safe(
                                &codex_root,
                                &canonical_codex_root,
                                &path,
                                "replacement source",
                            )?;
                            Some(path)
                        } else {
                            None
                        }
                    }
                }
            } else {
                None
            };

            let mut destination_path =
                import_destination_path(&codex_root, &thread, &request.restore_mode);
            ensure_path_stays_under(&codex_root, &destination_path, "import destination")?;

            if path_entry_exists(&destination_path)
                && !existing_path
                    .as_ref()
                    .is_some_and(|path| same_path_text(path, &destination_path))
            {
                destination_path = next_available_file_path(&destination_path);
                ensure_path_stays_under(&codex_root, &destination_path, "import destination")?;
            }

            let parent = destination_path.parent().ok_or_else(|| {
                format!(
                    "Unable to resolve a destination folder for thread {}.",
                    thread.thread_id
                )
            })?;
            fs::create_dir_all(parent)
                .map_err(|error| format!("Failed to create {}: {error}", parent.display()))?;
            ensure_destination_parent_is_safe(
                &codex_root,
                &canonical_codex_root,
                &destination_path,
                "import destination",
            )?;

            let temp_path = next_available_file_path(&parent.join(format!(
                ".threaddock-import-{}-{}.tmp",
                slugify(&thread.thread_id),
                Uuid::new_v4()
            )));
            let verified_bytes = read_verified_artifact_payload(&artifact_path, file)?;
            fs::write(&temp_path, &verified_bytes).map_err(|error| {
                format!(
                    "Failed to stage thread {} to {}: {error}",
                    thread.thread_id,
                    temp_path.display()
                )
            })?;
            let staged_bytes = fs::read(&temp_path).map_err(|error| {
                format!(
                    "Failed to verify staged thread {} at {}: {error}",
                    thread.thread_id,
                    temp_path.display()
                )
            })?;
            if sha256_hex(&staged_bytes) != file.sha256 {
                return Err(format!(
                    "Staged bytes for thread {} failed checksum verification.",
                    thread.thread_id
                ));
            }

            staged_temp_paths.push(temp_path.clone());
            plans.push(PlannedImport {
                destination_path,
                existing_path,
                temp_path,
                thread_id: thread.thread_id,
            });
        }

        Ok::<Vec<PlannedImport>, String>(plans)
    })();

    let plans = match plan_result {
        Ok(plans) => plans,
        Err(error) => {
            cleanup_temp_files(&staged_temp_paths);
            return Err(error);
        }
    };

    let mut committed = Vec::new();
    let mut rollback_files = Vec::new();

    for plan in plans {
        let replacement_backup_path = if let Some(existing_path) = plan.existing_path.as_ref() {
            if path_entry_exists(existing_path) {
                let file_name = existing_path
                    .file_name()
                    .and_then(|value| value.to_str())
                    .unwrap_or("rollout.jsonl");
                let backup_path = next_available_file_path(&existing_path.with_file_name(format!(
                    ".threaddock-replace-{}-{file_name}",
                    Uuid::new_v4()
                )));
                fs::rename(existing_path, &backup_path).map_err(|error| {
                    format!(
                        "Failed to stage existing thread {} for replacement at {}: {error}",
                        plan.thread_id,
                        existing_path.display()
                    )
                })?;
                rollback_files.push(backup_path.clone());
                Some(backup_path)
            } else {
                None
            }
        } else {
            None
        };

        let commit_result = (|| {
            ensure_destination_parent_is_safe(
                &codex_root,
                &canonical_codex_root,
                &plan.destination_path,
                "import destination",
            )?;
            if path_entry_exists(&plan.destination_path) {
                return Err(format!(
                    "Import destination {} already exists.",
                    plan.destination_path.display()
                ));
            }

            fs::rename(&plan.temp_path, &plan.destination_path).map_err(|error| {
                format!(
                    "Failed to restore thread {} to {}: {error}",
                    plan.thread_id,
                    plan.destination_path.display()
                )
            })
        })();

        if let Err(error) = commit_result {
            rollback_committed_imports(&mut committed);
            rollback_current_replacement(&plan, replacement_backup_path.as_ref());
            let _ = fs::remove_file(&plan.temp_path);
            return Err(error);
        }

        committed.push(CommittedImport {
            destination_path: plan.destination_path,
            existing_path: plan.existing_path,
            replacement_backup_path,
            thread_id: plan.thread_id.clone(),
        });
        imported_thread_ids.push(plan.thread_id);
    }

    for backup_path in rollback_files {
        if let Err(error) = fs::remove_file(&backup_path) {
            log::warn!(
                "Failed to remove replacement rollback file {}: {error}",
                backup_path.display()
            );
        }
    }

    if let Err(error) = cache::append_activity(NewActivityRecord {
        artifact_path: Some(artifact_path.display().to_string()),
        created_at: Utc::now().to_rfc3339(),
        detail: format!(
            "Imported {} thread{} from {}.",
            imported_thread_ids.len(),
            if imported_thread_ids.len() == 1 {
                ""
            } else {
                "s"
            },
            artifact_path.display()
        ),
        kind: ActivityKind::Import,
        label: "Backup import".to_string(),
        scope: if imported_thread_ids.len() > 1 {
            ActivityScope::Threads
        } else {
            ActivityScope::Thread
        },
        status: ActivityStatus::Success,
        thread_ids: imported_thread_ids.clone(),
    }) {
        log::warn!("Failed to record ThreadDock import activity: {error}");
    }

    Ok(BackupImportResult {
        artifact_path: artifact_path.display().to_string(),
        imported_count: imported_thread_ids.len(),
        imported_thread_ids,
        skipped_count: skipped_thread_ids.len(),
        skipped_thread_ids,
    })
}

pub fn preview_backup_artifact(request: BackupPreviewRequest) -> Result<BackupRecord, String> {
    let artifact_path = PathBuf::from(request.artifact_path.trim());
    if !artifact_path.exists() {
        return Err(format!(
            "Backup artifact {} does not exist.",
            artifact_path.display()
        ));
    }

    let record = inspect_backup_artifact(&artifact_path)?.ok_or_else(|| {
        format!(
            "{} is not a ThreadDock backup artifact.",
            artifact_path.display()
        )
    })?;
    let verified_artifact = read_verified_import_metadata_from_artifact(&artifact_path)?;
    if verified_artifact.threads_by_id.len() != record.thread_count {
        return Err(format!(
            "Backup preview mismatch: manifest lists {} thread{} but {} payload{} verified.",
            record.thread_count,
            if record.thread_count == 1 { "" } else { "s" },
            verified_artifact.threads_by_id.len(),
            if verified_artifact.threads_by_id.len() == 1 {
                ""
            } else {
                "s"
            }
        ));
    }

    Ok(record)
}

fn build_family_metadata(
    families: &[BackupFamilyInput],
    thread_map: &HashMap<String, ThreadRecord>,
) -> Vec<BackupFamilyMetadata> {
    families
        .iter()
        .map(|family| BackupFamilyMetadata {
            family_id: family.family_id.clone(),
            root_thread_id: family.root_thread_id.clone(),
            label: family.label.clone(),
            thread_ids: family.thread_ids.clone(),
            total_rollout_bytes: family
                .thread_ids
                .iter()
                .filter_map(|thread_id| thread_map.get(thread_id))
                .map(|thread| thread.raw_rollout_bytes)
                .sum(),
            orphaned: family.orphaned,
        })
        .collect()
}

fn redacted_thread_metadata(thread: &ThreadRecord, archive_path: &str) -> ThreadRecord {
    let mut redacted = thread.clone();
    redacted.cwd = None;
    redacted.rollout_path = archive_path.to_string();
    redacted
}

fn build_backup_label(
    mode: &BackupExportMode,
    families: &[BackupFamilyInput],
    threads: &[ThreadRecord],
) -> String {
    match mode {
        BackupExportMode::Family => families
            .first()
            .map(|family| format!("{} family", family.label.trim()))
            .unwrap_or_else(|| format!("{}-thread family export", threads.len())),
        BackupExportMode::Threads => {
            if threads.len() == 1 {
                format!("{} thread", threads[0].title.trim())
            } else {
                format!("{} selected threads", threads.len())
            }
        }
    }
}

fn materialized_rollout_path(thread: &ThreadRecord) -> Result<PathBuf, String> {
    let path = PathBuf::from(&thread.rollout_path);

    if !path.exists() {
        return Err(format!(
            "Thread {} does not have a readable rollout file on disk.",
            thread.thread_id
        ));
    }

    Ok(path)
}

fn write_zip_backup(
    target_path: &Path,
    threads: &[ThreadRecord],
    thread_payloads: &[ThreadRecord],
    family_metadata: &[BackupFamilyMetadata],
    manifest: &BackupManifest,
) -> Result<u64, String> {
    let zip_file = File::create(target_path)
        .map_err(|error| format!("Failed to create {}: {error}", target_path.display()))?;
    let mut zip = ZipWriter::new(zip_file);
    let zip_options = FileOptions::default()
        .compression_method(CompressionMethod::Deflated)
        .unix_permissions(0o644);

    for thread in threads {
        let rollout_path = materialized_rollout_path(thread)?;
        let bytes = fs::read(&rollout_path).map_err(|error| {
            format!(
                "Failed to read rollout file {} for export: {error}",
                rollout_path.display()
            )
        })?;
        let archive_path = format!("threads/{}.jsonl", thread.thread_id);

        zip.start_file(&archive_path, zip_options)
            .map_err(|error| {
                format!("Failed to start {archive_path} in backup archive: {error}")
            })?;
        zip.write_all(&bytes).map_err(|error| {
            format!("Failed to write {archive_path} to backup archive: {error}")
        })?;
    }

    write_json_entry(&mut zip, "manifest.json", manifest, zip_options)?;
    write_json_entry(
        &mut zip,
        "metadata/threads.json",
        thread_payloads,
        zip_options,
    )?;
    write_json_entry(
        &mut zip,
        "metadata/families.json",
        family_metadata,
        zip_options,
    )?;

    let file = zip
        .finish()
        .map_err(|error| format!("Failed to finalize backup archive: {error}"))?;
    let artifact_bytes = file
        .metadata()
        .map(|metadata| metadata.len())
        .unwrap_or_default();
    verify_zip_backup_artifact(target_path, manifest)?;
    Ok(artifact_bytes)
}

fn write_folder_backup(
    target_path: &Path,
    threads: &[ThreadRecord],
    thread_payloads: &[ThreadRecord],
    family_metadata: &[BackupFamilyMetadata],
    manifest: &BackupManifest,
) -> Result<u64, String> {
    fs::create_dir_all(target_path).map_err(|error| {
        format!(
            "Failed to create backup folder {}: {error}",
            target_path.display()
        )
    })?;
    let threads_root = target_path.join("threads");
    let metadata_root = target_path.join("metadata");
    fs::create_dir_all(&threads_root).map_err(|error| {
        format!(
            "Failed to create backup threads folder {}: {error}",
            threads_root.display()
        )
    })?;
    fs::create_dir_all(&metadata_root).map_err(|error| {
        format!(
            "Failed to create backup metadata folder {}: {error}",
            metadata_root.display()
        )
    })?;

    for thread in threads {
        let rollout_path = materialized_rollout_path(thread)?;
        let target = threads_root.join(format!("{}.jsonl", thread.thread_id));
        fs::copy(&rollout_path, &target).map_err(|error| {
            format!(
                "Failed to copy rollout file {} to {}: {error}",
                rollout_path.display(),
                target.display()
            )
        })?;
    }

    write_pretty_json_file(&target_path.join("manifest.json"), manifest)?;
    write_pretty_json_file(&metadata_root.join("threads.json"), thread_payloads)?;
    write_pretty_json_file(&metadata_root.join("families.json"), family_metadata)?;

    verify_folder_backup_artifact(target_path, manifest)?;
    directory_size(target_path)
}

fn write_pretty_json_file<T: Serialize + ?Sized>(path: &Path, value: &T) -> Result<(), String> {
    let payload = serde_json::to_vec_pretty(value)
        .map_err(|error| format!("Failed to serialize {}: {error}", path.display()))?;
    fs::write(path, payload).map_err(|error| format!("Failed to write {}: {error}", path.display()))
}

fn write_json_entry<T: Serialize + ?Sized>(
    zip: &mut ZipWriter<File>,
    archive_path: &str,
    value: &T,
    options: FileOptions,
) -> Result<(), String> {
    let payload = serde_json::to_vec_pretty(value)
        .map_err(|error| format!("Failed to serialize {archive_path}: {error}"))?;

    zip.start_file(archive_path, options)
        .map_err(|error| format!("Failed to start {archive_path} in backup archive: {error}"))?;
    zip.write_all(&payload)
        .map_err(|error| format!("Failed to write {archive_path} to backup archive: {error}"))
}

pub(crate) fn inspect_backup_artifact(path: &Path) -> Result<Option<BackupRecord>, String> {
    if path.is_dir() {
        if !path
            .file_name()
            .and_then(|value| value.to_str())
            .is_some_and(|value| value.ends_with(BACKUP_FOLDER_EXTENSION))
        {
            return Ok(None);
        }

        let manifest = read_manifest_from_folder(path)?;
        validate_backup_manifest(&manifest)?;
        verify_folder_backup_artifact(path, &manifest)?;
        let artifact_bytes = directory_size(path)?;
        return Ok(Some(record_from_manifest(
            &manifest,
            path,
            artifact_bytes,
            "folder",
        )));
    }

    if !path.is_file() {
        return Ok(None);
    }

    if path.extension().and_then(|value| value.to_str()) != Some("zip")
        || !path
            .file_name()
            .and_then(|value| value.to_str())
            .is_some_and(|value| value.ends_with(BACKUP_EXTENSION))
    {
        return Ok(None);
    }

    let manifest = read_manifest_from_zip(path)?;
    validate_backup_manifest(&manifest)?;
    verify_zip_backup_artifact(path, &manifest)?;
    let artifact_bytes = fs::metadata(path)
        .map(|metadata| metadata.len())
        .unwrap_or(0);
    Ok(Some(record_from_manifest(
        &manifest,
        path,
        artifact_bytes,
        "zip",
    )))
}

fn read_verified_import_metadata_from_artifact(
    path: &Path,
) -> Result<VerifiedImportMetadata, String> {
    let manifest = if path.is_dir() {
        read_manifest_from_folder(path)?
    } else {
        read_manifest_from_zip(path)?
    };
    validate_backup_manifest(&manifest)?;

    let thread_payloads = read_thread_payloads_from_artifact(path)?;
    let payloads_by_id = thread_payloads
        .into_iter()
        .map(|thread| (thread.thread_id.clone(), thread))
        .collect::<HashMap<_, _>>();
    let expected_ids = manifest
        .exported_thread_ids
        .iter()
        .cloned()
        .collect::<HashSet<_>>();

    if payloads_by_id.len() != expected_ids.len() {
        return Err("Backup metadata does not match the manifest thread count.".to_string());
    }

    for thread_id in payloads_by_id.keys() {
        if !expected_ids.contains(thread_id) {
            return Err(format!(
                "Backup metadata contains unexpected thread id {thread_id}."
            ));
        }
    }

    verify_backup_payloads(path, &manifest)?;

    Ok(VerifiedImportMetadata {
        manifest,
        threads_by_id: payloads_by_id,
    })
}

fn verify_backup_payloads(path: &Path, manifest: &BackupManifest) -> Result<(), String> {
    for file in &manifest.files {
        let _ = read_verified_artifact_payload(path, file)?;
    }
    Ok(())
}

fn read_verified_artifact_payload(
    path: &Path,
    file: &ManifestFileEntry,
) -> Result<Vec<u8>, String> {
    let bytes = read_artifact_entry(path, &file.archive_path)?;

    if bytes.len() as u64 != file.rollout_bytes {
        return Err(format!(
            "Backup payload {} has an unexpected byte length.",
            file.archive_path
        ));
    }

    let actual_sha256 = sha256_hex(&bytes);
    if actual_sha256 != file.sha256 {
        return Err(format!(
            "Backup payload {} failed checksum verification.",
            file.archive_path
        ));
    }

    Ok(bytes)
}

fn read_thread_payloads_from_artifact(path: &Path) -> Result<Vec<ThreadRecord>, String> {
    let bytes = read_artifact_entry(path, "metadata/threads.json")?;
    serde_json::from_slice::<Vec<ThreadRecord>>(&bytes).map_err(|error| {
        format!(
            "Failed to parse thread metadata from {}: {error}",
            path.display()
        )
    })
}

fn read_artifact_entry(path: &Path, archive_path: &str) -> Result<Vec<u8>, String> {
    validate_archive_path(archive_path)?;

    if path.is_dir() {
        let safe_path = safe_artifact_path(path, archive_path)?;
        let root = path.canonicalize().map_err(|error| {
            format!(
                "Failed to canonicalize backup folder {}: {error}",
                path.display()
            )
        })?;
        let candidate = safe_path.canonicalize().map_err(|error| {
            format!(
                "Failed to canonicalize backup entry {}: {error}",
                safe_path.display()
            )
        })?;
        if !candidate.starts_with(&root) {
            return Err(format!(
                "Backup archive path {} escapes the artifact root.",
                archive_path
            ));
        }
        return fs::read(&safe_path).map_err(|error| {
            format!(
                "Failed to read {} from {}: {error}",
                archive_path,
                path.display()
            )
        });
    }

    let file =
        File::open(path).map_err(|error| format!("Failed to open {}: {error}", path.display()))?;
    let mut archive = ZipArchive::new(file)
        .map_err(|error| format!("Failed to read zip {}: {error}", path.display()))?;
    let mut entry = archive.by_name(archive_path).map_err(|error| {
        format!(
            "Backup {} is missing {archive_path}: {error}",
            path.display()
        )
    })?;
    let mut bytes = Vec::new();
    entry.read_to_end(&mut bytes).map_err(|error| {
        format!(
            "Failed to read {archive_path} from {}: {error}",
            path.display()
        )
    })?;
    Ok(bytes)
}

fn read_manifest_from_zip(path: &Path) -> Result<BackupManifest, String> {
    let file =
        File::open(path).map_err(|error| format!("Failed to open {}: {error}", path.display()))?;
    let mut archive = ZipArchive::new(file)
        .map_err(|error| format!("Failed to read zip {}: {error}", path.display()))?;
    let mut manifest_file = archive.by_name("manifest.json").map_err(|error| {
        format!(
            "Backup {} is missing manifest.json: {error}",
            path.display()
        )
    })?;

    let mut payload = String::new();
    manifest_file
        .read_to_string(&mut payload)
        .map_err(|error| format!("Failed to read manifest from {}: {error}", path.display()))?;

    serde_json::from_str::<BackupManifest>(&payload)
        .map_err(|error| format!("Failed to parse manifest from {}: {error}", path.display()))
}

fn read_manifest_from_folder(path: &Path) -> Result<BackupManifest, String> {
    let payload = fs::read_to_string(path.join("manifest.json")).map_err(|error| {
        format!(
            "Failed to read manifest from {}: {error}",
            path.join("manifest.json").display()
        )
    })?;
    serde_json::from_str::<BackupManifest>(&payload)
        .map_err(|error| format!("Failed to parse manifest from {}: {error}", path.display()))
}

fn record_from_manifest(
    manifest: &BackupManifest,
    path: &Path,
    artifact_bytes: u64,
    format: &str,
) -> BackupRecord {
    BackupRecord {
        backup_id: backup_id_from_path(path, format),
        created_at: manifest.created_at.clone(),
        label: manifest.label.clone(),
        format: format.to_string(),
        target_path: path.display().to_string(),
        thread_count: manifest.exported_thread_ids.len(),
        family_mode: matches!(manifest.mode, BackupExportMode::Family),
        total_bytes: manifest.total_rollout_bytes,
        manifest_version: manifest.backup_format_version,
        source_codex_home: manifest.source_codex_home.clone(),
        thread_ids: manifest.exported_thread_ids.clone(),
        family_roots: manifest.exported_family_roots.clone(),
        artifact_bytes,
    }
}

fn validate_backup_manifest(manifest: &BackupManifest) -> Result<(), String> {
    if manifest.backup_format_version != BACKUP_FORMAT_VERSION {
        return Err(format!(
            "Unsupported backup format version {}.",
            manifest.backup_format_version
        ));
    }

    if manifest.files.len() != manifest.exported_thread_ids.len() {
        return Err("Backup manifest file list does not match exported thread ids.".to_string());
    }

    let mut exported_ids = HashSet::new();
    for thread_id in &manifest.exported_thread_ids {
        validate_safe_component(thread_id, "thread id")?;
        if !exported_ids.insert(thread_id.clone()) {
            return Err(format!(
                "Backup manifest contains duplicate thread id {thread_id}."
            ));
        }
    }

    let mut file_ids = HashSet::new();
    let mut total_bytes = 0_u64;
    for file in &manifest.files {
        validate_safe_component(&file.thread_id, "thread id")?;
        if !exported_ids.contains(&file.thread_id) {
            return Err(format!(
                "Backup manifest contains payload for unexpected thread id {}.",
                file.thread_id
            ));
        }
        if !file_ids.insert(file.thread_id.clone()) {
            return Err(format!(
                "Backup manifest contains duplicate payload for thread id {}.",
                file.thread_id
            ));
        }

        let expected_archive_path = format!("threads/{}.jsonl", file.thread_id);
        if file.archive_path != expected_archive_path {
            return Err(format!(
                "Backup manifest path for thread {} is invalid.",
                file.thread_id
            ));
        }
        validate_archive_path(&file.archive_path)?;
        if file.sha256.len() != 64 || !file.sha256.chars().all(|value| value.is_ascii_hexdigit()) {
            return Err(format!(
                "Backup manifest checksum for thread {} is malformed.",
                file.thread_id
            ));
        }
        total_bytes = total_bytes.saturating_add(file.rollout_bytes);
    }

    if total_bytes != manifest.total_rollout_bytes {
        return Err(
            "Backup manifest total rollout bytes do not match payload entries.".to_string(),
        );
    }

    Ok(())
}

fn validate_safe_component(value: &str, label: &str) -> Result<(), String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(format!("Backup {label} cannot be empty."));
    }
    if trimmed == "." || trimmed == ".." {
        return Err(format!(
            "Backup {label} cannot be a path traversal component."
        ));
    }
    if trimmed.len() > 256 {
        return Err(format!("Backup {label} is too long."));
    }
    if trimmed
        .chars()
        .any(|character| character.is_control() || matches!(character, '/' | '\\'))
    {
        return Err(format!("Backup {label} contains unsafe path characters."));
    }
    Ok(())
}

fn validate_archive_path(archive_path: &str) -> Result<(), String> {
    let normalized = archive_path.replace('\\', "/");
    if normalized.trim().is_empty() {
        return Err("Backup archive path cannot be empty.".to_string());
    }

    for component in Path::new(&normalized).components() {
        match component {
            Component::Normal(value) => {
                let value = value
                    .to_str()
                    .ok_or_else(|| "Backup archive path is not valid UTF-8.".to_string())?;
                validate_safe_component(value, "archive path component")?;
            }
            Component::CurDir
            | Component::ParentDir
            | Component::RootDir
            | Component::Prefix(_) => {
                return Err("Backup archive path contains unsafe traversal.".to_string());
            }
        }
    }

    Ok(())
}

fn safe_artifact_path(root: &Path, archive_path: &str) -> Result<PathBuf, String> {
    validate_archive_path(archive_path)?;
    let normalized = archive_path.replace('\\', "/");
    let mut relative = PathBuf::new();

    for component in Path::new(&normalized).components() {
        if let Component::Normal(value) = component {
            relative.push(value);
        }
    }

    let candidate = root.join(relative);
    if !candidate.starts_with(root) {
        return Err("Backup archive path escapes the artifact root.".to_string());
    }

    Ok(candidate)
}

fn ensure_path_stays_under(root: &Path, path: &Path, label: &str) -> Result<(), String> {
    if !path.starts_with(root) {
        return Err(format!(
            "{} {} escapes {}.",
            label,
            path.display(),
            root.display()
        ));
    }
    Ok(())
}

fn ensure_destination_parent_is_safe(
    lexical_root: &Path,
    canonical_root: &Path,
    path: &Path,
    label: &str,
) -> Result<(), String> {
    ensure_path_stays_under(lexical_root, path, label)?;
    let parent = path
        .parent()
        .ok_or_else(|| format!("Unable to resolve parent for {} {}.", label, path.display()))?;
    reject_symlink_components(lexical_root, parent, label)?;
    let canonical_parent = parent.canonicalize().map_err(|error| {
        format!(
            "Failed to canonicalize {} parent {}: {error}",
            label,
            parent.display()
        )
    })?;
    if !canonical_parent.starts_with(canonical_root) {
        return Err(format!(
            "{} parent {} resolves outside Codex home {}.",
            label,
            canonical_parent.display(),
            canonical_root.display()
        ));
    }
    Ok(())
}

fn ensure_existing_path_is_safe(
    lexical_root: &Path,
    canonical_root: &Path,
    path: &Path,
    label: &str,
) -> Result<(), String> {
    ensure_path_stays_under(lexical_root, path, label)?;
    let canonical = path.canonicalize().map_err(|error| {
        format!(
            "Failed to canonicalize {} {}: {error}",
            label,
            path.display()
        )
    })?;
    if !canonical.starts_with(canonical_root) {
        return Err(format!(
            "{} {} resolves outside Codex home {}.",
            label,
            canonical.display(),
            canonical_root.display()
        ));
    }
    Ok(())
}

fn reject_symlink_components(root: &Path, path: &Path, label: &str) -> Result<(), String> {
    let relative = path
        .strip_prefix(root)
        .map_err(|_| format!("{} {} escapes {}.", label, path.display(), root.display()))?;
    let mut current = root.to_path_buf();
    for component in relative.components() {
        match component {
            Component::Normal(value) => {
                current.push(value);
                if fs::symlink_metadata(&current)
                    .map(|metadata| metadata.file_type().is_symlink())
                    .unwrap_or(false)
                {
                    return Err(format!(
                        "{} {} uses a symlinked directory component, which ThreadDock will not write through.",
                        label,
                        current.display()
                    ));
                }
            }
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err(format!(
                    "{} {} contains an unsafe path component.",
                    label,
                    path.display()
                ));
            }
        }
    }
    Ok(())
}

fn path_entry_exists(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok()
}

fn rollback_committed_imports(committed: &mut Vec<CommittedImport>) {
    while let Some(record) = committed.pop() {
        if path_entry_exists(&record.destination_path) {
            if let Err(error) = fs::remove_file(&record.destination_path) {
                log::error!(
                    "Failed to roll back imported thread {} at {}: {error}",
                    record.thread_id,
                    record.destination_path.display()
                );
            }
        }

        rollback_replacement(
            &record.thread_id,
            record.replacement_backup_path.as_ref(),
            record.existing_path.as_ref(),
        );
    }
}

fn rollback_current_replacement(plan: &PlannedImport, backup_path: Option<&PathBuf>) {
    rollback_replacement(&plan.thread_id, backup_path, plan.existing_path.as_ref());
}

fn rollback_replacement(
    thread_id: &str,
    backup_path: Option<&PathBuf>,
    existing_path: Option<&PathBuf>,
) {
    if let (Some(backup_path), Some(existing_path)) = (backup_path, existing_path) {
        if let Err(restore_error) = fs::rename(backup_path, existing_path) {
            log::error!(
                "Failed to roll back replacement for {} from {} to {}: {restore_error}",
                thread_id,
                backup_path.display(),
                existing_path.display()
            );
        }
    }
}

fn same_path_text(left: &Path, right: &Path) -> bool {
    let left = left.to_string_lossy();
    let right = right.to_string_lossy();

    if cfg!(target_os = "windows") {
        left.eq_ignore_ascii_case(&right)
    } else {
        left == right
    }
}

fn next_available_file_path(path: &Path) -> PathBuf {
    if !path_entry_exists(path) {
        return path.to_path_buf();
    }

    let parent = path.parent().unwrap_or_else(|| Path::new(""));
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("restored-thread");
    let extension = path.extension().and_then(|value| value.to_str());
    let mut index = 2_usize;

    loop {
        let file_name = match extension {
            Some(extension) if !extension.is_empty() => format!("{stem}-{index}.{extension}"),
            _ => format!("{stem}-{index}"),
        };
        let candidate = parent.join(file_name);
        if !path_entry_exists(&candidate) {
            return candidate;
        }
        index += 1;
    }
}

fn cleanup_temp_files(paths: &[PathBuf]) {
    for path in paths {
        if let Err(error) = fs::remove_file(path) {
            log::warn!(
                "Failed to remove staged import file {}: {error}",
                path.display()
            );
        }
    }
}

fn resolve_backup_directory(destination_dir: Option<&str>) -> Result<PathBuf, String> {
    if let Some(path) = destination_dir {
        let candidate = PathBuf::from(path.trim());
        if !candidate.as_os_str().is_empty() {
            return Ok(candidate);
        }
    }

    let base = dirs::document_dir()
        .or_else(dirs::home_dir)
        .ok_or_else(|| "Unable to resolve a default backup directory.".to_string())?;

    Ok(base.join("ThreadDock Backups"))
}

fn import_destination_path(
    codex_root: &Path,
    thread: &ThreadRecord,
    restore_mode: &BackupImportRestoreMode,
) -> PathBuf {
    let file_name = Path::new(&thread.rollout_path)
        .file_name()
        .and_then(|value| value.to_str())
        .map(sanitize_file_component)
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "restored-thread.jsonl".to_string());

    match restore_mode {
        BackupImportRestoreMode::PreserveStatus
            if matches!(thread.status, codex::ThreadStatus::Active) =>
        {
            let date = thread
                .created_at
                .as_deref()
                .and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok())
                .map(|value| value.with_timezone(&Utc))
                .unwrap_or_else(Utc::now);
            codex_root
                .join("sessions")
                .join(date.format("%Y").to_string())
                .join(date.format("%m").to_string())
                .join(date.format("%d").to_string())
                .join(&file_name)
        }
        _ => codex_root.join("archived_sessions").join(&file_name),
    }
}

fn next_available_path(parent: &Path, base_name: &str, format: &BackupArtifactFormat) -> PathBuf {
    let extension = match format {
        BackupArtifactFormat::Zip => BACKUP_EXTENSION,
        BackupArtifactFormat::Folder => BACKUP_FOLDER_EXTENSION,
    };
    let path = parent.join(format!("{base_name}{extension}"));
    if !path.exists() {
        return path;
    }

    let mut index = 2usize;

    loop {
        let candidate = parent.join(format!("{base_name}-{index}{extension}"));
        if !candidate.exists() {
            return candidate;
        }

        index += 1;
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut output = String::with_capacity(digest.len() * 2);

    for value in digest {
        output.push_str(&format!("{value:02x}"));
    }

    output
}

fn verify_zip_backup_artifact(path: &Path, manifest: &BackupManifest) -> Result<(), String> {
    let file = File::open(path).map_err(|error| {
        format!(
            "Failed to reopen {} for verification: {error}",
            path.display()
        )
    })?;
    let mut archive = ZipArchive::new(file).map_err(|error| {
        format!(
            "Failed to reopen zip {} for verification: {error}",
            path.display()
        )
    })?;

    for entry in &manifest.files {
        let mut zipped = archive.by_name(&entry.archive_path).map_err(|error| {
            format!(
                "Backup verification failed: missing {} in {}: {error}",
                entry.archive_path,
                path.display()
            )
        })?;
        let mut bytes = Vec::new();
        zipped.read_to_end(&mut bytes).map_err(|error| {
            format!(
                "Backup verification failed while reading {} from {}: {error}",
                entry.archive_path,
                path.display()
            )
        })?;

        let actual = sha256_hex(&bytes);
        if actual != entry.sha256 {
            return Err(format!(
                "Backup verification failed for {} in {}: checksum mismatch.",
                entry.archive_path,
                path.display()
            ));
        }
    }

    Ok(())
}

fn verify_folder_backup_artifact(path: &Path, manifest: &BackupManifest) -> Result<(), String> {
    for entry in &manifest.files {
        let bytes = read_artifact_entry(path, &entry.archive_path)?;

        let actual = sha256_hex(&bytes);
        if actual != entry.sha256 {
            return Err(format!(
                "Backup verification failed for {} in {}: checksum mismatch.",
                entry.archive_path,
                path.display()
            ));
        }
    }

    Ok(())
}

fn directory_size(path: &Path) -> Result<u64, String> {
    let mut total = 0_u64;
    for entry in walkdir::WalkDir::new(path) {
        let entry =
            entry.map_err(|error| format!("Failed to inspect {}: {error}", path.display()))?;
        if entry.file_type().is_file() {
            total += entry
                .metadata()
                .map_err(|error| format!("Failed to read {}: {error}", entry.path().display()))?
                .len();
        }
    }

    Ok(total)
}

fn backup_id_from_path(path: &Path, format: &str) -> String {
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("backup");
    match format {
        "folder" => file_name
            .strip_suffix(BACKUP_FOLDER_EXTENSION)
            .unwrap_or(file_name)
            .to_string(),
        _ => file_name
            .strip_suffix(BACKUP_EXTENSION)
            .unwrap_or(file_name)
            .to_string(),
    }
}

fn backup_format_label(format: &BackupArtifactFormat) -> &'static str {
    match format {
        BackupArtifactFormat::Zip => "zip",
        BackupArtifactFormat::Folder => "folder",
    }
}

fn sanitize_file_component(value: &str) -> String {
    let sanitized = value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '_') {
                character
            } else {
                '_'
            }
        })
        .collect::<String>();
    let trimmed = sanitized.trim_matches('.').trim_matches('_');

    if trimmed.is_empty() {
        "restored-thread.jsonl".to_string()
    } else {
        trimmed.to_string()
    }
}

fn slugify(value: &str) -> String {
    let mut slug = String::new();
    let mut last_dash = false;

    for character in value.chars() {
        if character.is_ascii_alphanumeric() {
            slug.push(character.to_ascii_lowercase());
            last_dash = false;
        } else if !last_dash {
            slug.push('-');
            last_dash = true;
        }
    }

    let trimmed = slug.trim_matches('-');
    if trimmed.is_empty() {
        "thread-backup".to_string()
    } else {
        trimmed.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_path(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!("threaddock-{label}-{}", Uuid::new_v4()))
    }

    #[test]
    fn slugify_normalizes_labels() {
        assert_eq!(
            slugify("Assess Android Codex port family"),
            "assess-android-codex-port-family"
        );
        assert_eq!(slugify("   "), "thread-backup");
    }

    #[test]
    fn next_available_path_adds_numeric_suffix() {
        let root = temp_path("next-available");
        fs::create_dir_all(&root).expect("create temp directory");
        let first = root.join(format!("example{BACKUP_EXTENSION}"));
        fs::write(&first, b"existing").expect("write existing artifact");

        let next = next_available_path(&root, "example", &BackupArtifactFormat::Zip);
        assert!(next.ends_with(format!("example-2{BACKUP_EXTENSION}")));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn verify_backup_artifact_accepts_matching_checksum() {
        let root = temp_path("verify");
        fs::create_dir_all(&root).expect("create temp directory");
        let archive_path = root.join(format!("artifact{BACKUP_EXTENSION}"));
        let payload = b"hello threaddock";
        let manifest = BackupManifest {
            backup_format_version: BACKUP_FORMAT_VERSION,
            created_at: "2026-05-26T19:00:00Z".to_string(),
            threaddock_version: "0.1.0".to_string(),
            label: "test".to_string(),
            mode: BackupExportMode::Threads,
            source_codex_home: "C:/codex".to_string(),
            exported_thread_ids: vec!["thread-1".to_string()],
            exported_family_roots: Vec::new(),
            total_rollout_bytes: payload.len() as u64,
            files: vec![ManifestFileEntry {
                thread_id: "thread-1".to_string(),
                archive_path: "threads/thread-1.jsonl".to_string(),
                rollout_bytes: payload.len() as u64,
                sha256: sha256_hex(payload),
            }],
        };

        let file = File::create(&archive_path).expect("create archive");
        let mut zip = ZipWriter::new(file);
        let options = FileOptions::default().compression_method(CompressionMethod::Deflated);
        zip.start_file("threads/thread-1.jsonl", options)
            .expect("start rollout entry");
        zip.write_all(payload).expect("write rollout entry");
        zip.finish().expect("finish zip");

        verify_zip_backup_artifact(&archive_path, &manifest).expect("verify archive");

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn validate_backup_manifest_rejects_unsafe_archive_path() {
        let manifest = BackupManifest {
            backup_format_version: BACKUP_FORMAT_VERSION,
            created_at: "2026-05-26T19:00:00Z".to_string(),
            threaddock_version: "0.1.0".to_string(),
            label: "test".to_string(),
            mode: BackupExportMode::Threads,
            source_codex_home: "C:/codex".to_string(),
            exported_thread_ids: vec!["thread-1".to_string()],
            exported_family_roots: Vec::new(),
            total_rollout_bytes: 5,
            files: vec![ManifestFileEntry {
                thread_id: "thread-1".to_string(),
                archive_path: "threads/../thread-1.jsonl".to_string(),
                rollout_bytes: 5,
                sha256: sha256_hex(b"hello"),
            }],
        };

        let error = validate_backup_manifest(&manifest).expect_err("reject traversal path");
        assert!(error.contains("invalid") || error.contains("unsafe"));
    }

    #[test]
    fn verified_import_rejects_checksum_mismatch() {
        let root = temp_path("verified-import");
        fs::create_dir_all(&root).expect("create temp directory");
        let archive_path = root.join(format!("artifact{BACKUP_EXTENSION}"));
        let manifest = BackupManifest {
            backup_format_version: BACKUP_FORMAT_VERSION,
            created_at: "2026-05-26T19:00:00Z".to_string(),
            threaddock_version: "0.1.0".to_string(),
            label: "test".to_string(),
            mode: BackupExportMode::Threads,
            source_codex_home: "C:/codex".to_string(),
            exported_thread_ids: vec!["thread-1".to_string()],
            exported_family_roots: Vec::new(),
            total_rollout_bytes: 7,
            files: vec![ManifestFileEntry {
                thread_id: "thread-1".to_string(),
                archive_path: "threads/thread-1.jsonl".to_string(),
                rollout_bytes: 7,
                sha256: sha256_hex(b"expected"),
            }],
        };
        let thread = ThreadRecord {
            thread_id: "thread-1".to_string(),
            title: "Fixture".to_string(),
            status: codex::ThreadStatus::Archived,
            thread_source: codex::ThreadSource::User,
            read_only: false,
            parent_thread_id: None,
            cwd: None,
            rollout_path: "thread-1.jsonl".to_string(),
            created_at: None,
            updated_at: None,
            raw_rollout_bytes: 7,
        };

        let file = File::create(&archive_path).expect("create archive");
        let mut zip = ZipWriter::new(file);
        let options = FileOptions::default().compression_method(CompressionMethod::Deflated);
        zip.start_file("threads/thread-1.jsonl", options)
            .expect("start rollout entry");
        zip.write_all(b"tamper!").expect("write rollout entry");
        write_json_entry(&mut zip, "manifest.json", &manifest, options).expect("write manifest");
        write_json_entry(&mut zip, "metadata/threads.json", &vec![thread], options)
            .expect("write metadata");
        zip.finish().expect("finish zip");

        let error = read_verified_import_metadata_from_artifact(&archive_path)
            .expect_err("reject mismatch");
        assert!(error.contains("checksum"));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn inspect_backup_artifact_rejects_missing_payload() {
        let root = temp_path("missing-payload");
        fs::create_dir_all(&root).expect("create temp directory");
        let archive_path = root.join(format!("artifact{BACKUP_EXTENSION}"));
        let manifest = BackupManifest {
            backup_format_version: BACKUP_FORMAT_VERSION,
            created_at: "2026-05-26T19:00:00Z".to_string(),
            threaddock_version: "0.1.0".to_string(),
            label: "test".to_string(),
            mode: BackupExportMode::Threads,
            source_codex_home: "redacted".to_string(),
            exported_thread_ids: vec!["thread-1".to_string()],
            exported_family_roots: Vec::new(),
            total_rollout_bytes: 5,
            files: vec![ManifestFileEntry {
                thread_id: "thread-1".to_string(),
                archive_path: "threads/thread-1.jsonl".to_string(),
                rollout_bytes: 5,
                sha256: sha256_hex(b"hello"),
            }],
        };

        let file = File::create(&archive_path).expect("create archive");
        let mut zip = ZipWriter::new(file);
        let options = FileOptions::default().compression_method(CompressionMethod::Deflated);
        write_json_entry(&mut zip, "manifest.json", &manifest, options).expect("write manifest");
        zip.finish().expect("finish zip");

        let error = inspect_backup_artifact(&archive_path).expect_err("reject broken backup");
        assert!(error.contains("missing"));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn redacted_thread_metadata_removes_local_paths() {
        let thread = ThreadRecord {
            thread_id: "thread-1".to_string(),
            title: "Fixture".to_string(),
            status: codex::ThreadStatus::Archived,
            thread_source: codex::ThreadSource::User,
            read_only: false,
            parent_thread_id: None,
            cwd: Some("C:/Users/Alice/workspace".to_string()),
            rollout_path: "C:/Users/Alice/.codex/sessions/thread-1.jsonl".to_string(),
            created_at: None,
            updated_at: None,
            raw_rollout_bytes: 5,
        };

        let redacted = redacted_thread_metadata(&thread, "threads/thread-1.jsonl");
        assert_eq!(redacted.cwd, None);
        assert_eq!(redacted.rollout_path, "threads/thread-1.jsonl");
    }
}
