export type ThreadStatus = "active" | "archived";
export type ThreadSource = "user" | "subagent" | "unknown";
export type BackupExportMode = "threads" | "family";
export type BackupArtifactFormat = "zip" | "folder";
export type ThreadSortKey = "updated_desc" | "created_desc" | "title_asc" | "size_desc";
export type IssueSeverity = "warning" | "error";
export type ScanIssueKind =
  | "metadata_unreadable"
  | "malformed_rollout"
  | "missing_rollout";

export interface ThreadRecord {
  threadId: string;
  title: string;
  status: ThreadStatus;
  threadSource: ThreadSource;
  readOnly: boolean;
  parentThreadId: string | null;
  cwd: string | null;
  rolloutPath: string;
  createdAt: string | null;
  updatedAt: string | null;
  rawRolloutBytes: number;
}

export interface LibraryStats {
  activeCount: number;
  archivedCount: number;
  totalBytes: number;
  activeBytes: number;
  archivedBytes: number;
  subagentCount: number;
}

export interface AppServerStatus {
  available: boolean;
  message: string | null;
}

export interface AppPreferences {
  alternateArchivePath: string | null;
  backupDirectory: string | null;
  backupFormat: BackupArtifactFormat;
  codexHomeOverride: string | null;
  githubRepository: string | null;
}

export interface ActivityRecord {
  activityId: string;
  artifactPath: string | null;
  createdAt: string;
  detail: string;
  kind: "archive" | "unarchive" | "backup" | "trash" | "restore" | "purge" | "import";
  label: string;
  scope: "thread" | "threads" | "family" | "trash";
  status: "success" | "error";
  threadIds: string[];
}

export interface SavedViewRecord {
  dateFrom: string;
  dateTo: string;
  includeReadOnly: "all" | "only" | "exclude";
  maxBytesMb: string;
  minBytesMb: string;
  name: string;
  parentThreadIdQuery: string;
  query: string;
  section: string;
  sortKey: ThreadSortKey;
  sourceFilter: "all" | ThreadSource;
  threadIdQuery: string;
  viewId: string;
  workspaceFilter: string;
}

export interface CleanupRuleRecord {
  action: "archive" | "trash";
  createdAt: string;
  includeSubagents: boolean;
  minBytesMb: string;
  name: string;
  olderThanDays: string;
  ruleId: string;
  scope: "all" | ThreadStatus;
  workspaceFilter: string;
}

export interface TrashRecord {
  cwd: string | null;
  deletedAt: string;
  expiresAt: string;
  originalPath: string;
  originalStatus: ThreadStatus;
  parentThreadId: string | null;
  rawRolloutBytes: number;
  threadId: string;
  threadSource: ThreadSource;
  title: string;
  trashId: string;
  trashedPath: string;
}

export interface BackupImportRequest {
  artifactPath: string;
  collisionMode: "skip" | "replace";
  restoreMode: "archive_only" | "preserve_status";
}

export interface BackupPreviewRequest {
  artifactPath: string;
}

export interface BackupImportResult {
  artifactPath: string;
  importedCount: number;
  importedThreadIds: string[];
  skippedCount: number;
  skippedThreadIds: string[];
}

export interface CreateHandoffRequest {
  artifactPath: string;
  destinationDir?: string | null;
  label?: string | null;
  passphrase?: string | null;
}

export interface HandoffRecord {
  algorithm: string;
  artifactBytes: number;
  backupSha256: string;
  createdAt: string;
  encryptedBytes: number;
  handoffId: string;
  kdf: string;
  label: string;
  originalArtifactName: string;
  recoveryPhrase: string;
  sourceArtifactPath: string;
  targetPath: string;
  threadCount: number;
  totalBytes: number;
}

export interface ImportHandoffRequest {
  collisionMode: "skip" | "replace";
  handoffPath: string;
  passphrase: string;
  restoreMode: "archive_only" | "preserve_status";
}

export interface PreviewHandoffRequest {
  handoffPath: string;
  passphrase: string;
}

export interface HandoffPreviewRecord {
  algorithm: string;
  artifactBytes: number;
  backupSha256: string;
  createdAt: string;
  handoffPath: string;
  kdf: string;
  label: string;
  originalArtifactName: string;
  threadCount: number;
  threadIds: string[];
  totalBytes: number;
}

export interface ImportHandoffResult {
  handoffPath: string;
  importedCount: number;
  importedThreadIds: string[];
  skippedCount: number;
  skippedThreadIds: string[];
  stagedArtifactPath: string;
}

export interface WorkspaceSummary {
  activeCount: number;
  archivedCount: number;
  latestUpdatedAt: string | null;
  largestThreadTitle: string | null;
  readOnlyCount: number;
  subagentCount: number;
  threadCount: number;
  totalBytes: number;
  workspaceKey: string;
  workspaceLabel: string;
}

export interface ScanIssue {
  kind: ScanIssueKind;
  severity: IssueSeverity;
  message: string;
  path: string | null;
  threadId: string | null;
}

export interface ThreadLibrarySnapshot {
  appServer: AppServerStatus;
  activityLog: ActivityRecord[];
  cleanupRules: CleanupRuleRecord[];
  codexHome: string;
  preferences: AppPreferences;
  scannedAt: string;
  scanIssues: ScanIssue[];
  savedViews: SavedViewRecord[];
  stats: LibraryStats;
  threads: ThreadRecord[];
}

export interface BackupFamilyDescriptor {
  familyId: string;
  rootThreadId: string | null;
  label: string;
  threadIds: string[];
  orphaned: boolean;
}

export interface BackupExportRequest {
  destinationDir?: string | null;
  families?: BackupFamilyDescriptor[];
  format?: BackupArtifactFormat;
  mode: BackupExportMode;
  threadIds: string[];
}

export interface BackupRecord {
  artifactBytes: number;
  backupId: string;
  createdAt: string;
  familyMode: boolean;
  familyRoots: string[];
  format: string;
  label: string;
  manifestVersion: number;
  sourceCodexHome: string;
  targetPath: string;
  threadCount: number;
  threadIds: string[];
  totalBytes: number;
}

export interface BackupInventoryIssue {
  message: string;
  path: string;
  severity: IssueSeverity;
}

export interface BackupInventorySnapshot {
  backupDirectory: string;
  issues: BackupInventoryIssue[];
  scannedAt: string;
  records: BackupRecord[];
}

export interface SavePreferencesRequest {
  alternateArchivePath: string | null;
  backupDirectory: string | null;
  backupFormat: BackupArtifactFormat;
  codexHomeOverride: string | null;
  githubRepository: string | null;
}

export interface SaveSavedViewRequest {
  view: SavedViewRecord;
}

export interface DeleteSavedViewRequest {
  viewId: string;
}

export interface SaveCleanupRuleRequest {
  rule: CleanupRuleRecord;
}

export interface DeleteCleanupRuleRequest {
  ruleId: string;
}

export interface TrashThreadsRequest {
  threadIds: string[];
}

export interface RestoreTrashRequest {
  trashIds: string[];
}

export interface PurgeTrashRequest {
  trashIds: string[];
}
