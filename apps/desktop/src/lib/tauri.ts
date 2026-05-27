import { invoke } from "@tauri-apps/api/core";
import type {
  BackupImportRequest,
  BackupImportResult,
  BackupExportRequest,
  BackupInventorySnapshot,
  BackupPreviewRequest,
  BackupRecord,
  CreateHandoffRequest,
  CleanupRuleRecord,
  HandoffRecord,
  HandoffPreviewRecord,
  ImportHandoffRequest,
  ImportHandoffResult,
  PreviewHandoffRequest,
  SavePreferencesRequest,
  SavedViewRecord,
  ThreadLibrarySnapshot,
  TrashRecord,
} from "../types";

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export async function loadThreadLibrarySnapshot(): Promise<ThreadLibrarySnapshot> {
  if (isTauriRuntime()) {
    return invoke<ThreadLibrarySnapshot>("load_thread_library");
  }

  return fetchJson<ThreadLibrarySnapshot>("/__threaddock__/thread-library");
}

export async function archiveThread(threadId: string): Promise<void> {
  if (isTauriRuntime()) {
    await invoke("archive_thread", { threadId });
    return;
  }

  await postJson("/__threaddock__/thread/archive", { threadId });
}

export async function unarchiveThread(threadId: string): Promise<void> {
  if (isTauriRuntime()) {
    await invoke("unarchive_thread", { threadId });
    return;
  }

  await postJson("/__threaddock__/thread/unarchive", { threadId });
}

export async function archiveThreads(threadIds: string[]): Promise<void> {
  if (isTauriRuntime()) {
    await invoke("archive_threads", { threadIds });
    return;
  }

  await postJson("/__threaddock__/thread/archive-many", { threadIds });
}

export async function unarchiveThreads(threadIds: string[]): Promise<void> {
  if (isTauriRuntime()) {
    await invoke("unarchive_threads", { threadIds });
    return;
  }

  await postJson("/__threaddock__/thread/unarchive-many", { threadIds });
}

export async function loadBackupInventory(
  destinationDir?: string | null,
): Promise<BackupInventorySnapshot> {
  if (isTauriRuntime()) {
    return invoke<BackupInventorySnapshot>("load_backup_inventory", { destinationDir });
  }

  return fetchJson<BackupInventorySnapshot>("/__threaddock__/backups", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ destinationDir }),
  });
}

export async function exportBackup(request: BackupExportRequest): Promise<BackupRecord> {
  if (isTauriRuntime()) {
    return invoke<BackupRecord>("export_backup", { request });
  }

  return fetchJson<BackupRecord>("/__threaddock__/backups/export", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(request),
  });
}

export async function importBackupArtifact(
  request: BackupImportRequest,
): Promise<BackupImportResult> {
  if (isTauriRuntime()) {
    return invoke<BackupImportResult>("import_backup_artifact", { request });
  }

  return fetchJson<BackupImportResult>("/__threaddock__/backups/import", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(request),
  });
}

export async function previewBackupArtifact(request: BackupPreviewRequest): Promise<BackupRecord> {
  if (isTauriRuntime()) {
    return invoke<BackupRecord>("preview_backup_artifact", { request });
  }

  return fetchJson<BackupRecord>("/__threaddock__/backups/preview", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(request),
  });
}

export async function createSecureHandoff(
  request: CreateHandoffRequest,
): Promise<HandoffRecord> {
  if (isTauriRuntime()) {
    return invoke<HandoffRecord>("create_secure_handoff", { request });
  }

  return fetchJson<HandoffRecord>("/__threaddock__/handoffs/create", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ request }),
  });
}

export async function previewSecureHandoff(
  request: PreviewHandoffRequest,
): Promise<HandoffPreviewRecord> {
  if (isTauriRuntime()) {
    return invoke<HandoffPreviewRecord>("preview_secure_handoff", { request });
  }

  return fetchJson<HandoffPreviewRecord>("/__threaddock__/handoffs/preview", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ request }),
  });
}

export async function importSecureHandoff(
  request: ImportHandoffRequest,
): Promise<ImportHandoffResult> {
  if (isTauriRuntime()) {
    return invoke<ImportHandoffResult>("import_secure_handoff", { request });
  }

  return fetchJson<ImportHandoffResult>("/__threaddock__/handoffs/import", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ request }),
  });
}

export async function revealPath(path: string): Promise<void> {
  if (isTauriRuntime()) {
    await invoke("reveal_path", { path });
    return;
  }

  await postJson("/__threaddock__/system/reveal", { path });
}

export async function copyText(value: string): Promise<void> {
  if (isTauriRuntime()) {
    await invoke("copy_text", { value });
    return;
  }

  await postJson("/__threaddock__/system/copy", { value });
}

export async function saveAppPreferences(
  request: SavePreferencesRequest,
): Promise<ThreadLibrarySnapshot["preferences"]> {
  if (isTauriRuntime()) {
    return invoke<ThreadLibrarySnapshot["preferences"]>("save_app_preferences", { request });
  }

  return fetchJson<ThreadLibrarySnapshot["preferences"]>("/__threaddock__/preferences", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(request),
  });
}

export async function saveSavedView(view: SavedViewRecord): Promise<SavedViewRecord[]> {
  if (isTauriRuntime()) {
    return invoke<SavedViewRecord[]>("save_saved_view", { view });
  }

  return fetchJson<SavedViewRecord[]>("/__threaddock__/saved-views", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ view }),
  });
}

export async function deleteSavedView(viewId: string): Promise<SavedViewRecord[]> {
  if (isTauriRuntime()) {
    return invoke<SavedViewRecord[]>("delete_saved_view", { viewId });
  }

  return fetchJson<SavedViewRecord[]>("/__threaddock__/saved-views/delete", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ viewId }),
  });
}

export async function saveCleanupRule(rule: CleanupRuleRecord): Promise<CleanupRuleRecord[]> {
  if (isTauriRuntime()) {
    return invoke<CleanupRuleRecord[]>("save_cleanup_rule", { rule });
  }

  return fetchJson<CleanupRuleRecord[]>("/__threaddock__/cleanup-rules", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ rule }),
  });
}

export async function deleteCleanupRule(ruleId: string): Promise<CleanupRuleRecord[]> {
  if (isTauriRuntime()) {
    return invoke<CleanupRuleRecord[]>("delete_cleanup_rule", { ruleId });
  }

  return fetchJson<CleanupRuleRecord[]>("/__threaddock__/cleanup-rules/delete", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ ruleId }),
  });
}

export async function loadTrashInventory(): Promise<TrashRecord[]> {
  if (isTauriRuntime()) {
    return invoke<TrashRecord[]>("load_trash_inventory");
  }

  return fetchJson<TrashRecord[]>("/__threaddock__/trash");
}

export async function trashThreads(threadIds: string[]): Promise<TrashRecord[]> {
  if (isTauriRuntime()) {
    return invoke<TrashRecord[]>("trash_threads", { threadIds });
  }

  return fetchJson<TrashRecord[]>("/__threaddock__/trash", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ threadIds }),
  });
}

export async function restoreTrashItems(trashIds: string[]): Promise<TrashRecord[]> {
  if (isTauriRuntime()) {
    return invoke<TrashRecord[]>("restore_trash_items", { trashIds });
  }

  return fetchJson<TrashRecord[]>("/__threaddock__/trash/restore", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ trashIds }),
  });
}

export async function purgeTrashItems(trashIds: string[]): Promise<TrashRecord[]> {
  if (isTauriRuntime()) {
    return invoke<TrashRecord[]>("purge_trash_items", { trashIds });
  }

  return fetchJson<TrashRecord[]>("/__threaddock__/trash/purge", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ trashIds }),
  });
}

async function postJson(url: string, body: object): Promise<void> {
  await fetchJson(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const payload = (await response.json()) as { message?: string };

  if (!response.ok) {
    throw new Error(payload.message ?? "ThreadDock request failed.");
  }

  return payload as T;
}
