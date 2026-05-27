mod app_server;
mod backup;
mod cache;
mod codex;
mod handoff;
mod system;
mod trash;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(
            tauri_plugin_log::Builder::default()
                .level(log::LevelFilter::Info)
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            load_thread_library,
            archive_thread,
            unarchive_thread,
            archive_threads,
            unarchive_threads,
            load_backup_inventory,
            export_backup,
            preview_backup_artifact,
            import_backup_artifact,
            create_secure_handoff,
            preview_secure_handoff,
            import_secure_handoff,
            save_app_preferences,
            save_saved_view,
            delete_saved_view,
            save_cleanup_rule,
            delete_cleanup_rule,
            load_trash_inventory,
            trash_threads,
            restore_trash_items,
            purge_trash_items,
            reveal_path,
            copy_text
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[tauri::command]
fn load_thread_library() -> Result<codex::ThreadLibrarySnapshot, String> {
    codex::load_thread_library()
}

#[tauri::command]
fn archive_thread(thread_id: String) -> Result<(), String> {
    codex::archive_thread(&thread_id)?;
    log_activity(
        cache::ActivityKind::Archive,
        cache::ActivityScope::Thread,
        "Thread archive".to_string(),
        format!("Archived thread {thread_id}."),
        vec![thread_id],
        None,
    );
    Ok(())
}

#[tauri::command]
fn unarchive_thread(thread_id: String) -> Result<(), String> {
    codex::unarchive_thread(&thread_id)?;
    log_activity(
        cache::ActivityKind::Unarchive,
        cache::ActivityScope::Thread,
        "Thread restore".to_string(),
        format!("Restored thread {thread_id}."),
        vec![thread_id],
        None,
    );
    Ok(())
}

#[tauri::command]
fn archive_threads(thread_ids: Vec<String>) -> Result<(), String> {
    codex::archive_threads(&thread_ids)?;
    log_activity(
        cache::ActivityKind::Archive,
        cache::ActivityScope::Threads,
        "Bulk archive".to_string(),
        format!("Archived {} selected threads.", thread_ids.len()),
        thread_ids,
        None,
    );
    Ok(())
}

#[tauri::command]
fn unarchive_threads(thread_ids: Vec<String>) -> Result<(), String> {
    codex::unarchive_threads(&thread_ids)?;
    log_activity(
        cache::ActivityKind::Unarchive,
        cache::ActivityScope::Threads,
        "Bulk restore".to_string(),
        format!("Restored {} selected threads.", thread_ids.len()),
        thread_ids,
        None,
    );
    Ok(())
}

#[tauri::command]
fn load_backup_inventory(
    destination_dir: Option<String>,
) -> Result<backup::BackupInventorySnapshot, String> {
    backup::load_backup_inventory(destination_dir)
}

#[tauri::command]
fn export_backup(request: backup::BackupExportRequest) -> Result<backup::BackupRecord, String> {
    backup::export_backup(request)
}

#[tauri::command]
fn import_backup_artifact(
    request: backup::BackupImportRequest,
) -> Result<backup::BackupImportResult, String> {
    backup::import_backup_artifact(request)
}

#[tauri::command]
fn preview_backup_artifact(
    request: backup::BackupPreviewRequest,
) -> Result<backup::BackupRecord, String> {
    backup::preview_backup_artifact(request)
}

#[tauri::command]
fn create_secure_handoff(
    request: handoff::CreateHandoffRequest,
) -> Result<handoff::HandoffRecord, String> {
    handoff::create_secure_handoff(request)
}

#[tauri::command]
fn preview_secure_handoff(
    request: handoff::PreviewHandoffRequest,
) -> Result<handoff::HandoffPreviewRecord, String> {
    handoff::preview_secure_handoff(request)
}

#[tauri::command]
fn import_secure_handoff(
    request: handoff::ImportHandoffRequest,
) -> Result<handoff::ImportHandoffResult, String> {
    handoff::import_secure_handoff(request)
}

#[tauri::command]
fn save_app_preferences(request: cache::AppPreferences) -> Result<cache::AppPreferences, String> {
    cache::save_app_preferences(request)
}

#[tauri::command]
fn save_saved_view(view: cache::SavedViewRecord) -> Result<Vec<cache::SavedViewRecord>, String> {
    cache::save_saved_view(view)
}

#[tauri::command]
fn delete_saved_view(view_id: String) -> Result<Vec<cache::SavedViewRecord>, String> {
    cache::delete_saved_view(&view_id)
}

#[tauri::command]
fn save_cleanup_rule(
    rule: cache::CleanupRuleRecord,
) -> Result<Vec<cache::CleanupRuleRecord>, String> {
    cache::save_cleanup_rule(rule)
}

#[tauri::command]
fn delete_cleanup_rule(rule_id: String) -> Result<Vec<cache::CleanupRuleRecord>, String> {
    cache::delete_cleanup_rule(&rule_id)
}

#[tauri::command]
fn load_trash_inventory() -> Result<Vec<trash::TrashRecord>, String> {
    trash::load_trash_inventory()
}

#[tauri::command]
fn trash_threads(thread_ids: Vec<String>) -> Result<Vec<trash::TrashRecord>, String> {
    let records = trash::trash_threads(&thread_ids)?;
    log_activity(
        cache::ActivityKind::Trash,
        if records.len() > 1 {
            cache::ActivityScope::Threads
        } else {
            cache::ActivityScope::Thread
        },
        "Move to trash".to_string(),
        format!(
            "Moved {} thread{} to trash.",
            records.len(),
            if records.len() == 1 { "" } else { "s" }
        ),
        thread_ids,
        None,
    );
    Ok(records)
}

#[tauri::command]
fn restore_trash_items(trash_ids: Vec<String>) -> Result<Vec<trash::TrashRecord>, String> {
    let records = trash::restore_trash_items(&trash_ids)?;
    log_activity(
        cache::ActivityKind::Restore,
        cache::ActivityScope::Trash,
        "Trash restore".to_string(),
        format!(
            "Restored {} trashed thread{}.",
            records.len(),
            if records.len() == 1 { "" } else { "s" }
        ),
        records
            .iter()
            .map(|record| record.thread_id.clone())
            .collect(),
        None,
    );
    Ok(records)
}

#[tauri::command]
fn purge_trash_items(trash_ids: Vec<String>) -> Result<Vec<trash::TrashRecord>, String> {
    let records = trash::purge_trash_items(&trash_ids)?;
    log_activity(
        cache::ActivityKind::Purge,
        cache::ActivityScope::Trash,
        "Trash purge".to_string(),
        format!(
            "Permanently removed {} trashed thread{}.",
            records.len(),
            if records.len() == 1 { "" } else { "s" }
        ),
        records
            .iter()
            .map(|record| record.thread_id.clone())
            .collect(),
        None,
    );
    Ok(records)
}

#[tauri::command]
fn reveal_path(path: String) -> Result<(), String> {
    system::reveal_path(&path)
}

#[tauri::command]
fn copy_text(value: String) -> Result<(), String> {
    system::copy_text(&value)
}

fn log_activity(
    kind: cache::ActivityKind,
    scope: cache::ActivityScope,
    label: String,
    detail: String,
    thread_ids: Vec<String>,
    artifact_path: Option<String>,
) {
    if let Err(error) = cache::append_activity(cache::NewActivityRecord {
        artifact_path,
        created_at: chrono::Utc::now().to_rfc3339(),
        detail,
        kind,
        label,
        scope,
        status: cache::ActivityStatus::Success,
        thread_ids,
    }) {
        log::warn!("Failed to record ThreadDock activity: {error}");
    }
}
