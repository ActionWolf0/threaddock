use std::{
    collections::{HashMap, HashSet},
    fs,
    path::PathBuf,
};

use dirs::data_local_dir;
use rusqlite::{params, types::Type, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::codex::{ScanIssue, ThreadRecord, ThreadSource};

const APP_DIR_NAME: &str = "ThreadDock";
const DATABASE_FILE_NAME: &str = "threaddock-cache.sqlite3";
const OFFICIAL_GITHUB_REPOSITORY: &str = "ActionWolf0/threaddock";

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BackupArtifactFormat {
    #[default]
    Zip,
    Folder,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AppPreferences {
    pub alternate_archive_path: Option<String>,
    pub backup_directory: Option<String>,
    #[serde(default)]
    pub backup_format: BackupArtifactFormat,
    pub codex_binary_path: Option<String>,
    pub codex_home_override: Option<String>,
    pub github_repository: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityRecord {
    pub activity_id: String,
    pub artifact_path: Option<String>,
    pub created_at: String,
    pub detail: String,
    pub kind: ActivityKind,
    pub label: String,
    pub scope: ActivityScope,
    pub status: ActivityStatus,
    pub thread_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ActivityKind {
    Archive,
    Unarchive,
    Backup,
    Trash,
    Restore,
    Purge,
    Import,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ActivityScope {
    Thread,
    Threads,
    Family,
    Trash,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ActivityStatus {
    Success,
    Error,
}

#[derive(Debug, Clone)]
pub struct NewActivityRecord {
    pub artifact_path: Option<String>,
    pub created_at: String,
    pub detail: String,
    pub kind: ActivityKind,
    pub label: String,
    pub scope: ActivityScope,
    pub status: ActivityStatus,
    pub thread_ids: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct BackupCacheRecord {
    pub artifact_bytes: u64,
    pub backup_id: String,
    pub created_at: String,
    pub family_mode: bool,
    pub family_roots: Vec<String>,
    pub format: String,
    pub label: String,
    pub manifest_version: u32,
    pub source_codex_home: String,
    pub target_path: String,
    pub thread_count: usize,
    pub thread_ids: Vec<String>,
    pub total_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedViewRecord {
    pub date_from: String,
    pub date_to: String,
    pub include_read_only: String,
    pub max_bytes_mb: String,
    pub min_bytes_mb: String,
    pub name: String,
    pub parent_thread_id_query: String,
    pub query: String,
    pub section: String,
    pub sort_key: String,
    pub source_filter: String,
    pub thread_id_query: String,
    pub view_id: String,
    pub workspace_filter: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupRuleRecord {
    pub action: String,
    pub created_at: String,
    pub include_subagents: bool,
    pub min_bytes_mb: String,
    pub name: String,
    pub older_than_days: String,
    pub rule_id: String,
    pub scope: String,
    pub workspace_filter: String,
}

pub fn load_app_preferences() -> Result<AppPreferences, String> {
    let connection = open_connection()?;

    Ok(AppPreferences {
        codex_home_override: read_app_state(&connection, "codex_home_override")?,
        alternate_archive_path: read_app_state(&connection, "alternate_archive_path")?,
        backup_directory: read_app_state(&connection, "backup_directory")?,
        backup_format: read_app_state(&connection, "backup_format")?
            .as_deref()
            .map(parse_backup_format)
            .transpose()?
            .unwrap_or_default(),
        codex_binary_path: read_app_state(&connection, "codex_binary_path")?,
        github_repository: read_app_state(&connection, "github_repository")?
            .or_else(|| Some(OFFICIAL_GITHUB_REPOSITORY.to_string())),
    })
}

pub fn save_app_preferences(request: AppPreferences) -> Result<AppPreferences, String> {
    let connection = open_connection()?;
    let values = [
        (
            "codex_home_override",
            normalize_string(request.codex_home_override),
        ),
        (
            "alternate_archive_path",
            normalize_string(request.alternate_archive_path),
        ),
        (
            "backup_directory",
            normalize_string(request.backup_directory),
        ),
        (
            "backup_format",
            Some(backup_format_label(&request.backup_format).to_string()),
        ),
        (
            "codex_binary_path",
            normalize_string(request.codex_binary_path),
        ),
        (
            "github_repository",
            normalize_string(request.github_repository),
        ),
    ];

    for (key, value) in values {
        if let Some(value) = value {
            connection
                .execute(
                    "INSERT INTO app_state (key, value) VALUES (?1, ?2)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                    params![key, value],
                )
                .map_err(|error| {
                    format!("Failed to save {key} to the ThreadDock cache: {error}")
                })?;
        } else {
            connection
                .execute("DELETE FROM app_state WHERE key = ?1", params![key])
                .map_err(|error| {
                    format!("Failed to clear {key} from the ThreadDock cache: {error}")
                })?;
        }
    }

    load_app_preferences()
}

pub fn load_saved_views() -> Result<Vec<SavedViewRecord>, String> {
    let connection = open_connection()?;
    read_json_state(&connection, "saved_views")
}

pub fn save_saved_view(view: SavedViewRecord) -> Result<Vec<SavedViewRecord>, String> {
    let connection = open_connection()?;
    let mut views = read_json_state::<Vec<SavedViewRecord>>(&connection, "saved_views")?;

    if let Some(existing) = views
        .iter_mut()
        .find(|existing| existing.view_id == view.view_id)
    {
        *existing = view;
    } else {
        views.push(view);
    }

    write_json_state(&connection, "saved_views", &views)?;
    Ok(views)
}

pub fn delete_saved_view(view_id: &str) -> Result<Vec<SavedViewRecord>, String> {
    let connection = open_connection()?;
    let mut views = read_json_state::<Vec<SavedViewRecord>>(&connection, "saved_views")?;
    views.retain(|view| view.view_id != view_id);
    write_json_state(&connection, "saved_views", &views)?;
    Ok(views)
}

pub fn load_cleanup_rules() -> Result<Vec<CleanupRuleRecord>, String> {
    let connection = open_connection()?;
    read_json_state(&connection, "cleanup_rules")
}

pub fn save_cleanup_rule(rule: CleanupRuleRecord) -> Result<Vec<CleanupRuleRecord>, String> {
    let connection = open_connection()?;
    let mut rules = read_json_state::<Vec<CleanupRuleRecord>>(&connection, "cleanup_rules")?;

    if let Some(existing) = rules
        .iter_mut()
        .find(|existing| existing.rule_id == rule.rule_id)
    {
        *existing = rule;
    } else {
        rules.push(rule);
    }

    write_json_state(&connection, "cleanup_rules", &rules)?;
    Ok(rules)
}

pub fn delete_cleanup_rule(rule_id: &str) -> Result<Vec<CleanupRuleRecord>, String> {
    let connection = open_connection()?;
    let mut rules = read_json_state::<Vec<CleanupRuleRecord>>(&connection, "cleanup_rules")?;
    rules.retain(|rule| rule.rule_id != rule_id);
    write_json_state(&connection, "cleanup_rules", &rules)?;
    Ok(rules)
}

pub fn load_recent_activity(limit: usize) -> Result<Vec<ActivityRecord>, String> {
    let connection = open_connection()?;
    let mut statement = connection
    .prepare(
      "SELECT activity_id, created_at, kind, scope, label, status, detail, thread_ids_json, artifact_path
       FROM activity_log
       ORDER BY created_at DESC
       LIMIT ?1",
    )
    .map_err(|error| format!("Failed to query the ThreadDock activity log: {error}"))?;
    let rows = statement
        .query_map(params![limit as i64], |row| {
            let thread_ids_json: String = row.get(7)?;
            let thread_ids =
                serde_json::from_str::<Vec<String>>(&thread_ids_json).unwrap_or_default();
            Ok(ActivityRecord {
                activity_id: row.get(0)?,
                created_at: row.get(1)?,
                kind: parse_activity_kind(row.get::<_, String>(2)?.as_str()).map_err(|error| {
                    rusqlite::Error::FromSqlConversionFailure(2, Type::Text, error)
                })?,
                scope: parse_activity_scope(row.get::<_, String>(3)?.as_str()).map_err(
                    |error| rusqlite::Error::FromSqlConversionFailure(3, Type::Text, error),
                )?,
                label: row.get(4)?,
                status: parse_activity_status(row.get::<_, String>(5)?.as_str()).map_err(
                    |error| rusqlite::Error::FromSqlConversionFailure(5, Type::Text, error),
                )?,
                detail: row.get(6)?,
                thread_ids,
                artifact_path: row.get(8)?,
            })
        })
        .map_err(|error| format!("Failed to read the ThreadDock activity log: {error}"))?;

    let mut records = Vec::new();
    for row in rows {
        records.push(
            row.map_err(|error| format!("Failed to parse a ThreadDock activity row: {error}"))?,
        );
    }

    Ok(records)
}

pub fn append_activity(record: NewActivityRecord) -> Result<(), String> {
    let connection = open_connection()?;
    let thread_ids_json = serde_json::to_string(&record.thread_ids)
        .map_err(|error| format!("Failed to serialize the ThreadDock activity record: {error}"))?;

    connection
        .execute(
            "INSERT INTO activity_log (
         activity_id,
         created_at,
         kind,
         scope,
         label,
         status,
         detail,
         thread_ids_json,
         artifact_path
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                Uuid::new_v4().to_string(),
                record.created_at,
                activity_kind_label(&record.kind),
                activity_scope_label(&record.scope),
                record.label,
                activity_status_label(&record.status),
                record.detail,
                thread_ids_json,
                record.artifact_path,
            ],
        )
        .map_err(|error| format!("Failed to append to the ThreadDock activity log: {error}"))?;

    Ok(())
}

pub fn sync_backup_inventory(records: &[BackupCacheRecord]) -> Result<(), String> {
    let mut connection = open_connection()?;
    let transaction = connection
        .transaction()
        .map_err(|error| format!("Failed to open a backup cache transaction: {error}"))?;

    transaction
        .execute("DELETE FROM backups", [])
        .map_err(|error| format!("Failed to clear cached backup records: {error}"))?;

    for record in records {
        let thread_ids_json = serde_json::to_string(&record.thread_ids)
            .map_err(|error| format!("Failed to serialize cached backup thread ids: {error}"))?;
        let family_roots_json = serde_json::to_string(&record.family_roots)
            .map_err(|error| format!("Failed to serialize cached backup family roots: {error}"))?;

        transaction
            .execute(
                "INSERT INTO backups (
           backup_id,
           created_at,
           label,
           format,
           target_path,
           thread_count,
           family_mode,
           total_bytes,
           manifest_version,
         source_codex_home,
         thread_ids_json,
         family_roots_json,
         artifact_bytes
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
                params![
                    record.backup_id,
                    record.created_at,
                    record.label,
                    record.format,
                    record.target_path,
                    record.thread_count as i64,
                    i64::from(record.family_mode),
                    record.total_bytes as i64,
                    record.manifest_version as i64,
                    record.source_codex_home,
                    thread_ids_json,
                    family_roots_json,
                    record.artifact_bytes as i64,
                ],
            )
            .map_err(|error| format!("Failed to cache backup {}: {error}", record.backup_id))?;
    }

    transaction
        .commit()
        .map_err(|error| format!("Failed to commit cached backup records: {error}"))
}

pub fn sync_scan_snapshot(
    threads: &[ThreadRecord],
    scan_issues: &[ScanIssue],
    scanned_at: &str,
) -> Result<(), String> {
    let mut connection = open_connection()?;
    let transaction = connection
        .transaction()
        .map_err(|error| format!("Failed to open a scan cache transaction: {error}"))?;

    transaction
        .execute("DELETE FROM threads", [])
        .map_err(|error| format!("Failed to clear cached thread records: {error}"))?;
    transaction
        .execute("DELETE FROM thread_families", [])
        .map_err(|error| format!("Failed to clear cached family records: {error}"))?;

    let issue_threads = scan_issues
        .iter()
        .filter_map(|issue| issue.thread_id.clone())
        .collect::<HashSet<_>>();

    for thread in threads {
        let scan_state = if issue_threads.contains(&thread.thread_id) {
            "warning"
        } else {
            "ok"
        };

        transaction
            .execute(
                "INSERT INTO threads (
           thread_id,
           title,
           status,
           archived,
           thread_source,
           parent_thread_id,
           cwd,
           rollout_path,
           created_at,
           updated_at,
           raw_rollout_bytes,
           scan_state,
           last_scanned_at,
           read_only
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
                params![
                    thread.thread_id,
                    thread.title,
                    if matches!(thread.status, crate::codex::ThreadStatus::Archived) {
                        "archived"
                    } else {
                        "active"
                    },
                    if matches!(thread.status, crate::codex::ThreadStatus::Archived) {
                        1_i64
                    } else {
                        0_i64
                    },
                    match thread.thread_source {
                        ThreadSource::User => "user",
                        ThreadSource::Subagent => "subagent",
                        ThreadSource::Unknown => "unknown",
                    },
                    thread.parent_thread_id,
                    thread.cwd,
                    thread.rollout_path,
                    thread.created_at,
                    thread.updated_at,
                    thread.raw_rollout_bytes as i64,
                    scan_state,
                    scanned_at,
                    i64::from(thread.read_only),
                ],
            )
            .map_err(|error| format!("Failed to cache thread {}: {error}", thread.thread_id))?;
    }

    let thread_map = threads
        .iter()
        .map(|thread| (thread.thread_id.clone(), thread))
        .collect::<HashMap<_, _>>();
    let mut family_rows = HashMap::<String, (usize, u64)>::new();

    for thread in threads
        .iter()
        .filter(|thread| matches!(thread.thread_source, ThreadSource::Subagent))
    {
        let root_thread_id = thread
            .parent_thread_id
            .clone()
            .unwrap_or_else(|| format!("detached:{}", thread.thread_id));
        let family = family_rows
            .entry(root_thread_id.clone())
            .or_insert_with(|| {
                let parent_bytes = thread
                    .parent_thread_id
                    .as_ref()
                    .and_then(|parent_thread_id| thread_map.get(parent_thread_id))
                    .map(|parent_thread| parent_thread.raw_rollout_bytes)
                    .unwrap_or(0);
                (0, parent_bytes)
            });
        family.0 += 1;
        family.1 += thread.raw_rollout_bytes;
    }

    for (root_thread_id, (descendant_count, family_rollout_bytes)) in family_rows {
        transaction
            .execute(
                "INSERT INTO thread_families (
           root_thread_id,
           descendant_count,
           family_rollout_bytes,
           last_aggregated_at
         ) VALUES (?1, ?2, ?3, ?4)",
                params![
                    root_thread_id,
                    descendant_count as i64,
                    family_rollout_bytes as i64,
                    scanned_at,
                ],
            )
            .map_err(|error| {
                format!("Failed to cache family aggregate {root_thread_id}: {error}")
            })?;
    }

    transaction
        .commit()
        .map_err(|error| format!("Failed to commit the ThreadDock scan cache: {error}"))
}

fn open_connection() -> Result<Connection, String> {
    let path = database_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            format!(
                "Failed to create ThreadDock app data at {}: {error}",
                parent.display()
            )
        })?;
    }

    let connection = Connection::open(&path).map_err(|error| {
        format!(
            "Failed to open the ThreadDock cache at {}: {error}",
            path.display()
        )
    })?;
    initialize_schema(&connection)?;
    Ok(connection)
}

fn database_path() -> Result<PathBuf, String> {
    let root = data_local_dir().or_else(dirs::data_dir).ok_or_else(|| {
        "Unable to resolve a local app-data directory for ThreadDock.".to_string()
    })?;
    Ok(root.join(APP_DIR_NAME).join(DATABASE_FILE_NAME))
}

fn initialize_schema(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(
            "
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS app_state (
        key TEXT PRIMARY KEY NOT NULL,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS threads (
        thread_id TEXT PRIMARY KEY NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        archived INTEGER NOT NULL,
        thread_source TEXT NOT NULL,
        parent_thread_id TEXT,
        cwd TEXT,
        rollout_path TEXT NOT NULL,
        created_at TEXT,
        updated_at TEXT,
        raw_rollout_bytes INTEGER NOT NULL,
        scan_state TEXT NOT NULL,
        last_scanned_at TEXT NOT NULL,
        read_only INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS thread_families (
        root_thread_id TEXT PRIMARY KEY NOT NULL,
        descendant_count INTEGER NOT NULL,
        family_rollout_bytes INTEGER NOT NULL,
        last_aggregated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS backups (
        backup_id TEXT PRIMARY KEY NOT NULL,
        created_at TEXT NOT NULL,
        label TEXT NOT NULL DEFAULT '',
        format TEXT NOT NULL,
        target_path TEXT NOT NULL,
        thread_count INTEGER NOT NULL,
        family_mode INTEGER NOT NULL,
        total_bytes INTEGER NOT NULL,
        manifest_version INTEGER NOT NULL,
        source_codex_home TEXT NOT NULL,
        thread_ids_json TEXT NOT NULL,
        family_roots_json TEXT NOT NULL,
        artifact_bytes INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS activity_log (
        activity_id TEXT PRIMARY KEY NOT NULL,
        created_at TEXT NOT NULL,
        kind TEXT NOT NULL,
        scope TEXT NOT NULL,
        label TEXT NOT NULL,
        status TEXT NOT NULL,
        detail TEXT NOT NULL,
        thread_ids_json TEXT NOT NULL,
        artifact_path TEXT
      );
      ",
        )
        .map_err(|error| format!("Failed to initialize the ThreadDock cache schema: {error}"))
}

fn read_app_state(connection: &Connection, key: &str) -> Result<Option<String>, String> {
    connection
        .query_row(
            "SELECT value FROM app_state WHERE key = ?1",
            params![key],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| format!("Failed to load {key} from the ThreadDock cache: {error}"))
}

fn read_json_state<T>(connection: &Connection, key: &str) -> Result<T, String>
where
    T: for<'de> Deserialize<'de> + Default,
{
    let Some(raw) = read_app_state(connection, key)? else {
        return Ok(T::default());
    };

    serde_json::from_str(&raw)
        .map_err(|error| format!("Failed to parse {key} from the ThreadDock cache: {error}"))
}

fn write_json_state<T>(connection: &Connection, key: &str, value: &T) -> Result<(), String>
where
    T: Serialize,
{
    let serialized = serde_json::to_string(value)
        .map_err(|error| format!("Failed to serialize {key} for the ThreadDock cache: {error}"))?;

    connection
        .execute(
            "INSERT INTO app_state (key, value) VALUES (?1, ?2)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, serialized],
        )
        .map_err(|error| format!("Failed to save {key} to the ThreadDock cache: {error}"))?;

    Ok(())
}

fn normalize_string(value: Option<String>) -> Option<String> {
    value.and_then(|candidate| {
        let trimmed = candidate.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    })
}

fn parse_backup_format(value: &str) -> Result<BackupArtifactFormat, String> {
    match value {
        "zip" => Ok(BackupArtifactFormat::Zip),
        "folder" => Ok(BackupArtifactFormat::Folder),
        _ => Err(format!("Unknown backup format setting: {value}")),
    }
}

fn backup_format_label(value: &BackupArtifactFormat) -> &'static str {
    match value {
        BackupArtifactFormat::Zip => "zip",
        BackupArtifactFormat::Folder => "folder",
    }
}

fn parse_activity_kind(
    value: &str,
) -> Result<ActivityKind, Box<dyn std::error::Error + Send + Sync + 'static>> {
    match value {
        "archive" => Ok(ActivityKind::Archive),
        "unarchive" => Ok(ActivityKind::Unarchive),
        "backup" => Ok(ActivityKind::Backup),
        "trash" => Ok(ActivityKind::Trash),
        "restore" => Ok(ActivityKind::Restore),
        "purge" => Ok(ActivityKind::Purge),
        "import" => Ok(ActivityKind::Import),
        _ => Err(format!("Unknown activity kind: {value}").into()),
    }
}

fn parse_activity_scope(
    value: &str,
) -> Result<ActivityScope, Box<dyn std::error::Error + Send + Sync + 'static>> {
    match value {
        "thread" => Ok(ActivityScope::Thread),
        "threads" => Ok(ActivityScope::Threads),
        "family" => Ok(ActivityScope::Family),
        "trash" => Ok(ActivityScope::Trash),
        _ => Err(format!("Unknown activity scope: {value}").into()),
    }
}

fn parse_activity_status(
    value: &str,
) -> Result<ActivityStatus, Box<dyn std::error::Error + Send + Sync + 'static>> {
    match value {
        "success" => Ok(ActivityStatus::Success),
        "error" => Ok(ActivityStatus::Error),
        _ => Err(format!("Unknown activity status: {value}").into()),
    }
}

fn activity_kind_label(value: &ActivityKind) -> &'static str {
    match value {
        ActivityKind::Archive => "archive",
        ActivityKind::Unarchive => "unarchive",
        ActivityKind::Backup => "backup",
        ActivityKind::Trash => "trash",
        ActivityKind::Restore => "restore",
        ActivityKind::Purge => "purge",
        ActivityKind::Import => "import",
    }
}

fn activity_scope_label(value: &ActivityScope) -> &'static str {
    match value {
        ActivityScope::Thread => "thread",
        ActivityScope::Threads => "threads",
        ActivityScope::Family => "family",
        ActivityScope::Trash => "trash",
    }
}

fn activity_status_label(value: &ActivityStatus) -> &'static str {
    match value {
        ActivityStatus::Success => "success",
        ActivityStatus::Error => "error",
    }
}
