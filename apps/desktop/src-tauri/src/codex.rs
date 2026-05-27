use std::{
    collections::{HashMap, HashSet},
    fs::{self, File},
    io::{BufRead, BufReader},
    path::{Path, PathBuf},
};

use chrono::{DateTime, TimeZone, Utc};
use serde::{Deserialize, Serialize};
use walkdir::WalkDir;

use crate::{
    app_server::{self, AppServerThread},
    cache,
};

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadRecord {
    pub thread_id: String,
    pub title: String,
    pub status: ThreadStatus,
    pub thread_source: ThreadSource,
    pub read_only: bool,
    pub parent_thread_id: Option<String>,
    pub cwd: Option<String>,
    pub rollout_path: String,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
    pub raw_rollout_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryStats {
    pub active_count: usize,
    pub archived_count: usize,
    pub total_bytes: u64,
    pub active_bytes: u64,
    pub archived_bytes: u64,
    pub subagent_count: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadLibrarySnapshot {
    pub app_server: AppServerStatus,
    pub activity_log: Vec<cache::ActivityRecord>,
    pub cleanup_rules: Vec<cache::CleanupRuleRecord>,
    pub codex_home: String,
    pub preferences: cache::AppPreferences,
    pub scanned_at: String,
    pub scan_issues: Vec<ScanIssue>,
    pub saved_views: Vec<cache::SavedViewRecord>,
    pub stats: LibraryStats,
    pub threads: Vec<ThreadRecord>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppServerStatus {
    pub available: bool,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ThreadStatus {
    Active,
    Archived,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ThreadSource {
    User,
    Subagent,
    Unknown,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanIssue {
    pub kind: ScanIssueKind,
    pub severity: IssueSeverity,
    pub message: String,
    pub path: Option<String>,
    pub thread_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ScanIssueKind {
    DuplicateThreadId,
    MetadataUnreadable,
    MalformedRollout,
    MissingRollout,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum IssueSeverity {
    Warning,
}

#[derive(Debug, serde::Deserialize)]
struct IndexRecord {
    id: String,
    #[serde(default)]
    thread_name: Option<String>,
    #[serde(default)]
    updated_at: Option<String>,
}

#[derive(Debug, serde::Deserialize)]
struct SessionLine {
    #[serde(rename = "type")]
    line_type: String,
    payload: SessionPayload,
}

#[derive(Debug, serde::Deserialize)]
struct SessionPayload {
    id: String,
    #[serde(default)]
    timestamp: Option<String>,
    #[serde(default)]
    cwd: Option<String>,
    #[serde(default)]
    thread_source: Option<String>,
    #[serde(default)]
    source: Option<SessionSource>,
}

#[derive(Debug, serde::Deserialize)]
struct SessionSource {
    #[serde(default)]
    subagent: Option<SubagentSource>,
}

#[derive(Debug, serde::Deserialize)]
struct SubagentSource {
    #[serde(default)]
    thread_spawn: Option<ThreadSpawn>,
}

#[derive(Debug, serde::Deserialize)]
struct ThreadSpawn {
    #[serde(default)]
    parent_thread_id: Option<String>,
}

struct AppThreadEntry {
    status: ThreadStatus,
    thread: AppServerThread,
}

struct ScanResult {
    threads: Vec<ThreadRecord>,
    issues: Vec<ScanIssue>,
}

struct AppServerLoad {
    entries: Vec<AppThreadEntry>,
    status: AppServerStatus,
}

pub fn load_thread_library() -> Result<ThreadLibrarySnapshot, String> {
    let preferences = match cache::load_app_preferences() {
        Ok(preferences) => preferences,
        Err(error) => {
            log::warn!("Failed to load ThreadDock preferences from cache: {error}");
            cache::AppPreferences::default()
        }
    };
    let codex_home = detect_codex_home(&preferences)?;
    let index = load_session_index(&codex_home);
    let mut threads = Vec::new();
    let mut scan_issues = Vec::new();
    let scanned_at = Utc::now().to_rfc3339();

    let active_root = codex_home.join("sessions");
    let archived_root = codex_home.join("archived_sessions");

    if active_root.exists() {
        let scan_result = scan_rollouts(&active_root, ThreadStatus::Active, &index, false)?;
        threads.extend(scan_result.threads);
        scan_issues.extend(scan_result.issues);
    }

    if archived_root.exists() {
        let scan_result = scan_rollouts(&archived_root, ThreadStatus::Archived, &index, false)?;
        threads.extend(scan_result.threads);
        scan_issues.extend(scan_result.issues);
    }

    if let Some(alternate_archive_path) = preferences.alternate_archive_path.as_deref() {
        let alternate_root = PathBuf::from(alternate_archive_path);
        if alternate_root.exists() {
            let scan_result = scan_rollouts(&alternate_root, ThreadStatus::Archived, &index, true)?;
            threads.extend(scan_result.threads);
            scan_issues.extend(scan_result.issues);
        } else {
            scan_issues.push(ScanIssue {
                kind: ScanIssueKind::MissingRollout,
                severity: IssueSeverity::Warning,
                message: format!(
                    "Configured alternate archive path is not readable: {}",
                    alternate_root.display()
                ),
                path: Some(alternate_root.display().to_string()),
                thread_id: None,
            });
        }
    }

    let app_server_load = load_app_server_threads();
    threads = deduplicate_threads(threads, &mut scan_issues);
    threads = merge_app_server_threads(threads, app_server_load.entries, &mut scan_issues);
    sort_threads(&mut threads);

    let mut active_count = 0usize;
    let mut archived_count = 0usize;
    let mut active_bytes = 0u64;
    let mut archived_bytes = 0u64;
    let mut subagent_count = 0usize;

    for thread in &threads {
        match thread.status {
            ThreadStatus::Active => {
                active_count += 1;
                active_bytes += thread.raw_rollout_bytes;
            }
            ThreadStatus::Archived => {
                archived_count += 1;
                archived_bytes += thread.raw_rollout_bytes;
            }
        }

        if matches!(thread.thread_source, ThreadSource::Subagent) {
            subagent_count += 1;
        }
    }

    if let Err(error) = cache::sync_scan_snapshot(&threads, &scan_issues, &scanned_at) {
        log::warn!("Failed to synchronize the ThreadDock scan cache: {error}");
    }

    let activity_log = match cache::load_recent_activity(16) {
        Ok(records) => records,
        Err(error) => {
            log::warn!("Failed to load the ThreadDock activity log: {error}");
            Vec::new()
        }
    };
    let saved_views = match cache::load_saved_views() {
        Ok(records) => records,
        Err(error) => {
            log::warn!("Failed to load ThreadDock saved views: {error}");
            Vec::new()
        }
    };
    let cleanup_rules = match cache::load_cleanup_rules() {
        Ok(records) => records,
        Err(error) => {
            log::warn!("Failed to load ThreadDock cleanup rules: {error}");
            Vec::new()
        }
    };

    Ok(ThreadLibrarySnapshot {
        app_server: app_server_load.status,
        activity_log,
        cleanup_rules,
        codex_home: codex_home.display().to_string(),
        preferences,
        scanned_at,
        scan_issues,
        saved_views,
        stats: LibraryStats {
            active_count,
            archived_count,
            total_bytes: active_bytes + archived_bytes,
            active_bytes,
            archived_bytes,
            subagent_count,
        },
        threads,
    })
}

pub fn archive_thread(thread_id: &str) -> Result<(), String> {
    ensure_thread_mutable(thread_id)?;
    app_server::archive_thread(thread_id)
}

pub fn unarchive_thread(thread_id: &str) -> Result<(), String> {
    ensure_thread_mutable(thread_id)?;
    app_server::unarchive_thread(thread_id)
}

pub fn archive_threads(thread_ids: &[String]) -> Result<(), String> {
    for thread_id in thread_ids {
        archive_thread(thread_id)?;
    }

    Ok(())
}

pub fn unarchive_threads(thread_ids: &[String]) -> Result<(), String> {
    for thread_id in thread_ids {
        unarchive_thread(thread_id)?;
    }

    Ok(())
}

fn detect_codex_home(preferences: &cache::AppPreferences) -> Result<PathBuf, String> {
    if let Some(override_path) = preferences.codex_home_override.as_deref() {
        let candidate = PathBuf::from(override_path);
        if candidate.exists() {
            return Ok(candidate);
        }
    }

    if let Some(path) = std::env::var_os("CODEX_HOME") {
        let candidate = PathBuf::from(path);
        if candidate.exists() {
            return Ok(candidate);
        }
    }

    let home = dirs::home_dir()
        .ok_or_else(|| "Unable to resolve the current home directory.".to_string())?;
    let candidate = home.join(".codex");

    if candidate.exists() {
        Ok(candidate)
    } else {
        Err(format!(
            "No Codex home found. Looked for {}.",
            candidate.display()
        ))
    }
}

fn load_session_index(codex_home: &Path) -> HashMap<String, IndexRecord> {
    let mut index = HashMap::new();
    let index_path = codex_home.join("session_index.jsonl");

    let Ok(file) = File::open(index_path) else {
        return index;
    };

    for line in BufReader::new(file).lines().map_while(Result::ok) {
        if line.trim().is_empty() {
            continue;
        }

        if let Ok(record) = serde_json::from_str::<IndexRecord>(&line) {
            index.insert(record.id.clone(), record);
        }
    }

    index
}

fn scan_rollouts(
    root: &Path,
    status: ThreadStatus,
    index: &HashMap<String, IndexRecord>,
    read_only: bool,
) -> Result<ScanResult, String> {
    let mut results = Vec::new();
    let mut issues = Vec::new();

    for entry in WalkDir::new(root) {
        let entry = match entry {
            Ok(entry) => entry,
            Err(error) => {
                issues.push(ScanIssue {
                    kind: ScanIssueKind::MetadataUnreadable,
                    severity: IssueSeverity::Warning,
                    message: format!("Could not traverse {}: {error}", root.display()),
                    path: error.path().map(|path| path.display().to_string()),
                    thread_id: None,
                });
                log::warn!(
                    "Skipping unreadable rollout path under {}: {error}",
                    root.display()
                );
                continue;
            }
        };
        if !entry.file_type().is_file() {
            continue;
        }

        let path = entry.into_path();
        if path.extension().and_then(|value| value.to_str()) != Some("jsonl") {
            continue;
        }

        let metadata = match fs::metadata(&path) {
            Ok(metadata) => metadata,
            Err(error) => {
                issues.push(ScanIssue {
                    kind: ScanIssueKind::MetadataUnreadable,
                    severity: IssueSeverity::Warning,
                    message: format!("Could not read metadata for {}: {error}", path.display()),
                    path: Some(path.display().to_string()),
                    thread_id: None,
                });
                log::warn!(
                    "Skipping {} because metadata could not be read: {error}",
                    path.display()
                );
                continue;
            }
        };

        let session = match read_session_meta(&path) {
            Ok(session) => session,
            Err(error) => {
                issues.push(ScanIssue {
                    kind: ScanIssueKind::MalformedRollout,
                    severity: IssueSeverity::Warning,
                    message: error.clone(),
                    path: Some(path.display().to_string()),
                    thread_id: None,
                });
                log::warn!("{error}");
                continue;
            }
        };

        let fallback_name = path
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or("Untitled thread")
            .to_string();
        let index_record = index.get(&session.id);

        results.push(ThreadRecord {
            thread_id: session.id.clone(),
            title: pick_title(
                index_record.and_then(|record| record.thread_name.clone()),
                Some(fallback_name),
                None,
            ),
            status: status.clone(),
            thread_source: normalize_thread_source(session.thread_source.as_deref()),
            read_only,
            parent_thread_id: session
                .source
                .and_then(|source| source.subagent)
                .and_then(|subagent| subagent.thread_spawn)
                .and_then(|spawn| spawn.parent_thread_id),
            cwd: session.cwd,
            rollout_path: path.display().to_string(),
            created_at: session.timestamp,
            updated_at: index_record
                .and_then(|record| record.updated_at.clone())
                .or_else(|| modified_time_to_rfc3339(&path)),
            raw_rollout_bytes: metadata.len(),
        });
    }

    Ok(ScanResult {
        threads: results,
        issues,
    })
}

fn read_session_meta(path: &Path) -> Result<SessionPayload, String> {
    let file =
        File::open(path).map_err(|error| format!("Failed to open {}: {error}", path.display()))?;
    let mut lines = BufReader::new(file).lines();

    let first_line = lines
        .next()
        .transpose()
        .map_err(|error| format!("Failed to read {}: {error}", path.display()))?
        .ok_or_else(|| format!("Session file is empty: {}", path.display()))?;

    let session_line: SessionLine = serde_json::from_str(&first_line).map_err(|error| {
        format!(
            "Failed to parse session metadata for {}: {error}",
            path.display()
        )
    })?;

    if session_line.line_type != "session_meta" {
        return Err(format!(
            "First line in {} is not session metadata.",
            path.display()
        ));
    }

    Ok(session_line.payload)
}

fn load_app_server_threads() -> AppServerLoad {
    let mut entries = Vec::new();
    let mut failures = Vec::new();

    match app_server::list_threads(false) {
        Ok(active_threads) => {
            entries.extend(active_threads.into_iter().map(|thread| AppThreadEntry {
                status: ThreadStatus::Active,
                thread,
            }))
        }
        Err(error) => {
            failures.push(format!("Active threads: {error}"));
            log::warn!("Failed to list active threads from Codex App Server: {error}");
        }
    }

    match app_server::list_threads(true) {
        Ok(archived_threads) => {
            entries.extend(archived_threads.into_iter().map(|thread| AppThreadEntry {
                status: ThreadStatus::Archived,
                thread,
            }))
        }
        Err(error) => {
            failures.push(format!("Archived threads: {error}"));
            log::warn!("Failed to list archived threads from Codex App Server: {error}");
        }
    }

    AppServerLoad {
        entries,
        status: AppServerStatus {
            available: failures.is_empty(),
            message: if failures.is_empty() {
                None
            } else {
                Some(failures.join(" | "))
            },
        },
    }
}

fn ensure_thread_mutable(thread_id: &str) -> Result<(), String> {
    let snapshot = load_thread_library()?;
    let thread = snapshot
        .threads
        .iter()
        .find(|thread| thread.thread_id == thread_id)
        .ok_or_else(|| format!("Thread {thread_id} is no longer available."))?;

    if thread.read_only {
        return Err(format!(
      "Thread {thread_id} comes from a read-only archive path and cannot be changed through ThreadDock."
    ));
    }

    if !snapshot.app_server.available {
        return Err(snapshot.app_server.message.unwrap_or_else(|| {
            "Codex App Server is unavailable, so lifecycle actions are currently read-only."
                .to_string()
        }));
    }

    Ok(())
}

fn merge_app_server_threads(
    threads: Vec<ThreadRecord>,
    app_threads: Vec<AppThreadEntry>,
    scan_issues: &mut Vec<ScanIssue>,
) -> Vec<ThreadRecord> {
    let mut merged = threads
        .into_iter()
        .map(|thread| (thread.thread_id.clone(), thread))
        .collect::<HashMap<_, _>>();

    for entry in app_threads {
        let AppThreadEntry { status, thread } = entry;
        let existing = merged.remove(&thread.id);
        let thread_id = thread.id.clone();
        let app_path = non_empty_string(thread.path);
        let rollout_path = pick_non_empty_string(
            app_path.clone(),
            existing.as_ref().map(|record| record.rollout_path.clone()),
        )
        .unwrap_or_else(|| "Not materialized on disk".to_string());

        let raw_rollout_bytes = existing
            .as_ref()
            .map(|record| record.raw_rollout_bytes)
            .filter(|bytes| *bytes > 0)
            .or_else(|| app_path.as_deref().and_then(file_size))
            .unwrap_or(0);

        let merged_thread = ThreadRecord {
            thread_id: thread_id.clone(),
            title: pick_title(
                non_empty_string(thread.name),
                existing.as_ref().map(|record| record.title.clone()),
                Some(summarize_preview(&thread.preview)),
            ),
            status,
            thread_source: existing
                .as_ref()
                .map(|record| record.thread_source.clone())
                .filter(|source| !matches!(source, ThreadSource::Unknown))
                .unwrap_or_else(|| normalize_thread_source(thread.thread_source.as_deref())),
            read_only: false,
            parent_thread_id: existing
                .as_ref()
                .and_then(|record| record.parent_thread_id.clone()),
            cwd: pick_non_empty_string(
                non_empty_string(Some(thread.cwd)),
                existing.as_ref().and_then(|record| record.cwd.clone()),
            ),
            rollout_path,
            created_at: unix_seconds_to_rfc3339(thread.created_at).or_else(|| {
                existing
                    .as_ref()
                    .and_then(|record| record.created_at.clone())
            }),
            updated_at: unix_seconds_to_rfc3339(thread.updated_at).or_else(|| {
                existing
                    .as_ref()
                    .and_then(|record| record.updated_at.clone())
            }),
            raw_rollout_bytes,
        };

        if merged_thread.rollout_path == "Not materialized on disk"
            || !Path::new(&merged_thread.rollout_path).exists()
        {
            scan_issues.push(ScanIssue {
        kind: ScanIssueKind::MissingRollout,
        severity: IssueSeverity::Warning,
        message: format!(
          "Thread {} is present in the App Server index but the rollout file is not readable on disk.",
          merged_thread.thread_id
        ),
        path: if merged_thread.rollout_path == "Not materialized on disk" {
          None
        } else {
          Some(merged_thread.rollout_path.clone())
        },
        thread_id: Some(merged_thread.thread_id.clone()),
      });
        }

        merged.insert(thread_id, merged_thread);
    }

    merged.into_values().collect()
}

fn deduplicate_threads(
    threads: Vec<ThreadRecord>,
    scan_issues: &mut Vec<ScanIssue>,
) -> Vec<ThreadRecord> {
    let mut merged = HashMap::<String, ThreadRecord>::new();
    let mut duplicate_ids = HashSet::<String>::new();

    for thread in threads {
        if let Some(existing) = merged.get(&thread.thread_id) {
            duplicate_ids.insert(thread.thread_id.clone());
            scan_issues.push(ScanIssue {
                kind: ScanIssueKind::DuplicateThreadId,
                severity: IssueSeverity::Warning,
                message: format!(
                    "Duplicate thread id {} appears at both {} and {}. ThreadDock is showing one copy to prevent unsafe actions.",
                    thread.thread_id,
                    existing.rollout_path,
                    thread.rollout_path
                ),
                path: Some(thread.rollout_path.clone()),
                thread_id: Some(thread.thread_id.clone()),
            });
            continue;
        }

        merged.insert(thread.thread_id.clone(), thread);
    }

    if !duplicate_ids.is_empty() {
        log::warn!(
            "Detected duplicate Codex thread ids during scan: {}",
            duplicate_ids.into_iter().collect::<Vec<_>>().join(", ")
        );
    }

    merged.into_values().collect()
}

fn sort_threads(threads: &mut [ThreadRecord]) {
    threads.sort_by(|left, right| {
        right
            .updated_at
            .cmp(&left.updated_at)
            .then_with(|| right.created_at.cmp(&left.created_at))
            .then_with(|| left.title.cmp(&right.title))
    });
}

fn normalize_thread_source(source: Option<&str>) -> ThreadSource {
    match source {
        Some("user") => ThreadSource::User,
        Some("subagent") => ThreadSource::Subagent,
        _ => ThreadSource::Unknown,
    }
}

fn pick_title(
    primary: Option<String>,
    secondary: Option<String>,
    tertiary: Option<String>,
) -> String {
    non_empty_string(primary)
        .or_else(|| non_empty_string(secondary))
        .or_else(|| non_empty_string(tertiary))
        .unwrap_or_else(|| "Untitled thread".to_string())
}

fn pick_non_empty_string(primary: Option<String>, secondary: Option<String>) -> Option<String> {
    non_empty_string(primary).or_else(|| non_empty_string(secondary))
}

fn non_empty_string(value: Option<String>) -> Option<String> {
    value.and_then(|candidate| {
        let trimmed = candidate.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    })
}

fn summarize_preview(preview: &str) -> String {
    let compact = preview.split_whitespace().collect::<Vec<_>>().join(" ");
    if compact.is_empty() {
        return "Untitled thread".to_string();
    }

    if compact.chars().count() > 88 {
        let mut summary = compact.chars().take(85).collect::<String>();
        summary.push_str("...");
        summary
    } else {
        compact
    }
}

fn unix_seconds_to_rfc3339(seconds: i64) -> Option<String> {
    Utc.timestamp_opt(seconds, 0)
        .single()
        .map(|datetime| datetime.to_rfc3339())
}

fn modified_time_to_rfc3339(path: &Path) -> Option<String> {
    let modified = fs::metadata(path).ok()?.modified().ok()?;
    let datetime: DateTime<Utc> = modified.into();
    Some(datetime.to_rfc3339())
}

fn file_size(path: &str) -> Option<u64> {
    fs::metadata(path).ok().map(|metadata| metadata.len())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn temp_path(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!("threaddock-{label}-{}", uuid::Uuid::new_v4()))
    }

    #[test]
    fn read_session_meta_parses_valid_session_line() {
        let path = temp_path("valid-session.jsonl");
        let mut file = File::create(&path).expect("create temp session");
        writeln!(
            file,
            "{}",
            serde_json::json!({
              "type": "session_meta",
              "payload": {
                "id": "thread-1",
                "timestamp": "2026-05-26T19:00:00Z",
                "cwd": "C:/workspace",
                "thread_source": "user"
              }
            })
        )
        .expect("write session line");

        let meta = read_session_meta(&path).expect("parse session meta");
        assert_eq!(meta.id, "thread-1");
        assert_eq!(meta.cwd.as_deref(), Some("C:/workspace"));

        let _ = fs::remove_file(path);
    }

    #[test]
    fn scan_rollouts_collects_malformed_issue() {
        let root = temp_path("scan-root");
        fs::create_dir_all(&root).expect("create scan root");
        fs::write(root.join("broken.jsonl"), b"not-json\n").expect("write broken rollout");

        let result =
            scan_rollouts(&root, ThreadStatus::Active, &HashMap::new(), false).expect("scan");
        assert!(result.threads.is_empty());
        assert_eq!(result.issues.len(), 1);
        assert!(matches!(
            result.issues[0].kind,
            ScanIssueKind::MalformedRollout
        ));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn merge_app_server_threads_flags_missing_rollout() {
        let mut issues = Vec::new();
        let merged = merge_app_server_threads(
            Vec::new(),
            vec![AppThreadEntry {
                status: ThreadStatus::Active,
                thread: AppServerThread {
                    id: "thread-2".to_string(),
                    name: Some("Missing rollout".to_string()),
                    preview: "preview".to_string(),
                    path: None,
                    cwd: "C:/workspace".to_string(),
                    created_at: 1_779_822_000,
                    updated_at: 1_779_822_100,
                    thread_source: Some("user".to_string()),
                },
            }],
            &mut issues,
        );

        assert_eq!(merged.len(), 1);
        assert_eq!(issues.len(), 1);
        assert!(matches!(issues[0].kind, ScanIssueKind::MissingRollout));
        assert_eq!(issues[0].thread_id.as_deref(), Some("thread-2"));
    }

    #[test]
    fn deduplicate_threads_reports_duplicate_ids() {
        let first = ThreadRecord {
            thread_id: "thread-dup".to_string(),
            title: "First".to_string(),
            status: ThreadStatus::Active,
            thread_source: ThreadSource::User,
            read_only: false,
            parent_thread_id: None,
            cwd: None,
            rollout_path: "C:/codex/sessions/thread-dup.jsonl".to_string(),
            created_at: None,
            updated_at: None,
            raw_rollout_bytes: 10,
        };
        let mut second = first.clone();
        second.title = "Second".to_string();
        second.rollout_path = "C:/codex/archived_sessions/thread-dup.jsonl".to_string();

        let mut issues = Vec::new();
        let deduplicated = deduplicate_threads(vec![first, second], &mut issues);

        assert_eq!(deduplicated.len(), 1);
        assert_eq!(issues.len(), 1);
        assert!(matches!(issues[0].kind, ScanIssueKind::DuplicateThreadId));
        assert_eq!(issues[0].thread_id.as_deref(), Some("thread-dup"));
    }

    #[test]
    fn summarize_preview_truncates_unicode_on_char_boundaries() {
        let preview = "é".repeat(120);
        let summary = summarize_preview(&preview);

        assert!(summary.ends_with("..."));
        assert_eq!(summary.chars().count(), 88);
    }
}
