import { spawn } from "node:child_process";
import { createCipheriv, createDecipheriv, createHash, pbkdf2Sync, randomBytes } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, realpathSync, statSync } from "node:fs";
import { access, copyFile, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import os from "node:os";
import path from "node:path";
import clipboard from "clipboardy";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import type {
  ActivityRecord,
  AppPreferences,
  AppServerStatus,
  BackupImportRequest,
  BackupImportResult,
  BackupPreviewRequest,
  BackupArtifactFormat,
  BackupExportMode,
  BackupExportRequest,
  BackupFamilyDescriptor,
  BackupInventorySnapshot,
  BackupRecord,
  CreateHandoffRequest,
  CleanupRuleRecord,
  HandoffRecord,
  HandoffPreviewRecord,
  ImportHandoffRequest,
  ImportHandoffResult,
  PreviewHandoffRequest,
  ScanIssue,
  SavedViewRecord,
  SavePreferencesRequest,
  ThreadLibrarySnapshot,
  ThreadRecord,
  TrashRecord,
  ThreadSource,
  ThreadStatus,
} from "../src/types";

interface IndexRecord {
  id: string;
  thread_name?: string;
  updated_at?: string;
}

interface SessionLine {
  type: string;
  payload: SessionPayload;
}

interface SessionPayload {
  id: string;
  timestamp?: string;
  cwd?: string;
  thread_source?: string;
  source?: SessionSource;
}

interface SessionSource {
  subagent?: {
    thread_spawn?: {
      parent_thread_id?: string;
    };
  };
}

interface AppServerThread {
  id: string;
  name: string | null;
  preview: string;
  path: string | null;
  cwd: string;
  createdAt: number;
  updatedAt: number;
  threadSource: ThreadSource | null;
}

interface AppServerThreadListResponse {
  data: AppServerThread[];
  nextCursor: string | null;
}

interface ThreadListParams {
  archived: boolean;
  limit: number;
  cursor?: string;
}

interface JsonRpcResponse<T> {
  id: number | string;
  result?: T;
  error?: {
    code: number;
    message: string;
  };
}

interface AppThreadEntry {
  status: ThreadStatus;
  thread: AppServerThread;
}

interface ScanResult {
  threads: ThreadRecord[];
  issues: ScanIssue[];
}

interface AppServerLoad {
  entries: AppThreadEntry[];
  status: AppServerStatus;
}

interface BackupManifest {
  backupFormatVersion: number;
  createdAt: string;
  threaddockVersion: string;
  label: string;
  mode: BackupExportMode;
  sourceCodexHome: string;
  exportedThreadIds: string[];
  exportedFamilyRoots: string[];
  totalRolloutBytes: number;
  files: Array<{
    threadId: string;
    archivePath: string;
    rolloutBytes: number;
    sha256: string;
  }>;
}

interface BackupFamilyMetadata {
  familyId: string;
  rootThreadId: string | null;
  label: string;
  threadIds: string[];
  totalRolloutBytes: number;
  orphaned: boolean;
}

interface HandoffHeader {
  algorithm: string;
  artifactBytes: number;
  backupSha256: string;
  createdAt: string;
  handoffFormatVersion: number;
  handoffId: string;
  kdf: string;
  kdfIterations: number;
  label: string;
  nonceHex: string;
  saltHex: string;
  sourceArtifactName: string;
  sourceArtifactPath: string;
  threadCount: number;
  threaddockVersion: string;
  totalRolloutBytes: number;
}

interface DevStateFile {
  activityLog: ActivityRecord[];
  cleanupRules: CleanupRuleRecord[];
  preferences: AppPreferences;
  savedViews: SavedViewRecord[];
}

interface TrashMetadata {
  cwd: string | null;
  deletedAt: string;
  expiresAt: string;
  originalFileName: string;
  originalPath: string;
  originalStatus: ThreadStatus;
  parentThreadId: string | null;
  rawRolloutBytes: number;
  threadId: string;
  threadSource: ThreadSource;
  title: string;
  trashId: string;
}

interface VerifiedImportThread {
  bytes: Uint8Array;
  thread: ThreadRecord;
}

const BACKUP_FORMAT_VERSION = 1;
const BACKUP_EXTENSION = ".threaddock-backup.zip";
const BACKUP_FOLDER_EXTENSION = ".threaddock-backup";
const HANDOFF_EXTENSION = ".threaddock-handoff";
const HANDOFF_MAGIC = Buffer.from("THREADDOCK-HANDOFF-V1\n", "utf8");
const HANDOFF_FORMAT_VERSION = 1;
const HANDOFF_ALGORITHM = "AES-256-GCM";
const HANDOFF_KDF = "PBKDF2-HMAC-SHA256";
const HANDOFF_KDF_ITERATIONS = 210_000;
const DEV_STATE_DIR = path.join(os.homedir(), ".threaddock");
const DEV_STATE_PATH = path.join(DEV_STATE_DIR, "browser-preview-state.json");
const DEV_TRASH_DIR = path.join(DEV_STATE_DIR, "trash");
const DEV_HANDOFF_DIR = path.join(DEV_STATE_DIR, "handoffs");
const OFFICIAL_GITHUB_REPOSITORY = "ActionWolf0/threaddock";
const DEFAULT_PREFERENCES: AppPreferences = {
  alternateArchivePath: null,
  backupDirectory: null,
  backupFormat: "zip",
  codexHomeOverride: null,
  githubRepository: OFFICIAL_GITHUB_REPOSITORY,
};

async function loadDevState(): Promise<DevStateFile> {
  await mkdir(DEV_STATE_DIR, { recursive: true });

  try {
    const payload = await readFile(DEV_STATE_PATH, "utf8");
    const parsed = JSON.parse(payload) as Partial<DevStateFile>;
    return {
      activityLog: Array.isArray(parsed.activityLog) ? parsed.activityLog : [],
      cleanupRules: Array.isArray(parsed.cleanupRules) ? parsed.cleanupRules : [],
      preferences: {
        ...DEFAULT_PREFERENCES,
        ...(parsed.preferences ?? {}),
        backupFormat:
          parsed.preferences?.backupFormat === "folder" ? "folder" : "zip",
      },
      savedViews: Array.isArray(parsed.savedViews) ? parsed.savedViews : [],
    };
  } catch {
    return {
      activityLog: [],
      cleanupRules: [],
      preferences: { ...DEFAULT_PREFERENCES },
      savedViews: [],
    };
  }
}

async function saveDevState(state: DevStateFile): Promise<void> {
  await mkdir(DEV_STATE_DIR, { recursive: true });
  await writeFile(DEV_STATE_PATH, JSON.stringify(state, null, 2));
}

async function appendActivity(
  record: Omit<ActivityRecord, "activityId">,
): Promise<void> {
  const state = await loadDevState();
  state.activityLog = [
    {
      activityId: cryptoRandomId(),
      ...record,
    },
    ...state.activityLog,
  ].slice(0, 24);
  await saveDevState(state);
}

function cryptoRandomId(): string {
  return createHash("sha256")
    .update(`${Date.now()}-${Math.random()}-${process.pid}`)
    .digest("hex")
    .slice(0, 16);
}

export async function loadThreadLibrarySnapshot(): Promise<ThreadLibrarySnapshot> {
  const state = await loadDevState();
  const codexHome = detectCodexHome(state.preferences);
  const index = await loadSessionIndex(codexHome);
  const scannedThreads = new Map<string, ThreadRecord>();
  const scanIssues: ScanIssue[] = [];

  for (const result of [
    scanRollouts(path.join(codexHome, "sessions"), "active", index, false),
    scanRollouts(path.join(codexHome, "archived_sessions"), "archived", index, false),
  ]) {
    for (const thread of result.threads) {
      scannedThreads.set(thread.threadId, thread);
    }
    scanIssues.push(...result.issues);
  }

  if (state.preferences.alternateArchivePath?.trim()) {
    const alternateArchivePath = state.preferences.alternateArchivePath.trim();
    if (existsSync(alternateArchivePath)) {
      const result = scanRollouts(alternateArchivePath, "archived", index, true);
      for (const thread of result.threads) {
        scannedThreads.set(thread.threadId, thread);
      }
      scanIssues.push(...result.issues);
    } else {
      scanIssues.push({
        kind: "missing_rollout",
        severity: "warning",
        message: `Configured alternate archive path is not readable: ${alternateArchivePath}`,
        path: alternateArchivePath,
        threadId: null,
      });
    }
  }

  const appServerLoad = await loadAppServerThreads();
  const mergedThreads = mergeThreads(
    scannedThreads,
    scanIssues,
    appServerLoad.entries,
  );

  const stats = mergedThreads.reduce(
    (summary, thread) => {
      if (thread.status === "active") {
        summary.activeCount += 1;
        summary.activeBytes += thread.rawRolloutBytes;
      } else {
        summary.archivedCount += 1;
        summary.archivedBytes += thread.rawRolloutBytes;
      }

      if (thread.threadSource === "subagent") {
        summary.subagentCount += 1;
      }

      return summary;
    },
    {
      activeCount: 0,
      archivedCount: 0,
      totalBytes: 0,
      activeBytes: 0,
      archivedBytes: 0,
      subagentCount: 0,
    },
  );

  stats.totalBytes = stats.activeBytes + stats.archivedBytes;

  return {
    appServer: appServerLoad.status,
    activityLog: state.activityLog,
    cleanupRules: state.cleanupRules,
    codexHome,
    preferences: state.preferences,
    scannedAt: new Date().toISOString(),
    scanIssues,
    savedViews: state.savedViews,
    stats,
    threads: mergedThreads,
  };
}

export async function archiveThread(threadId: string): Promise<void> {
  await ensureThreadMutable(threadId);
  await callAppServer("thread/archive", { threadId });
  await appendActivity({
    artifactPath: null,
    createdAt: new Date().toISOString(),
    detail: `Archived thread ${threadId}.`,
    kind: "archive",
    label: "Thread archive",
    scope: "thread",
    status: "success",
    threadIds: [threadId],
  });
}

export async function unarchiveThread(threadId: string): Promise<void> {
  await ensureThreadMutable(threadId);
  await callAppServer("thread/unarchive", { threadId });
  await appendActivity({
    artifactPath: null,
    createdAt: new Date().toISOString(),
    detail: `Restored thread ${threadId}.`,
    kind: "unarchive",
    label: "Thread restore",
    scope: "thread",
    status: "success",
    threadIds: [threadId],
  });
}

export async function archiveThreads(threadIds: string[]): Promise<void> {
  for (const threadId of threadIds) {
    await archiveThread(threadId);
  }
}

export async function unarchiveThreads(threadIds: string[]): Promise<void> {
  for (const threadId of threadIds) {
    await unarchiveThread(threadId);
  }
}

export async function loadTrashInventory(): Promise<TrashRecord[]> {
  await mkdir(DEV_TRASH_DIR, { recursive: true });
  const records: TrashRecord[] = [];

  for (const name of await readdir(DEV_TRASH_DIR)) {
    const entryRoot = path.join(DEV_TRASH_DIR, name);
    const stat = statSync(entryRoot);
    if (!stat.isDirectory()) {
      continue;
    }

    const record = await readTrashRecord(entryRoot);
    if (record) {
      records.push(record);
    }
  }

  records.sort((left, right) => {
    return right.deletedAt.localeCompare(left.deletedAt) || left.title.localeCompare(right.title);
  });
  return records;
}

export async function trashThreads(threadIds: string[]): Promise<TrashRecord[]> {
  const snapshot = await loadThreadLibrarySnapshot();
  const records: TrashRecord[] = [];

  for (const threadId of threadIds) {
    let thread = snapshot.threads.find((entry) => entry.threadId === threadId);
    if (!thread) {
      throw new Error(`Thread ${threadId} is no longer available.`);
    }
    if (thread.readOnly) {
      throw new Error(
        `Thread ${threadId} comes from a read-only archive path and cannot be moved to trash.`,
      );
    }
    if (thread.status === "active") {
      await archiveThread(threadId);
      const refreshed = await loadThreadLibrarySnapshot();
      thread = refreshed.threads.find((entry) => entry.threadId === threadId);
      if (!thread) {
        throw new Error(`Thread ${threadId} could not be located after archiving.`);
      }
    }

    records.push(await moveThreadToTrash(thread));
  }

  await appendActivity({
    artifactPath: null,
    createdAt: new Date().toISOString(),
    detail: `Moved ${records.length} thread${records.length === 1 ? "" : "s"} to trash.`,
    kind: "trash",
    label: "Move to trash",
    scope: records.length > 1 ? "threads" : "thread",
    status: "success",
    threadIds: records.map((record) => record.threadId),
  });
  return records;
}

export async function restoreTrashItems(trashIds: string[]): Promise<TrashRecord[]> {
  const snapshot = await loadThreadLibrarySnapshot();
  const codexHome = snapshot.codexHome;
  const restored: TrashRecord[] = [];

  for (const trashId of trashIds) {
    const entryRoot = trashEntryRoot(trashId);
    const metadata = await readTrashMetadata(entryRoot);
    const payloadPath = await findTrashPayload(entryRoot);
    const archivedRoot = path.join(codexHome, "archived_sessions");
    await mkdir(archivedRoot, { recursive: true });
    const targetPath = nextRestorePath(archivedRoot, metadata.originalFileName);
    await moveFile(payloadPath, targetPath);
    await rm(entryRoot, { recursive: true, force: true });
    restored.push({
      cwd: metadata.cwd,
      deletedAt: metadata.deletedAt,
      expiresAt: metadata.expiresAt,
      originalPath: targetPath,
      originalStatus: metadata.originalStatus,
      parentThreadId: metadata.parentThreadId,
      rawRolloutBytes: metadata.rawRolloutBytes,
      threadId: metadata.threadId,
      threadSource: metadata.threadSource,
      title: metadata.title,
      trashId: metadata.trashId,
      trashedPath: payloadPath,
    });
  }

  await appendActivity({
    artifactPath: null,
    createdAt: new Date().toISOString(),
    detail: `Restored ${restored.length} trashed thread${restored.length === 1 ? "" : "s"} to the archive vault.`,
    kind: "restore",
    label: "Trash restore",
    scope: "trash",
    status: "success",
    threadIds: restored.map((record) => record.threadId),
  });
  return restored;
}

export async function purgeTrashItems(trashIds: string[]): Promise<TrashRecord[]> {
  const purged: TrashRecord[] = [];
  for (const trashId of trashIds) {
    const entryRoot = trashEntryRoot(trashId);
    const record = await readTrashRecord(entryRoot);
    if (!record) {
      continue;
    }
    await rm(entryRoot, { recursive: true, force: true });
    purged.push(record);
  }

  await appendActivity({
    artifactPath: null,
    createdAt: new Date().toISOString(),
    detail: `Permanently removed ${purged.length} trashed thread${purged.length === 1 ? "" : "s"}.`,
    kind: "purge",
    label: "Trash purge",
    scope: "trash",
    status: "success",
    threadIds: purged.map((record) => record.threadId),
  });
  return purged;
}

export async function saveAppPreferences(
  request: SavePreferencesRequest,
): Promise<AppPreferences> {
  const state = await loadDevState();
  state.preferences = {
    alternateArchivePath: normalizeString(request.alternateArchivePath),
    backupDirectory: normalizeString(request.backupDirectory),
    backupFormat: request.backupFormat === "folder" ? "folder" : "zip",
    codexHomeOverride: normalizeString(request.codexHomeOverride),
    githubRepository: normalizeString(request.githubRepository),
  };
  await saveDevState(state);
  return state.preferences;
}

export async function saveSavedView(view: SavedViewRecord): Promise<SavedViewRecord[]> {
  const state = await loadDevState();
  const index = state.savedViews.findIndex((entry) => entry.viewId === view.viewId);
  if (index >= 0) {
    state.savedViews[index] = view;
  } else {
    state.savedViews.push(view);
  }
  await saveDevState(state);
  return state.savedViews;
}

export async function deleteSavedView(viewId: string): Promise<SavedViewRecord[]> {
  const state = await loadDevState();
  state.savedViews = state.savedViews.filter((view) => view.viewId !== viewId);
  await saveDevState(state);
  return state.savedViews;
}

export async function saveCleanupRule(rule: CleanupRuleRecord): Promise<CleanupRuleRecord[]> {
  const state = await loadDevState();
  const index = state.cleanupRules.findIndex((entry) => entry.ruleId === rule.ruleId);
  if (index >= 0) {
    state.cleanupRules[index] = rule;
  } else {
    state.cleanupRules.push(rule);
  }
  await saveDevState(state);
  return state.cleanupRules;
}

export async function deleteCleanupRule(ruleId: string): Promise<CleanupRuleRecord[]> {
  const state = await loadDevState();
  state.cleanupRules = state.cleanupRules.filter((rule) => rule.ruleId !== ruleId);
  await saveDevState(state);
  return state.cleanupRules;
}

export async function createSecureHandoff(
  request: CreateHandoffRequest,
): Promise<HandoffRecord> {
  const artifactPath = request.artifactPath.trim();
  if (!artifactPath || !existsSync(artifactPath)) {
    throw new Error(`Backup artifact ${artifactPath || "(empty path)"} does not exist.`);
  }

  const backupRecord = await previewBackupArtifact({ artifactPath });

  const { artifactName, bytes } = stagePortableArtifactPayload(artifactPath);
  const passphrase = request.passphrase?.trim() || buildHandoffRecoveryPhrase();
  const handoffId = cryptoRandomId();
  const createdAt = new Date().toISOString();
  const salt = randomBytes(16);
  const nonce = randomBytes(12);
  const backupSha256 = sha256Hex(bytes);
  const label = request.label?.trim() || backupRecord.label;
  const header: HandoffHeader = {
    algorithm: HANDOFF_ALGORITHM,
    artifactBytes: bytes.length,
    backupSha256,
    createdAt,
    handoffFormatVersion: HANDOFF_FORMAT_VERSION,
    handoffId,
    kdf: HANDOFF_KDF,
    kdfIterations: HANDOFF_KDF_ITERATIONS,
    label,
    nonceHex: nonce.toString("hex"),
    saltHex: salt.toString("hex"),
    sourceArtifactName: artifactName,
    sourceArtifactPath: artifactPath,
    threadCount: backupRecord.threadCount,
    threaddockVersion: "0.1.0",
    totalRolloutBytes: backupRecord.totalBytes,
  };
  const headerBytes = Buffer.from(JSON.stringify(header), "utf8");
  const ciphertext = encryptHandoffPayload(bytes, passphrase, salt, nonce, headerBytes);
  const destinationDir = request.destinationDir?.trim() || path.dirname(artifactPath);
  await mkdir(destinationDir, { recursive: true });
  const targetPath = nextAvailableHandoffPath(
    destinationDir,
    `${slugify(label)}-${handoffTimestamp(createdAt)}`,
  );
  await writeFile(targetPath, Buffer.concat([HANDOFF_MAGIC, headerBytes, Buffer.from("\n"), ciphertext]));

  return {
    algorithm: HANDOFF_ALGORITHM,
    artifactBytes: bytes.length,
    backupSha256,
    createdAt,
    encryptedBytes: statSync(targetPath).size,
    handoffId,
    kdf: HANDOFF_KDF,
    label,
    originalArtifactName: artifactName,
    recoveryPhrase: passphrase,
    sourceArtifactPath: artifactPath,
    targetPath,
    threadCount: backupRecord.threadCount,
    totalBytes: backupRecord.totalBytes,
  };
}

export async function previewSecureHandoff(
  request: PreviewHandoffRequest,
): Promise<HandoffPreviewRecord> {
  const handoffPath = request.handoffPath.trim();
  const passphrase = request.passphrase.trim();
  if (!handoffPath || !existsSync(handoffPath)) {
    throw new Error(`Secure handoff ${handoffPath || "(empty path)"} does not exist.`);
  }
  if (!passphrase) {
    throw new Error("A recovery phrase or passphrase is required.");
  }

  const { header, plaintext } = await decryptHandoffFile(handoffPath, passphrase);
  const actualSha256 = sha256Hex(plaintext);
  if (actualSha256 !== header.backupSha256) {
    throw new Error("Secure handoff decrypted but failed checksum verification.");
  }
  const handoffId = validatePortableId(header.handoffId, "handoff id");

  await mkdir(DEV_HANDOFF_DIR, { recursive: true });
  const stagedArtifactPath = path.join(
    DEV_HANDOFF_DIR,
    `${handoffId}-preview-${sanitizePortableFileName(header.sourceArtifactName)}`,
  );
  await writeFile(stagedArtifactPath, plaintext);

  try {
    const backupRecord = await previewBackupArtifact({ artifactPath: stagedArtifactPath });
    return {
      algorithm: header.algorithm,
      artifactBytes: header.artifactBytes,
      backupSha256: header.backupSha256,
      createdAt: header.createdAt,
      handoffPath,
      kdf: header.kdf,
      label: header.label,
      originalArtifactName: header.sourceArtifactName,
      threadCount: backupRecord.threadCount,
      threadIds: backupRecord.threadIds,
      totalBytes: backupRecord.totalBytes,
    };
  } finally {
    await rm(stagedArtifactPath, { force: true });
  }
}

export async function importSecureHandoff(
  request: ImportHandoffRequest,
): Promise<ImportHandoffResult> {
  const handoffPath = request.handoffPath.trim();
  const passphrase = request.passphrase.trim();
  if (!handoffPath || !existsSync(handoffPath)) {
    throw new Error(`Secure handoff ${handoffPath || "(empty path)"} does not exist.`);
  }
  if (!passphrase) {
    throw new Error("A recovery phrase or passphrase is required.");
  }

  const { header, plaintext } = await decryptHandoffFile(handoffPath, passphrase);
  const actualSha256 = sha256Hex(plaintext);
  if (actualSha256 !== header.backupSha256) {
    throw new Error("Secure handoff decrypted but failed checksum verification.");
  }
  const handoffId = validatePortableId(header.handoffId, "handoff id");

  await mkdir(DEV_HANDOFF_DIR, { recursive: true });
  const stagedArtifactPath = path.join(
    DEV_HANDOFF_DIR,
    `${handoffId}-${sanitizePortableFileName(header.sourceArtifactName)}`,
  );
  await writeFile(stagedArtifactPath, plaintext);

  try {
    const result = await importBackupArtifact({
      artifactPath: stagedArtifactPath,
      collisionMode: request.collisionMode,
      restoreMode: request.restoreMode,
    });
    return {
      handoffPath,
      importedCount: result.importedCount,
      importedThreadIds: result.importedThreadIds,
      skippedCount: result.skippedCount,
      skippedThreadIds: result.skippedThreadIds,
      stagedArtifactPath,
    };
  } finally {
    await rm(stagedArtifactPath, { force: true });
  }
}

export async function revealPath(targetPath: string): Promise<void> {
  const normalized = targetPath.trim();
  if (!normalized) {
    throw new Error("Path is required.");
  }

  const targetStats = statSync(normalized);
  const isFile = targetStats.isFile();
  const command =
    process.platform === "win32"
      ? {
          file: "explorer.exe",
          args: isFile ? [`/select,"${normalized}"`] : [normalized],
        }
      : process.platform === "darwin"
        ? {
            file: "open",
            args: isFile ? ["-R", normalized] : [normalized],
          }
        : {
            file: "xdg-open",
            args: [isFile ? path.dirname(normalized) : normalized],
          };

  await new Promise<void>((resolve, reject) => {
    const child = spawn(command.file, command.args, {
      detached: true,
      stdio: "ignore",
    });

    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

export async function copyText(value: string): Promise<void> {
  await clipboard.write(value);
}

export async function loadBackupInventory(
  destinationDir?: string | null,
): Promise<BackupInventorySnapshot> {
  const backupDirectory = resolveBackupDirectory(destinationDir);
  await mkdir(backupDirectory, { recursive: true });

  const records: BackupRecord[] = [];
  const issues: BackupInventorySnapshot["issues"] = [];
  for (const entry of readdirSync(backupDirectory, { withFileTypes: true })) {
    const targetPath = path.join(backupDirectory, entry.name);
    try {
      const record = await inspectBackupArtifact(targetPath, entry.isDirectory());
      if (record) {
        records.push(record);
      }
    } catch (error) {
      console.warn(`ThreadDock: failed to inspect backup ${targetPath}`, error);
      issues.push({
        message: error instanceof Error ? error.message : "Failed to inspect backup artifact.",
        path: targetPath,
        severity: "error",
      });
    }
  }

  records.sort((left, right) => {
    return right.createdAt.localeCompare(left.createdAt) || left.label.localeCompare(right.label);
  });

  return {
    backupDirectory,
    issues,
    scannedAt: new Date().toISOString(),
    records,
  };
}

export async function exportBackup(request: BackupExportRequest): Promise<BackupRecord> {
  const snapshot = await loadThreadLibrarySnapshot();
  const backupDirectory = resolveBackupDirectory(request.destinationDir);
  await mkdir(backupDirectory, { recursive: true });

  const threadMap = new Map(snapshot.threads.map((thread) => [thread.threadId, thread] as const));
  const threadIds = [...new Set(request.threadIds)];

  if (threadIds.length === 0) {
    throw new Error("Select at least one thread before exporting a backup.");
  }

  const threads = threadIds.map((threadId) => {
    const thread = threadMap.get(threadId);
    if (!thread) {
      throw new Error(`Thread ${threadId} is no longer available for export.`);
    }

    return thread;
  });

  const label = buildBackupLabel(request.mode, request.families ?? [], threads);
  const createdAt = new Date().toISOString();
  const baseName = `${slugify(label)}-${timestampSlug(createdAt)}`;
  const format = request.format === "folder" ? "folder" : "zip";
  const targetPath = nextAvailablePath(backupDirectory, baseName, format);
  const files: BackupManifest["files"] = [];

  for (const thread of threads) {
    if (!existsSync(thread.rolloutPath)) {
      throw new Error(`Thread ${thread.threadId} does not have a readable rollout file on disk.`);
    }

    const bytes = await readFile(thread.rolloutPath);
    const archivePath = `threads/${thread.threadId}.jsonl`;
    files.push({
      threadId: thread.threadId,
      archivePath,
      rolloutBytes: bytes.byteLength,
      sha256: sha256Hex(bytes),
    });
  }

  const families = buildFamilyMetadata(request.families ?? [], threadMap);
  const familyRoots = families.flatMap((family) =>
    family.rootThreadId ? [family.rootThreadId] : [],
  );
  const totalBytes = files.reduce((total, file) => total + file.rolloutBytes, 0);
  const manifest: BackupManifest = {
    backupFormatVersion: BACKUP_FORMAT_VERSION,
    createdAt,
    threaddockVersion: "0.1.0",
    label,
    mode: request.mode,
    sourceCodexHome: snapshot.codexHome,
    exportedThreadIds: threadIds,
    exportedFamilyRoots: familyRoots,
    totalRolloutBytes: totalBytes,
    files,
  };

  const artifactBytes =
    format === "zip"
      ? await writeZipBackup(targetPath, threads, families, manifest)
      : await writeFolderBackup(targetPath, threads, families, manifest);

  const record = {
    artifactBytes,
    backupId: backupIdFromPath(targetPath, format),
    createdAt,
    familyMode: request.mode === "family",
    familyRoots,
    format,
    label,
    manifestVersion: BACKUP_FORMAT_VERSION,
    sourceCodexHome: snapshot.codexHome,
    targetPath,
    threadCount: threadIds.length,
    threadIds,
    totalBytes,
  };

  await appendActivity({
    artifactPath: targetPath,
    createdAt,
    detail: `Exported ${threadIds.length} thread${threadIds.length === 1 ? "" : "s"} as a ${format} backup artifact.`,
    kind: "backup",
    label,
    scope: request.mode === "family" ? "family" : threadIds.length > 1 ? "threads" : "thread",
    status: "success",
    threadIds,
  });

  return record;
}

export async function importBackupArtifact(
  request: BackupImportRequest,
): Promise<BackupImportResult> {
  const snapshot = await loadThreadLibrarySnapshot();
  const artifactPath = request.artifactPath.trim();
  if (!artifactPath || !existsSync(artifactPath)) {
    throw new Error(`Backup artifact ${artifactPath || "(empty path)"} does not exist.`);
  }

  const verifiedThreads = await readVerifiedImportThreadsFromArtifact(artifactPath);
  const existing = new Map(snapshot.threads.map((thread) => [thread.threadId, thread] as const));
  const importedThreadIds: string[] = [];
  const skippedThreadIds: string[] = [];
  const stagedTempPaths: string[] = [];
  const plans: Array<{
    destinationPath: string;
    existingPath: string | null;
    tempPath: string;
    threadId: string;
  }> = [];

  try {
    for (const verified of verifiedThreads) {
      const { thread } = verified;
      validateSafeComponent(thread.threadId, "thread id");
      const current = existing.get(thread.threadId);

      if (current && request.collisionMode === "skip") {
        skippedThreadIds.push(thread.threadId);
        continue;
      }
      if (current?.readOnly) {
        throw new Error(`Thread ${current.threadId} is read-only and cannot be replaced.`);
      }

      const existingPath = current?.rolloutPath && existsSync(current.rolloutPath)
        ? current.rolloutPath
        : null;
      let destinationPath = importDestinationPath(
        snapshot.codexHome,
        thread,
        request.restoreMode,
      );
      ensurePathUnder(snapshot.codexHome, destinationPath, "import destination");

      if (
        existsSync(destinationPath) &&
        (!existingPath || !samePathText(existingPath, destinationPath))
      ) {
        destinationPath = nextAvailableFilePath(destinationPath);
        ensurePathUnder(snapshot.codexHome, destinationPath, "import destination");
      }

      await mkdir(path.dirname(destinationPath), { recursive: true });
      const tempPath = nextAvailableFilePath(
        path.join(
          path.dirname(destinationPath),
          `.threaddock-import-${slugify(thread.threadId)}-${cryptoRandomId()}.tmp`,
        ),
      );
      await writeFile(tempPath, verified.bytes);
      const stagedBytes = new Uint8Array(await readFile(tempPath));
      if (sha256Hex(stagedBytes) !== sha256Hex(verified.bytes)) {
        throw new Error(`Staged bytes for thread ${thread.threadId} failed checksum verification.`);
      }

      stagedTempPaths.push(tempPath);
      plans.push({
        destinationPath,
        existingPath,
        tempPath,
        threadId: thread.threadId,
      });
    }
  } catch (error) {
    await cleanupTempFiles(stagedTempPaths);
    throw error;
  }

  for (const plan of plans) {
    let replacementBackupPath: string | null = null;
    if (plan.existingPath && existsSync(plan.existingPath)) {
      replacementBackupPath = nextAvailableFilePath(
        path.join(
          path.dirname(plan.existingPath),
          `.threaddock-replace-${cryptoRandomId()}-${path.basename(plan.existingPath)}`,
        ),
      );
      await rename(plan.existingPath, replacementBackupPath);
    }

    try {
      if (existsSync(plan.destinationPath)) {
        throw new Error(`Import destination ${plan.destinationPath} already exists.`);
      }
      await rename(plan.tempPath, plan.destinationPath);
    } catch (error) {
      if (replacementBackupPath && plan.existingPath) {
        try {
          await rename(replacementBackupPath, plan.existingPath);
        } catch (restoreError) {
          console.error("ThreadDock: failed to roll back replacement", restoreError);
        }
      }
      await rm(plan.tempPath, { force: true });
      throw error;
    }

    if (replacementBackupPath) {
      await rm(replacementBackupPath, { force: true });
    }
    importedThreadIds.push(plan.threadId);
  }

  await appendActivity({
    artifactPath,
    createdAt: new Date().toISOString(),
    detail: `Imported ${importedThreadIds.length} thread${importedThreadIds.length === 1 ? "" : "s"} from ${artifactPath}.`,
    kind: "import",
    label: "Backup import",
    scope: importedThreadIds.length > 1 ? "threads" : "thread",
    status: "success",
    threadIds: importedThreadIds,
  });

  return {
    artifactPath,
    importedCount: importedThreadIds.length,
    importedThreadIds,
    skippedCount: skippedThreadIds.length,
    skippedThreadIds,
  };
}

export async function previewBackupArtifact(
  request: BackupPreviewRequest,
): Promise<BackupRecord> {
  const artifactPath = request.artifactPath.trim();
  if (!artifactPath || !existsSync(artifactPath)) {
    throw new Error(`Backup artifact ${artifactPath || "(empty path)"} does not exist.`);
  }

  const stats = statSync(artifactPath);
  const record = await inspectBackupArtifact(artifactPath, stats.isDirectory());
  if (!record) {
    throw new Error(`${artifactPath} is not a ThreadDock backup artifact.`);
  }
  const verifiedThreads = await readVerifiedImportThreadsFromArtifact(artifactPath);
  if (verifiedThreads.length !== record.threadCount) {
    throw new Error(
      `Backup preview mismatch: manifest lists ${record.threadCount} thread(s) but ${verifiedThreads.length} payload(s) verified.`,
    );
  }
  return record;
}

function stagePortableArtifactPayload(artifactPath: string): { artifactName: string; bytes: Buffer } {
  const stats = statSync(artifactPath);
  if (stats.isFile()) {
    return {
      artifactName: path.basename(artifactPath),
      bytes: readFileSync(artifactPath),
    };
  }

  if (!stats.isDirectory()) {
    throw new Error(`Backup artifact ${artifactPath} is not a readable file or directory.`);
  }

  const entries: Record<string, Uint8Array> = {};
  collectPortableZipEntries(artifactPath, artifactPath, entries);
  return {
    artifactName: `${path.basename(artifactPath)}.zip`,
    bytes: Buffer.from(zipSync(entries, { level: 9 })),
  };
}

function collectPortableZipEntries(
  root: string,
  current: string,
  entries: Record<string, Uint8Array>,
) {
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const targetPath = path.join(current, entry.name);
    const relativePath = path.relative(root, targetPath).replaceAll("\\", "/");
    if (entry.isDirectory()) {
      collectPortableZipEntries(root, targetPath, entries);
      continue;
    }
    entries[relativePath] = new Uint8Array(readFileSync(targetPath));
  }
}

function encryptHandoffPayload(
  payload: Buffer,
  passphrase: string,
  salt: Buffer,
  nonce: Buffer,
  aad: Buffer,
): Buffer {
  const key = deriveHandoffKey(passphrase, salt);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(aad);
  return Buffer.concat([cipher.update(payload), cipher.final(), cipher.getAuthTag()]);
}

async function decryptHandoffFile(
  targetPath: string,
  passphrase: string,
): Promise<{ header: HandoffHeader; plaintext: Buffer }> {
  const bytes = await readFile(targetPath);
  if (!bytes.subarray(0, HANDOFF_MAGIC.length).equals(HANDOFF_MAGIC)) {
    throw new Error(`${targetPath} is not a ThreadDock secure handoff.`);
  }
  const payload = bytes.subarray(HANDOFF_MAGIC.length);
  const headerEnd = payload.indexOf(0x0a);
  if (headerEnd < 0) {
    throw new Error("Secure handoff header is malformed.");
  }
  const headerBytes = payload.subarray(0, headerEnd);
  const header = JSON.parse(headerBytes.toString("utf8")) as HandoffHeader;
  if (
    header.handoffFormatVersion !== HANDOFF_FORMAT_VERSION ||
    header.algorithm !== HANDOFF_ALGORITHM ||
    header.kdf !== HANDOFF_KDF ||
    header.kdfIterations !== HANDOFF_KDF_ITERATIONS
  ) {
    throw new Error("Unsupported secure handoff encryption settings.");
  }
  const ciphertext = payload.subarray(headerEnd + 1);
  if (ciphertext.length < 17) {
    throw new Error("Secure handoff payload is malformed.");
  }
  const encrypted = ciphertext.subarray(0, ciphertext.length - 16);
  const tag = ciphertext.subarray(ciphertext.length - 16);
  const salt = Buffer.from(header.saltHex, "hex");
  const nonce = Buffer.from(header.nonceHex, "hex");
  if (salt.length !== 16 || nonce.length !== 12) {
    throw new Error("Secure handoff encryption parameters are malformed.");
  }
  const key = deriveHandoffKey(passphrase, salt);
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAAD(headerBytes);
  decipher.setAuthTag(tag);
  try {
    return {
      header,
      plaintext: Buffer.concat([decipher.update(encrypted), decipher.final()]),
    };
  } catch {
    throw new Error("Recovery phrase rejected or secure handoff is corrupted.");
  }
}

function deriveHandoffKey(passphrase: string, salt: Buffer): Buffer {
  return pbkdf2Sync(passphrase, salt, HANDOFF_KDF_ITERATIONS, 32, "sha256");
}

function buildHandoffRecoveryPhrase(): string {
  const raw = randomBytes(16).toString("hex").toUpperCase();
  return raw.match(/.{1,4}/g)?.join("-") ?? raw;
}

function sanitizePortableFileName(value: string): string {
  const sanitized = value
    .split("")
    .map((character) =>
      /[A-Za-z0-9._-]/.test(character) ? character : "_",
    )
    .join("");
  return sanitized || "received.threaddock-backup.zip";
}

function sanitizeFileComponent(value: string): string {
  const sanitized = value
    .split("")
    .map((character) =>
      /[A-Za-z0-9._-]/.test(character) ? character : "_",
    )
    .join("")
    .replace(/^[._]+|[._]+$/g, "");
  return sanitized || "restored-thread.jsonl";
}

function validatePortableId(value: string, label: string): string {
  if (/^[A-Fa-f0-9-]{16,64}$/.test(value) && !value.includes("..")) {
    return value;
  }
  throw new Error(`Secure handoff header contains an invalid ${label}.`);
}

function detectCodexHome(preferences: AppPreferences): string {
  const overridePath = preferences.codexHomeOverride?.trim();
  if (overridePath && existsSync(overridePath)) {
    return overridePath;
  }

  const envHome = process.env.CODEX_HOME;
  if (envHome && existsSync(envHome)) {
    return envHome;
  }

  const fallback = path.join(os.homedir(), ".codex");
  if (!existsSync(fallback)) {
    throw new Error(`No Codex home found. Looked for ${fallback}.`);
  }

  return fallback;
}

async function loadSessionIndex(codexHome: string): Promise<Map<string, IndexRecord>> {
  const indexPath = path.join(codexHome, "session_index.jsonl");
  const index = new Map<string, IndexRecord>();

  try {
    await access(indexPath);
  } catch {
    return index;
  }

  const contents = await readFile(indexPath, "utf8");
  for (const line of contents.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }

    try {
      const record = JSON.parse(line) as IndexRecord;
      index.set(record.id, record);
    } catch (error) {
      console.warn("ThreadDock: failed to parse session index entry", error);
    }
  }

  return index;
}

function scanRollouts(
  root: string,
  status: ThreadStatus,
  index: Map<string, IndexRecord>,
  readOnly: boolean,
): ScanResult {
  if (!existsSync(root)) {
    return { threads: [], issues: [] };
  }

  const threads: ThreadRecord[] = [];
  const issues: ScanIssue[] = [];
  const stack = [root];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }

    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);

      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }

      if (!entry.isFile() || path.extname(entry.name) !== ".jsonl") {
        continue;
      }

      try {
        const session = readSessionMeta(fullPath);
        const stats = statSync(fullPath);
        const indexRecord = index.get(session.id);
        const fallbackTitle = path.basename(entry.name, ".jsonl");

        threads.push({
          threadId: session.id,
          title: pickTitle(indexRecord?.thread_name, fallbackTitle),
          status,
          threadSource: normalizeThreadSource(session.thread_source),
          readOnly,
          parentThreadId:
            session.source?.subagent?.thread_spawn?.parent_thread_id ?? null,
          cwd: session.cwd ?? null,
          rolloutPath: fullPath,
          createdAt: session.timestamp ?? null,
          updatedAt: indexRecord?.updated_at ?? modifiedTimeToIso(fullPath),
          rawRolloutBytes: stats.size,
        });
      } catch (error) {
        issues.push({
          kind: "malformed_rollout",
          severity: "warning",
          message:
            error instanceof Error
              ? error.message
              : `Failed to read rollout metadata for ${fullPath}.`,
          path: fullPath,
          threadId: null,
        });
        console.warn(`ThreadDock: failed to read rollout metadata for ${fullPath}`, error);
      }
    }
  }

  return { threads, issues };
}

function readSessionMeta(filePath: string): SessionPayload {
  const firstLine = readFirstLine(filePath);
  const parsed = JSON.parse(firstLine) as SessionLine;

  if (parsed.type !== "session_meta") {
    throw new Error(`First line in ${filePath} is not session metadata.`);
  }

  return parsed.payload;
}

async function listAppServerThreads(archived: boolean): Promise<AppServerThread[]> {
  const threads: AppServerThread[] = [];
  let cursor: string | undefined;

  for (;;) {
    const result = await callAppServer<AppServerThreadListResponse>("thread/list", {
      archived,
      limit: 200,
      ...(cursor ? { cursor } : {}),
    } satisfies ThreadListParams);

    threads.push(...result.data);

    if (!result.nextCursor) {
      return threads;
    }

    cursor = result.nextCursor;
  }
}

async function loadAppServerThreads(): Promise<AppServerLoad> {
  const entries: AppThreadEntry[] = [];
  const failures: string[] = [];

  const [activeThreads, archivedThreads] = await Promise.all([
    listAppServerThreads(false).catch((error) => {
      console.warn("ThreadDock: failed to load active app-server threads", error);
      failures.push(
        `Active threads: ${error instanceof Error ? error.message : "Unknown app-server error."}`,
      );
      return [];
    }),
    listAppServerThreads(true).catch((error) => {
      console.warn("ThreadDock: failed to load archived app-server threads", error);
      failures.push(
        `Archived threads: ${error instanceof Error ? error.message : "Unknown app-server error."}`,
      );
      return [];
    }),
  ]);

  entries.push(
    ...activeThreads.map((thread) => ({ status: "active" as const, thread })),
    ...archivedThreads.map((thread) => ({ status: "archived" as const, thread })),
  );

  return {
    entries,
    status: {
      available: failures.length === 0,
      message: failures.length > 0 ? failures.join(" | ") : null,
    },
  };
}

async function ensureThreadMutable(threadId: string): Promise<void> {
  const snapshot = await loadThreadLibrarySnapshot();
  const thread = snapshot.threads.find((candidate) => candidate.threadId === threadId);

  if (!thread) {
    throw new Error(`Thread ${threadId} is no longer available.`);
  }

  if (thread.readOnly) {
    throw new Error(
      `Thread ${threadId} comes from a read-only archive path and cannot be changed through ThreadDock.`,
    );
  }

  if (!snapshot.appServer.available) {
    throw new Error(
      snapshot.appServer.message ??
        "Codex App Server is unavailable, so lifecycle actions are currently read-only.",
    );
  }
}

async function callAppServer<T>(method: string, params: object): Promise<T> {
  const child = spawnAppServer();
  const requestId = 2;
  const stderrChunks: string[] = [];

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const reader = createInterface({
      input: child.stdout,
      crlfDelay: Number.POSITIVE_INFINITY,
    });

    const finish = (callback: () => void) => {
      if (settled) {
        return;
      }

      settled = true;
      reader.close();
      child.stdin.end();
      setTimeout(() => {
        if (!child.killed) {
          child.kill();
        }
      }, 250).unref();
      callback();
    };

    child.stderr.on("data", (chunk) => {
      stderrChunks.push(chunk.toString("utf8"));
    });

    reader.on("line", (line: string) => {
      if (!line.trim()) {
        return;
      }

      let message: JsonRpcResponse<T>;
      try {
        message = JSON.parse(line) as JsonRpcResponse<T>;
      } catch {
        return;
      }

      if (message.id !== requestId) {
        return;
      }

      if (message.error) {
        const error = message.error;
        finish(() =>
          reject(
            new Error(
              `Codex App Server ${method} failed: ${error.message}${formatStderr(stderrChunks)}`,
            ),
          ),
        );
        return;
      }

      finish(() => {
        if (message.result === undefined) {
          reject(new Error(`Codex App Server ${method} returned no result.`));
          return;
        }

        resolve(message.result);
      });
    });

    child.once("error", (error) => {
      finish(() => reject(error));
    });

    child.once("exit", (code) => {
      if (!settled) {
        reject(
          new Error(
            `Codex App Server ${method} exited before returning a response (exit ${code ?? "unknown"}).${formatStderr(stderrChunks)}`,
          ),
        );
      }
    });

    child.stdin.write(
      `${JSON.stringify({
        id: 1,
        method: "initialize",
        params: {
          clientInfo: {
            name: "ThreadDock",
            version: "0.1.0",
          },
          capabilities: null,
        },
      })}\n`,
    );
    child.stdin.write(`${JSON.stringify({ id: requestId, method, params })}\n`);
  });
}

function spawnAppServer() {
  const environment = { ...process.env };
  try {
    const payload = JSON.parse(readFileSync(DEV_STATE_PATH, "utf8")) as Partial<DevStateFile>;
    const overridePath = payload.preferences?.codexHomeOverride?.trim();
    if (overridePath) {
      environment.CODEX_HOME = overridePath;
    }
  } catch {
    // Ignore missing or unreadable preview state files.
  }

  if (process.platform === "win32") {
    const codexCmd = process.env.APPDATA
      ? path.join(process.env.APPDATA, "npm", "codex.cmd")
      : "codex.cmd";

    return spawn("cmd.exe", ["/d", "/c", codexCmd, "app-server"], {
      cwd: process.cwd(),
      env: environment,
      stdio: ["pipe", "pipe", "pipe"],
    });
  }

  return spawn("codex", ["app-server"], {
    cwd: process.cwd(),
    env: environment,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function mergeThreads(
  scannedThreads: Map<string, ThreadRecord>,
  scanIssues: ScanIssue[],
  appThreadEntries: AppThreadEntry[],
): ThreadRecord[] {
  const merged = new Map(scannedThreads);

  for (const entry of appThreadEntries) {
    const existing = merged.get(entry.thread.id);
    const fileSize = entry.thread.path ? safeFileSize(entry.thread.path) : 0;
    const rolloutPath =
      pickNullable(entry.thread.path, existing?.rolloutPath) ?? "Not materialized on disk";
    const mergedThread = {
      threadId: entry.thread.id,
      title: pickTitle(entry.thread.name, existing?.title, summarizePreview(entry.thread.preview)),
      status: entry.status,
      threadSource: existing?.threadSource ?? normalizeThreadSource(entry.thread.threadSource),
      readOnly: false,
      parentThreadId: existing?.parentThreadId ?? null,
      cwd: pickNullable(entry.thread.cwd, existing?.cwd),
      rolloutPath,
      createdAt: unixSecondsToIso(entry.thread.createdAt) ?? existing?.createdAt ?? null,
      updatedAt: unixSecondsToIso(entry.thread.updatedAt) ?? existing?.updatedAt ?? null,
      rawRolloutBytes: existing?.rawRolloutBytes ?? fileSize,
    } satisfies ThreadRecord;

    if (mergedThread.rolloutPath === "Not materialized on disk" || !existsSync(mergedThread.rolloutPath)) {
      scanIssues.push({
        kind: "missing_rollout",
        severity: "warning",
        message: `Thread ${mergedThread.threadId} is present in the App Server index but the rollout file is not readable on disk.`,
        path: mergedThread.rolloutPath === "Not materialized on disk" ? null : mergedThread.rolloutPath,
        threadId: mergedThread.threadId,
      });
    }

    merged.set(entry.thread.id, mergedThread);
  }

  return [...merged.values()].sort((left, right) => {
    return (
      compareDates(right.updatedAt, left.updatedAt) ||
      compareDates(right.createdAt, left.createdAt) ||
      left.title.localeCompare(right.title)
    );
  });
}

function normalizeThreadSource(source: ThreadSource | string | undefined | null): ThreadSource {
  if (source === "user" || source === "subagent") {
    return source;
  }

  return "unknown";
}

function pickTitle(...candidates: Array<string | undefined | null>): string {
  for (const candidate of candidates) {
    if (candidate?.trim()) {
      return candidate.trim();
    }
  }

  return "Untitled thread";
}

function pickNullable(...candidates: Array<string | undefined | null>): string | null {
  for (const candidate of candidates) {
    if (candidate?.trim()) {
      return candidate;
    }
  }

  return null;
}

function summarizePreview(preview: string): string {
  const compact = preview.replace(/\s+/g, " ").trim();
  if (!compact) {
    return "Untitled thread";
  }

  return compact.length > 88 ? `${compact.slice(0, 85)}...` : compact;
}

function unixSecondsToIso(seconds: number | null | undefined): string | null {
  if (typeof seconds !== "number") {
    return null;
  }

  return new Date(seconds * 1000).toISOString();
}

function modifiedTimeToIso(filePath: string): string | null {
  try {
    return statSync(filePath).mtime.toISOString();
  } catch {
    return null;
  }
}

function safeFileSize(filePath: string): number {
  try {
    return statSync(filePath).size;
  } catch {
    return 0;
  }
}

function readFirstLine(filePath: string): string {
  const descriptor = openSync(filePath, "r");
  const buffer = Buffer.alloc(4096);
  let line = "";

  try {
    for (;;) {
      const bytesRead = readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead === 0) {
        break;
      }

      line += buffer.toString("utf8", 0, bytesRead);
      const newlineIndex = line.indexOf("\n");
      if (newlineIndex >= 0) {
        return line.slice(0, newlineIndex).replace(/\r$/, "");
      }
    }
  } finally {
    closeSync(descriptor);
  }

  const trimmed = line.replace(/\r$/, "");
  if (!trimmed) {
    throw new Error(`Session file is empty: ${filePath}`);
  }

  return trimmed;
}

function compareDates(left: string | null, right: string | null): number {
  if (left === right) {
    return 0;
  }

  if (!left) {
    return -1;
  }

  if (!right) {
    return 1;
  }

  return left.localeCompare(right);
}

function formatStderr(stderrChunks: string[]): string {
  const stderr = stderrChunks.join("").trim();
  return stderr ? `\n${stderr}` : "";
}

function buildFamilyMetadata(
  families: BackupFamilyDescriptor[],
  threadMap: Map<string, ThreadRecord>,
): BackupFamilyMetadata[] {
  return families.map((family) => ({
    familyId: family.familyId,
    rootThreadId: family.rootThreadId,
    label: family.label,
    threadIds: family.threadIds,
    totalRolloutBytes: family.threadIds.reduce((total, threadId) => {
      return total + (threadMap.get(threadId)?.rawRolloutBytes ?? 0);
    }, 0),
    orphaned: family.orphaned,
  }));
}

function buildBackupLabel(
  mode: BackupExportMode,
  families: BackupFamilyDescriptor[],
  threads: ThreadRecord[],
): string {
  if (mode === "family") {
    const family = families[0];
    return family ? `${family.label.trim()} family` : `${threads.length}-thread family export`;
  }

  return threads.length === 1 ? `${threads[0].title.trim()} thread` : `${threads.length} selected threads`;
}

function resolveBackupDirectory(destinationDir?: string | null): string {
  const trimmed = destinationDir?.trim();
  if (trimmed) {
    return trimmed;
  }

  const documentsDir = path.join(os.homedir(), "Documents");
  const baseDir = existsSync(documentsDir) ? documentsDir : os.homedir();
  return path.join(baseDir, "ThreadDock Backups");
}

function nextAvailablePath(
  backupDirectory: string,
  baseName: string,
  format: BackupArtifactFormat,
): string {
  const extension = format === "folder" ? BACKUP_FOLDER_EXTENSION : BACKUP_EXTENSION;
  const targetPath = path.join(backupDirectory, `${baseName}${extension}`);
  if (!existsSync(targetPath)) {
    return targetPath;
  }

  let index = 2;

  for (;;) {
    const candidate = path.join(backupDirectory, `${baseName}-${index}${extension}`);
    if (!existsSync(candidate)) {
      return candidate;
    }

    index += 1;
  }
}

function nextAvailableHandoffPath(backupDirectory: string, baseName: string): string {
  const targetPath = path.join(backupDirectory, `${baseName}${HANDOFF_EXTENSION}`);
  if (!existsSync(targetPath)) {
    return targetPath;
  }

  let index = 2;
  for (;;) {
    const candidate = path.join(backupDirectory, `${baseName}-${index}${HANDOFF_EXTENSION}`);
    if (!existsSync(candidate)) {
      return candidate;
    }
    index += 1;
  }
}

async function readManifestFromZip(targetPath: string): Promise<BackupManifest> {
  const archive = unzipSync(new Uint8Array(await readFile(targetPath)));
  const manifestBytes = archive["manifest.json"];

  if (!manifestBytes) {
    throw new Error(`Backup ${targetPath} is missing manifest.json.`);
  }

  return JSON.parse(strFromU8(manifestBytes)) as BackupManifest;
}

async function readManifestFromFolder(targetPath: string): Promise<BackupManifest> {
  return JSON.parse(
    await readFile(path.join(targetPath, "manifest.json"), "utf8"),
  ) as BackupManifest;
}

async function inspectBackupArtifact(
  targetPath: string,
  isDirectory: boolean,
): Promise<BackupRecord | null> {
  if (isDirectory) {
    if (!targetPath.endsWith(BACKUP_FOLDER_EXTENSION)) {
      return null;
    }

    const manifest = await readManifestFromFolder(targetPath);
    return recordFromManifest(manifest, targetPath, await directorySize(targetPath), "folder");
  }

  if (!targetPath.endsWith(BACKUP_EXTENSION)) {
    return null;
  }

  const manifest = await readManifestFromZip(targetPath);
  return recordFromManifest(manifest, targetPath, statSync(targetPath).size, "zip");
}

async function readVerifiedImportThreadsFromArtifact(
  targetPath: string,
): Promise<VerifiedImportThread[]> {
  const manifest = statSync(targetPath).isDirectory()
    ? await readManifestFromFolder(targetPath)
    : await readManifestFromZip(targetPath);
  validateBackupManifest(manifest);

  const payloads = await readThreadPayloadsFromArtifact(targetPath);
  const payloadsById = new Map(payloads.map((thread) => [thread.threadId, thread] as const));
  const expectedIds = new Set(manifest.exportedThreadIds);

  if (payloadsById.size !== expectedIds.size) {
    throw new Error("Backup metadata does not match the manifest thread count.");
  }
  for (const threadId of payloadsById.keys()) {
    if (!expectedIds.has(threadId)) {
      throw new Error(`Backup metadata contains unexpected thread id ${threadId}.`);
    }
  }

  const verifiedThreads: VerifiedImportThread[] = [];
  for (const file of manifest.files) {
    const thread = payloadsById.get(file.threadId);
    if (!thread) {
      throw new Error(`Backup metadata is missing thread ${file.threadId}.`);
    }

    const bytes = await readArtifactEntry(targetPath, file.archivePath);
    if (bytes.byteLength !== file.rolloutBytes) {
      throw new Error(`Backup payload ${file.archivePath} has an unexpected byte length.`);
    }
    if (sha256Hex(bytes) !== file.sha256) {
      throw new Error(`Backup payload ${file.archivePath} failed checksum verification.`);
    }
    verifiedThreads.push({ bytes, thread });
  }

  return verifiedThreads;
}

async function readThreadPayloadsFromArtifact(targetPath: string): Promise<ThreadRecord[]> {
  const payload = await readArtifactEntry(targetPath, "metadata/threads.json");
  return JSON.parse(strFromU8(payload)) as ThreadRecord[];
}

async function readArtifactEntry(targetPath: string, archivePath: string): Promise<Uint8Array> {
  validateArchivePath(archivePath);
  if (statSync(targetPath).isDirectory()) {
    return new Uint8Array(await readFile(safeArtifactPath(targetPath, archivePath)));
  }

  const archive = unzipSync(new Uint8Array(await readFile(targetPath)));
  const payload = archive[archivePath];
  if (!payload) {
    throw new Error(`Backup ${targetPath} is missing ${archivePath}.`);
  }
  return payload;
}

function importDestinationPath(
  codexHome: string,
  thread: ThreadRecord,
  restoreMode: BackupImportRequest["restoreMode"],
): string {
  const fileName = sanitizeFileComponent(path.basename(thread.rolloutPath || `${thread.threadId}.jsonl`));
  if (restoreMode === "preserve_status" && thread.status === "active") {
    const date = thread.createdAt ? new Date(thread.createdAt) : new Date();
    return path.join(
      codexHome,
      "sessions",
      String(date.getUTCFullYear()).padStart(4, "0"),
      String(date.getUTCMonth() + 1).padStart(2, "0"),
      String(date.getUTCDate()).padStart(2, "0"),
      fileName,
    );
  }

  return path.join(codexHome, "archived_sessions", fileName);
}

function recordFromManifest(
  manifest: BackupManifest,
  targetPath: string,
  artifactBytes: number,
  format: BackupArtifactFormat,
): BackupRecord {
  return {
    artifactBytes,
    backupId: backupIdFromPath(targetPath, format),
    createdAt: manifest.createdAt,
    familyMode: manifest.mode === "family",
    familyRoots: manifest.exportedFamilyRoots,
    format,
    label: manifest.label,
    manifestVersion: manifest.backupFormatVersion,
    sourceCodexHome: manifest.sourceCodexHome,
    targetPath,
    threadCount: manifest.exportedThreadIds.length,
    threadIds: manifest.exportedThreadIds,
    totalBytes: manifest.totalRolloutBytes,
  };
}

function validateBackupManifest(manifest: BackupManifest): void {
  if (manifest.backupFormatVersion !== BACKUP_FORMAT_VERSION) {
    throw new Error(`Unsupported backup format version ${manifest.backupFormatVersion}.`);
  }
  if (manifest.files.length !== manifest.exportedThreadIds.length) {
    throw new Error("Backup manifest file list does not match exported thread ids.");
  }

  const exportedIds = new Set<string>();
  for (const threadId of manifest.exportedThreadIds) {
    validateSafeComponent(threadId, "thread id");
    if (exportedIds.has(threadId)) {
      throw new Error(`Backup manifest contains duplicate thread id ${threadId}.`);
    }
    exportedIds.add(threadId);
  }

  const fileIds = new Set<string>();
  let totalBytes = 0;
  for (const file of manifest.files) {
    validateSafeComponent(file.threadId, "thread id");
    if (!exportedIds.has(file.threadId)) {
      throw new Error(`Backup manifest contains payload for unexpected thread id ${file.threadId}.`);
    }
    if (fileIds.has(file.threadId)) {
      throw new Error(`Backup manifest contains duplicate payload for thread id ${file.threadId}.`);
    }
    fileIds.add(file.threadId);

    const expectedArchivePath = `threads/${file.threadId}.jsonl`;
    if (file.archivePath !== expectedArchivePath) {
      throw new Error(`Backup manifest path for thread ${file.threadId} is invalid.`);
    }
    validateArchivePath(file.archivePath);
    if (!/^[a-fA-F0-9]{64}$/.test(file.sha256)) {
      throw new Error(`Backup manifest checksum for thread ${file.threadId} is malformed.`);
    }
    totalBytes += file.rolloutBytes;
  }

  if (totalBytes !== manifest.totalRolloutBytes) {
    throw new Error("Backup manifest total rollout bytes do not match payload entries.");
  }
}

function validateSafeComponent(value: string, label: string): void {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`Backup ${label} cannot be empty.`);
  }
  if (trimmed === "." || trimmed === ".." || trimmed.length > 256) {
    throw new Error(`Backup ${label} is not a safe path component.`);
  }
  if (/[/\\\x00-\x1F\x7F]/.test(trimmed)) {
    throw new Error(`Backup ${label} contains unsafe path characters.`);
  }
}

function validateArchivePath(archivePath: string): void {
  const normalized = archivePath.replaceAll("\\", "/");
  if (!normalized.trim()) {
    throw new Error("Backup archive path cannot be empty.");
  }
  for (const component of normalized.split("/")) {
    validateSafeComponent(component, "archive path component");
  }
}

function safeArtifactPath(root: string, archivePath: string): string {
  validateArchivePath(archivePath);
  const candidate = path.resolve(root, ...archivePath.replaceAll("\\", "/").split("/"));
  const rootPath = path.resolve(root);
  ensurePathUnder(rootPath, candidate, "backup archive path");
  if (existsSync(candidate)) {
    ensurePathUnder(realpathSync(rootPath), realpathSync(candidate), "backup archive path");
  }
  return candidate;
}

function ensurePathUnder(root: string, targetPath: string, label: string): void {
  const rootPath = path.resolve(root);
  const resolved = path.resolve(targetPath);
  const relative = path.relative(rootPath, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${label} ${targetPath} escapes ${root}.`);
  }
}

function samePathText(left: string, right: string): boolean {
  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

function nextAvailableFilePath(targetPath: string): string {
  if (!existsSync(targetPath)) {
    return targetPath;
  }

  const parsed = path.parse(targetPath);
  let index = 2;
  for (;;) {
    const candidate = path.join(parsed.dir, `${parsed.name}-${index}${parsed.ext}`);
    if (!existsSync(candidate)) {
      return candidate;
    }
    index += 1;
  }
}

async function cleanupTempFiles(paths: string[]): Promise<void> {
  for (const tempPath of paths) {
    await rm(tempPath, { force: true });
  }
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function writeZipBackup(
  targetPath: string,
  threads: ThreadRecord[],
  families: BackupFamilyMetadata[],
  manifest: BackupManifest,
): Promise<number> {
  const zipEntries: Record<string, Uint8Array> = {};

  for (const thread of threads) {
    zipEntries[`threads/${thread.threadId}.jsonl`] = new Uint8Array(
      await readFile(thread.rolloutPath),
    );
  }

  zipEntries["manifest.json"] = strToU8(JSON.stringify(manifest, null, 2));
  zipEntries["metadata/threads.json"] = strToU8(JSON.stringify(threads, null, 2));
  zipEntries["metadata/families.json"] = strToU8(JSON.stringify(families, null, 2));

  const archive = zipSync(zipEntries, { level: 9 });
  await writeFile(targetPath, archive);
  verifyZipBackupArtifact(archive, manifest);
  return archive.byteLength;
}

async function writeFolderBackup(
  targetPath: string,
  threads: ThreadRecord[],
  families: BackupFamilyMetadata[],
  manifest: BackupManifest,
): Promise<number> {
  await mkdir(path.join(targetPath, "threads"), { recursive: true });
  await mkdir(path.join(targetPath, "metadata"), { recursive: true });

  for (const thread of threads) {
    await writeFile(
      path.join(targetPath, "threads", `${thread.threadId}.jsonl`),
      await readFile(thread.rolloutPath),
    );
  }

  await writeFile(path.join(targetPath, "manifest.json"), JSON.stringify(manifest, null, 2));
  await writeFile(
    path.join(targetPath, "metadata", "threads.json"),
    JSON.stringify(threads, null, 2),
  );
  await writeFile(
    path.join(targetPath, "metadata", "families.json"),
    JSON.stringify(families, null, 2),
  );

  await verifyFolderBackupArtifact(targetPath, manifest);
  return directorySize(targetPath);
}

function verifyZipBackupArtifact(archiveBytes: Uint8Array, manifest: BackupManifest) {
  const archive = unzipSync(archiveBytes);

  for (const file of manifest.files) {
    const bytes = archive[file.archivePath];
    if (!bytes) {
      throw new Error(`Backup verification failed: missing ${file.archivePath} in archive.`);
    }

    if (sha256Hex(bytes) !== file.sha256) {
      throw new Error(`Backup verification failed for ${file.archivePath}: checksum mismatch.`);
    }
  }
}

async function verifyFolderBackupArtifact(
  targetPath: string,
  manifest: BackupManifest,
): Promise<void> {
  for (const file of manifest.files) {
    const bytes = new Uint8Array(await readFile(path.join(targetPath, file.archivePath)));
    if (sha256Hex(bytes) !== file.sha256) {
      throw new Error(`Backup verification failed for ${file.archivePath}: checksum mismatch.`);
    }
  }
}

async function directorySize(targetPath: string): Promise<number> {
  let total = 0;
  const stack = [targetPath];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }

    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile()) {
        total += statSync(fullPath).size;
      }
    }
  }

  return total;
}

function backupIdFromPath(targetPath: string, format: BackupArtifactFormat): string {
  const baseName = path.basename(targetPath);
  return format === "folder"
    ? baseName.slice(0, -BACKUP_FOLDER_EXTENSION.length)
    : baseName.slice(0, -BACKUP_EXTENSION.length);
}

function normalizeString(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

async function moveThreadToTrash(thread: ThreadRecord): Promise<TrashRecord> {
  if (!existsSync(thread.rolloutPath)) {
    throw new Error(`Thread ${thread.threadId} no longer has a readable rollout file on disk.`);
  }

  await mkdir(DEV_TRASH_DIR, { recursive: true });
  const trashId = cryptoRandomId();
  const entryRoot = path.join(DEV_TRASH_DIR, trashId);
  await mkdir(entryRoot, { recursive: true });
  const originalFileName = sanitizeFileComponent(path.basename(thread.rolloutPath));
  const trashedPath = path.join(entryRoot, originalFileName);
  const deletedAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  const metadata: TrashMetadata = {
    cwd: thread.cwd,
    deletedAt,
    expiresAt,
    originalFileName,
    originalPath: thread.rolloutPath,
    originalStatus: thread.status,
    parentThreadId: thread.parentThreadId,
    rawRolloutBytes: thread.rawRolloutBytes,
    threadId: thread.threadId,
    threadSource: thread.threadSource,
    title: thread.title,
    trashId,
  };
  await writeFile(path.join(entryRoot, "metadata.json"), JSON.stringify(metadata, null, 2));
  try {
    await moveFile(thread.rolloutPath, trashedPath);
  } catch (error) {
    await rm(entryRoot, { recursive: true, force: true });
    throw error;
  }

  return {
    cwd: metadata.cwd,
    deletedAt,
    expiresAt,
    originalPath: metadata.originalPath,
    originalStatus: metadata.originalStatus,
    parentThreadId: metadata.parentThreadId,
    rawRolloutBytes: metadata.rawRolloutBytes,
    threadId: metadata.threadId,
    threadSource: metadata.threadSource,
    title: metadata.title,
    trashId,
    trashedPath,
  };
}

function trashEntryRoot(trashId: string): string {
  const normalized = validatePortableId(trashId, "trash id");
  const entryRoot = path.join(DEV_TRASH_DIR, normalized);
  ensurePathUnder(DEV_TRASH_DIR, entryRoot, "trash item path");
  return entryRoot;
}

async function readTrashRecord(entryRoot: string): Promise<TrashRecord | null> {
  if (!existsSync(entryRoot)) {
    return null;
  }

  const metadata = await readTrashMetadata(entryRoot);
  const trashedPath = await findTrashPayload(entryRoot);
  return {
    cwd: metadata.cwd,
    deletedAt: metadata.deletedAt,
    expiresAt: metadata.expiresAt,
    originalPath: metadata.originalPath,
    originalStatus: metadata.originalStatus,
    parentThreadId: metadata.parentThreadId,
    rawRolloutBytes: metadata.rawRolloutBytes,
    threadId: metadata.threadId,
    threadSource: metadata.threadSource,
    title: metadata.title,
    trashId: metadata.trashId,
    trashedPath,
  };
}

async function readTrashMetadata(entryRoot: string): Promise<TrashMetadata> {
  return JSON.parse(
    await readFile(path.join(entryRoot, "metadata.json"), "utf8"),
  ) as TrashMetadata;
}

async function findTrashPayload(entryRoot: string): Promise<string> {
  for (const entry of await readdir(entryRoot)) {
    if (entry !== "metadata.json") {
      return path.join(entryRoot, entry);
    }
  }
  throw new Error(`Trash entry ${entryRoot} is missing the rollout payload.`);
}

function nextRestorePath(archivedRoot: string, originalFileName: string): string {
  const safeFileName = sanitizeFileComponent(originalFileName);
  const original = path.join(archivedRoot, safeFileName);
  if (!existsSync(original)) {
    return original;
  }

  const parsed = path.parse(safeFileName);
  let index = 2;
  for (;;) {
    const candidate = path.join(
      archivedRoot,
      `${parsed.name}-${index}${parsed.ext || ".jsonl"}`,
    );
    if (!existsSync(candidate)) {
      return candidate;
    }
    index += 1;
  }
}

async function moveFile(sourcePath: string, targetPath: string): Promise<void> {
  try {
    await rename(sourcePath, targetPath);
  } catch {
    await copyFile(sourcePath, targetPath);
    await rm(sourcePath, { force: true });
  }
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return slug || "thread-backup";
}

function timestampSlug(isoTimestamp: string): string {
  return isoTimestamp.replace(/[-:]/g, "").replace(/\.\d+z$/i, "Z").replace(/T/, "T");
}

function handoffTimestamp(isoTimestamp: string): string {
  return isoTimestamp.replace(/[-:]/g, "").replace(/\.\d+Z$/i, "Z");
}
