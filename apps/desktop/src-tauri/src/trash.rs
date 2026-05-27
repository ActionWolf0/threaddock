use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
};

use chrono::{Duration, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::codex::{self, ThreadRecord, ThreadStatus};

const APP_DIR_NAME: &str = "ThreadDock";
const TRASH_DIR_NAME: &str = "trash";
const METADATA_FILE_NAME: &str = "metadata.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashRecord {
    pub cwd: Option<String>,
    pub deleted_at: String,
    pub expires_at: String,
    pub original_path: String,
    pub original_status: TrashThreadStatus,
    pub parent_thread_id: Option<String>,
    pub raw_rollout_bytes: u64,
    pub thread_id: String,
    pub thread_source: String,
    pub title: String,
    pub trash_id: String,
    pub trashed_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TrashThreadStatus {
    Active,
    Archived,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TrashMetadata {
    cwd: Option<String>,
    deleted_at: String,
    expires_at: String,
    original_file_name: String,
    original_path: String,
    original_status: TrashThreadStatus,
    parent_thread_id: Option<String>,
    raw_rollout_bytes: u64,
    thread_id: String,
    thread_source: String,
    title: String,
    trash_id: String,
}

pub fn load_trash_inventory() -> Result<Vec<TrashRecord>, String> {
    let root = trash_root()?;
    if !root.exists() {
        return Ok(Vec::new());
    }

    let mut records = Vec::new();
    for entry in fs::read_dir(&root).map_err(|error| {
        format!(
            "Failed to read ThreadDock trash {}: {error}",
            root.display()
        )
    })? {
        let Ok(entry) = entry else {
            continue;
        };
        if !entry.path().is_dir() {
            continue;
        }

        match read_trash_record(&entry.path()) {
            Ok(Some(record)) => records.push(record),
            Ok(None) => {}
            Err(error) => {
                log::warn!(
                    "Failed to inspect trash entry {}: {error}",
                    entry.path().display()
                );
                records.push(corrupt_trash_record(&entry.path(), &error));
            }
        }
    }

    records.sort_by(|left, right| {
        right
            .deleted_at
            .cmp(&left.deleted_at)
            .then_with(|| left.title.cmp(&right.title))
    });
    Ok(records)
}

pub fn trashed_thread_ids() -> Result<HashSet<String>, String> {
    let mut ids = HashSet::new();
    for record in load_trash_inventory()? {
        if !record.thread_id.starts_with("corrupt-trash-") {
            ids.insert(record.thread_id);
        }
    }
    Ok(ids)
}

pub fn trash_threads(thread_ids: &[String]) -> Result<Vec<TrashRecord>, String> {
    let mut trashed = Vec::new();

    for thread_id in thread_ids {
        let snapshot = codex::load_thread_library()?;
        let thread = snapshot
            .threads
            .iter()
            .find(|thread| thread.thread_id == *thread_id)
            .cloned()
            .ok_or_else(|| format!("Thread {thread_id} is no longer available."))?;

        if thread.read_only {
            return Err(format!(
        "Thread {thread_id} comes from a read-only archive path and cannot be moved to trash."
      ));
        }

        if matches!(thread.status, ThreadStatus::Active) {
            codex::archive_thread(thread_id)?;
        }

        let archived_snapshot = codex::load_thread_library()?;
        let archived_thread = archived_snapshot
            .threads
            .iter()
            .find(|candidate| candidate.thread_id == *thread_id)
            .cloned()
            .ok_or_else(|| format!("Thread {thread_id} could not be located after archiving."))?;

        let record = move_thread_to_trash(&archived_thread)?;
        trashed.push(record);
    }

    Ok(trashed)
}

pub fn restore_trash_items(trash_ids: &[String]) -> Result<Vec<TrashRecord>, String> {
    let snapshot = codex::load_thread_library()?;
    let existing_thread_ids = snapshot
        .threads
        .iter()
        .map(|thread| thread.thread_id.clone())
        .collect::<HashSet<_>>();
    let codex_root = PathBuf::from(snapshot.codex_home);
    let canonical_codex_root = codex_root.canonicalize().map_err(|error| {
        format!(
            "Failed to canonicalize Codex home {} before trash restore: {error}",
            codex_root.display()
        )
    })?;
    let archived_root = codex_root.join("archived_sessions");
    fs::create_dir_all(&archived_root).map_err(|error| {
        format!(
            "Failed to create archived session root {}: {error}",
            archived_root.display()
        )
    })?;
    ensure_restore_root_is_safe(&canonical_codex_root, &archived_root)?;

    let mut restored = Vec::new();
    let mut restoring_thread_ids = HashSet::new();
    for trash_id in trash_ids {
        let entry_root = trash_entry_root(trash_id)?;
        let metadata = read_trash_metadata(&entry_root)?;
        if existing_thread_ids.contains(&metadata.thread_id) {
            return Err(format!(
                "Thread {} already exists in Codex. Purge one copy or choose a backup import mode before restoring this trash item.",
                metadata.thread_id
            ));
        }
        if !restoring_thread_ids.insert(metadata.thread_id.clone()) {
            return Err(format!(
                "Multiple selected trash items contain thread {}. Restore one copy at a time.",
                metadata.thread_id
            ));
        }
        let payload_path = find_payload_path(&entry_root)?;
        let target_path = next_restore_path(&archived_root, &metadata.original_file_name);
        ensure_restore_target_is_safe(&canonical_codex_root, &target_path)?;
        move_path(&payload_path, &target_path)?;
        fs::remove_file(entry_root.join(METADATA_FILE_NAME)).ok();
        fs::remove_dir_all(&entry_root).ok();

        restored.push(TrashRecord {
            cwd: metadata.cwd,
            deleted_at: metadata.deleted_at,
            expires_at: metadata.expires_at,
            original_path: target_path.display().to_string(),
            original_status: metadata.original_status,
            parent_thread_id: metadata.parent_thread_id,
            raw_rollout_bytes: metadata.raw_rollout_bytes,
            thread_id: metadata.thread_id,
            thread_source: metadata.thread_source,
            title: metadata.title,
            trash_id: metadata.trash_id,
            trashed_path: payload_path.display().to_string(),
        });
    }

    Ok(restored)
}

pub fn purge_trash_items(trash_ids: &[String]) -> Result<Vec<TrashRecord>, String> {
    let mut purged = Vec::new();

    for trash_id in trash_ids {
        let entry_root = trash_entry_root(trash_id)?;
        let record = match read_trash_record(&entry_root) {
            Ok(Some(record)) => record,
            Ok(None) => return Err(format!("Trash item {trash_id} is no longer available.")),
            Err(error) => corrupt_trash_record(&entry_root, &error),
        };
        fs::remove_dir_all(&entry_root)
            .map_err(|error| format!("Failed to purge {}: {error}", entry_root.display()))?;
        purged.push(record);
    }

    Ok(purged)
}

fn trash_entry_root(trash_id: &str) -> Result<PathBuf, String> {
    let normalized_id = Uuid::parse_str(trash_id)
        .map(|uuid| uuid.to_string())
        .map_err(|_| format!("Trash item id {trash_id} is invalid."))?;
    let root = trash_root()?;
    let entry_root = root.join(normalized_id);
    if !entry_root.starts_with(&root) {
        return Err("Trash item path escapes the ThreadDock trash root.".to_string());
    }
    Ok(entry_root)
}

fn move_thread_to_trash(thread: &ThreadRecord) -> Result<TrashRecord, String> {
    let source_path = PathBuf::from(&thread.rollout_path);
    if !source_path.exists() {
        return Err(format!(
            "Thread {} no longer has a readable rollout file on disk.",
            thread.thread_id
        ));
    }

    let trash_id = Uuid::new_v4().to_string();
    let entry_root = trash_root()?.join(&trash_id);
    fs::create_dir_all(&entry_root).map_err(|error| {
        format!(
            "Failed to create trash entry {}: {error}",
            entry_root.display()
        )
    })?;

    let original_file_name = source_path
        .file_name()
        .and_then(|value| value.to_str())
        .map(sanitize_file_component)
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "rollout.jsonl".to_string());
    let payload_path = entry_root.join(&original_file_name);

    let deleted_at = Utc::now();
    let metadata = TrashMetadata {
        cwd: thread.cwd.clone(),
        deleted_at: deleted_at.to_rfc3339(),
        expires_at: (deleted_at + Duration::days(30)).to_rfc3339(),
        original_file_name,
        original_path: thread.rollout_path.clone(),
        original_status: match thread.status {
            ThreadStatus::Active => TrashThreadStatus::Active,
            ThreadStatus::Archived => TrashThreadStatus::Archived,
        },
        parent_thread_id: thread.parent_thread_id.clone(),
        raw_rollout_bytes: thread.raw_rollout_bytes,
        thread_id: thread.thread_id.clone(),
        thread_source: match thread.thread_source {
            crate::codex::ThreadSource::User => "user".to_string(),
            crate::codex::ThreadSource::Subagent => "subagent".to_string(),
            crate::codex::ThreadSource::Unknown => "unknown".to_string(),
        },
        title: thread.title.clone(),
        trash_id: trash_id.clone(),
    };
    fs::write(
        entry_root.join(METADATA_FILE_NAME),
        serde_json::to_vec_pretty(&metadata)
            .map_err(|error| format!("Failed to serialize trash metadata: {error}"))?,
    )
    .map_err(|error| format!("Failed to write trash metadata: {error}"))?;

    if let Err(error) = move_path(&source_path, &payload_path) {
        fs::remove_file(entry_root.join(METADATA_FILE_NAME)).ok();
        fs::remove_dir_all(&entry_root).ok();
        return Err(error);
    }

    Ok(TrashRecord {
        cwd: metadata.cwd,
        deleted_at: metadata.deleted_at,
        expires_at: metadata.expires_at,
        original_path: metadata.original_path,
        original_status: metadata.original_status,
        parent_thread_id: metadata.parent_thread_id,
        raw_rollout_bytes: metadata.raw_rollout_bytes,
        thread_id: metadata.thread_id,
        thread_source: metadata.thread_source,
        title: metadata.title,
        trash_id: metadata.trash_id,
        trashed_path: payload_path.display().to_string(),
    })
}

fn read_trash_record(entry_root: &Path) -> Result<Option<TrashRecord>, String> {
    if !entry_root.exists() {
        return Ok(None);
    }

    let metadata = read_trash_metadata(entry_root)?;
    let payload_path = find_payload_path(entry_root)?;
    Ok(Some(TrashRecord {
        cwd: metadata.cwd,
        deleted_at: metadata.deleted_at,
        expires_at: metadata.expires_at,
        original_path: metadata.original_path,
        original_status: metadata.original_status,
        parent_thread_id: metadata.parent_thread_id,
        raw_rollout_bytes: metadata.raw_rollout_bytes,
        thread_id: metadata.thread_id,
        thread_source: metadata.thread_source,
        title: metadata.title,
        trash_id: metadata.trash_id,
        trashed_path: payload_path.display().to_string(),
    }))
}

fn read_trash_metadata(entry_root: &Path) -> Result<TrashMetadata, String> {
    let payload = fs::read_to_string(entry_root.join(METADATA_FILE_NAME)).map_err(|error| {
        format!(
            "Failed to read trash metadata {}: {error}",
            entry_root.join(METADATA_FILE_NAME).display()
        )
    })?;
    serde_json::from_str::<TrashMetadata>(&payload).map_err(|error| {
        format!(
            "Failed to parse trash metadata {}: {error}",
            entry_root.display()
        )
    })
}

fn find_payload_path(entry_root: &Path) -> Result<PathBuf, String> {
    for entry in fs::read_dir(entry_root).map_err(|error| {
        format!(
            "Failed to read trash entry {}: {error}",
            entry_root.display()
        )
    })? {
        let Ok(entry) = entry else {
            continue;
        };
        let path = entry.path();
        if path.is_file()
            && path.file_name().and_then(|value| value.to_str()) != Some(METADATA_FILE_NAME)
        {
            return Ok(path);
        }
    }

    Err(format!(
        "Trash entry {} is missing the rollout payload.",
        entry_root.display()
    ))
}

fn next_restore_path(root: &Path, original_file_name: &str) -> PathBuf {
    let safe_file_name = sanitize_file_component(original_file_name);
    let original = root.join(&safe_file_name);
    if !path_entry_exists(&original) {
        return original;
    }

    let stem = original
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("restored-thread");
    let extension = original
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("jsonl");

    let mut index = 2_usize;
    loop {
        let candidate = root.join(format!("{stem}-{index}.{extension}"));
        if !path_entry_exists(&candidate) {
            return candidate;
        }
        index += 1;
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
        "rollout.jsonl".to_string()
    } else {
        trimmed.to_string()
    }
}

fn move_path(source: &Path, target: &Path) -> Result<(), String> {
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Failed to create {}: {error}", parent.display()))?;
    }

    match fs::rename(source, target) {
        Ok(()) => Ok(()),
        Err(_) => {
            fs::copy(source, target).map_err(|error| {
                format!(
                    "Failed to move {} to {}: {error}",
                    source.display(),
                    target.display()
                )
            })?;
            fs::remove_file(source)
                .map_err(|error| format!("Failed to remove {}: {error}", source.display()))
        }
    }
}

fn ensure_restore_root_is_safe(
    canonical_codex_root: &Path,
    archived_root: &Path,
) -> Result<(), String> {
    let canonical_archive = archived_root.canonicalize().map_err(|error| {
        format!(
            "Failed to canonicalize archived session root {}: {error}",
            archived_root.display()
        )
    })?;
    if !canonical_archive.starts_with(canonical_codex_root) {
        return Err(format!(
            "Archived session root {} resolves outside Codex home {}.",
            canonical_archive.display(),
            canonical_codex_root.display()
        ));
    }
    Ok(())
}

fn ensure_restore_target_is_safe(canonical_codex_root: &Path, target: &Path) -> Result<(), String> {
    let parent = target.parent().ok_or_else(|| {
        format!(
            "Unable to resolve restore target parent for {}.",
            target.display()
        )
    })?;
    let canonical_parent = parent.canonicalize().map_err(|error| {
        format!(
            "Failed to canonicalize restore target parent {}: {error}",
            parent.display()
        )
    })?;
    if !canonical_parent.starts_with(canonical_codex_root) {
        return Err(format!(
            "Restore target parent {} resolves outside Codex home {}.",
            canonical_parent.display(),
            canonical_codex_root.display()
        ));
    }
    Ok(())
}

fn path_entry_exists(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok()
}

fn corrupt_trash_record(entry_root: &Path, error: &str) -> TrashRecord {
    let trash_id = entry_root
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("unknown")
        .to_string();
    let now = Utc::now().to_rfc3339();
    TrashRecord {
        cwd: None,
        deleted_at: now.clone(),
        expires_at: now,
        original_path: entry_root.display().to_string(),
        original_status: TrashThreadStatus::Archived,
        parent_thread_id: None,
        raw_rollout_bytes: directory_size(entry_root).unwrap_or(0),
        thread_id: format!("corrupt-trash-{trash_id}"),
        thread_source: "unknown".to_string(),
        title: format!("Corrupt trash item: {error}"),
        trash_id,
        trashed_path: entry_root.display().to_string(),
    }
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

fn trash_root() -> Result<PathBuf, String> {
    let root = dirs::data_local_dir()
        .or_else(dirs::data_dir)
        .ok_or_else(|| {
            "Unable to resolve a local app-data directory for ThreadDock trash.".to_string()
        })?;
    let path = root.join(APP_DIR_NAME).join(TRASH_DIR_NAME);
    fs::create_dir_all(&path).map_err(|error| {
        format!(
            "Failed to create ThreadDock trash {}: {error}",
            path.display()
        )
    })?;
    Ok(path)
}
