import { useDeferredValue, useEffect, useEffectEvent, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { formatBytes, formatDate } from "./lib/format";
import {
  archiveThread,
  archiveThreads,
  copyText,
  createSecureHandoff,
  deleteCleanupRule,
  deleteSavedView,
  exportBackup,
  importBackupArtifact,
  importSecureHandoff,
  loadBackupInventory,
  loadThreadLibrarySnapshot,
  previewBackupArtifact,
  loadTrashInventory,
  previewSecureHandoff,
  purgeTrashItems,
  revealPath,
  restoreTrashItems,
  saveAppPreferences,
  saveCleanupRule,
  saveSavedView,
  trashThreads,
  unarchiveThread,
  unarchiveThreads,
} from "./lib/tauri";
import type {
  ActivityRecord,
  BackupArtifactFormat,
  BackupFamilyDescriptor,
  BackupInventorySnapshot,
  BackupRecord,
  CleanupRuleRecord,
  HandoffRecord,
  HandoffPreviewRecord,
  SavedViewRecord,
  ThreadLibrarySnapshot,
  ThreadRecord,
  ThreadSortKey,
  ThreadSource,
  TrashRecord,
  WorkspaceSummary,
} from "./types";

type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; snapshot: ThreadLibrarySnapshot }
  | { kind: "error"; message: string };

type BackupInventoryState =
  | { kind: "loading"; snapshot: BackupInventorySnapshot | null }
  | { kind: "ready"; snapshot: BackupInventorySnapshot }
  | { kind: "error"; message: string; snapshot: BackupInventorySnapshot | null };

type TrashState =
  | { kind: "loading"; records: TrashRecord[] }
  | { kind: "ready"; records: TrashRecord[] }
  | { kind: "error"; message: string; records: TrashRecord[] };

type SectionId =
  | "library"
  | "archives"
  | "subagents"
  | "workspaces"
  | "backups"
  | "trash"
  | "rules"
  | "health"
  | "settings";

type IncludeReadOnly = "all" | "only" | "exclude";
type SourceFilter = "all" | ThreadSource;
type RuleAction = "archive" | "trash";
type RuleScope = "all" | "active" | "archived";
type ComplexityMode = "simple" | "advanced";

interface FamilyGroup {
  familyId: string;
  isOrphaned: boolean;
  latestUpdatedAt: string | null;
  memberThreadIds: string[];
  parentThread: ThreadRecord | null;
  parentThreadId: string | null;
  parentTitle: string;
  threads: ThreadRecord[];
  totalBytes: number;
}

interface WorkspaceGroup {
  families: FamilyGroup[];
  summary: WorkspaceSummary;
  threads: ThreadRecord[];
}

interface SurfaceCatalog {
  activeThreads: ThreadRecord[];
  archivedThreads: ThreadRecord[];
  families: FamilyGroup[];
  familyCount: number;
  subagentBytes: number;
  subagentThreads: ThreadRecord[];
  topLevelThreads: ThreadRecord[];
  workspaceGroups: WorkspaceGroup[];
}

interface SectionCopy {
  emptyBody: string;
  emptyTitle: string;
  eyebrow: string;
  note: string;
  searchable: boolean;
  showSummary: boolean;
  title: string;
}

interface HeroMetric {
  detail: string;
  label: string;
  value: string;
}

interface ThreadFilters {
  dateFrom: string;
  dateTo: string;
  includeReadOnly: IncludeReadOnly;
  maxBytesMb: string;
  minBytesMb: string;
  parentThreadIdQuery: string;
  query: string;
  sortKey: ThreadSortKey;
  sourceFilter: SourceFilter;
  threadIdQuery: string;
  workspaceFilter: string;
}

interface RuleDraft {
  action: RuleAction;
  includeSubagents: boolean;
  minBytesMb: string;
  name: string;
  olderThanDays: string;
  scope: RuleScope;
  workspaceFilter: string;
}

interface VisibleSurface {
  families: FamilyGroup[];
  threads: ThreadRecord[];
}

interface PaginatedResult<T> {
  items: T[];
  page: number;
  pageCount: number;
  pageSize: number;
  totalItems: number;
}

interface HealthSummary {
  activityLog: ActivityRecord[];
  appServer: ThreadLibrarySnapshot["appServer"];
  largestFamilies: FamilyGroup[];
  largestThreads: ThreadRecord[];
  largestWorkspaces: WorkspaceGroup[];
  missingRollouts: ThreadLibrarySnapshot["scanIssues"];
  orphanedFamilies: FamilyGroup[];
  reclaimCandidates: ThreadRecord[];
  totalIssues: number;
  unreadableMetadata: ThreadLibrarySnapshot["scanIssues"];
}

interface BackupHealthSummary {
  coveragePercent: number;
  label: string;
  largestUnbackedThreads: ThreadRecord[];
  lastBackup: BackupRecord | null;
  lastBackupAgeDays: number | null;
  score: number;
  verifiedArtifacts: number;
  warningCount: number;
}

interface GitHubReleaseInfo {
  body: string;
  htmlUrl: string;
  name: string;
  publishedAt: string | null;
  tagName: string;
}

type UpdateStatus =
  | { kind: "idle" }
  | { kind: "loading" }
  | {
      checkedAt: string;
      kind: "ready";
      message: string;
      release: GitHubReleaseInfo | null;
      repository: string;
    }
  | { kind: "error"; message: string };

interface PreviewState {
  bytes: number;
  confirmLabel: string;
  danger: boolean;
  description: string;
  execute: () => Promise<void>;
  readOnlyCount: number;
  threads: ThreadRecord[];
  title: string;
  trashItems: TrashRecord[];
}

const sections: Array<{ id: SectionId; label: string }> = [
  { id: "library", label: "Library" },
  { id: "archives", label: "Archive Vault" },
  { id: "subagents", label: "Subagents" },
  { id: "workspaces", label: "Workspaces" },
  { id: "backups", label: "Backups" },
  { id: "trash", label: "Trash" },
  { id: "rules", label: "Rules" },
  { id: "health", label: "Health" },
  { id: "settings", label: "Settings" },
];

const SEARCHABLE_SECTIONS: SectionId[] = [
  "library",
  "archives",
  "subagents",
  "workspaces",
  "trash",
];

const THREADS_PER_PAGE = 12;
const FAMILIES_PER_PAGE = 8;
const FAMILY_THREADS_PER_PAGE = 8;
const WORKSPACES_PER_PAGE = 12;
const BACKUPS_PER_PAGE = 10;
const TRASH_PER_PAGE = 10;
const APP_VERSION = "0.1.1";
const OFFICIAL_GITHUB_REPOSITORY = "ActionWolf0/threaddock";

const DEFAULT_FILTERS: ThreadFilters = {
  dateFrom: "",
  dateTo: "",
  includeReadOnly: "all",
  maxBytesMb: "",
  minBytesMb: "",
  parentThreadIdQuery: "",
  query: "",
  sortKey: "updated_desc",
  sourceFilter: "all",
  threadIdQuery: "",
  workspaceFilter: "",
};

const DEFAULT_RULE_DRAFT: RuleDraft = {
  action: "archive",
  includeSubagents: false,
  minBytesMb: "",
  name: "",
  olderThanDays: "30",
  scope: "active",
  workspaceFilter: "",
};

export function App() {
  const [section, setSection] = useState<SectionId>("library");
  const [filters, setFilters] = useState<ThreadFilters>(() => readFilterSettings());
  const [complexityMode, setComplexityMode] = useState<ComplexityMode>(() =>
    readComplexityModeSetting(),
  );
  const deferredQuery = useDeferredValue(filters.query);
  const [savedViewName, setSavedViewName] = useState("");
  const [activeSavedViewId, setActiveSavedViewId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedFamilyId, setSelectedFamilyId] = useState<string | null>(null);
  const [selectedBackupId, setSelectedBackupId] = useState<string | null>(null);
  const [selectedWorkspaceKey, setSelectedWorkspaceKey] = useState<string | null>(null);
  const [selectedTrashId, setSelectedTrashId] = useState<string | null>(null);
  const [selectedRuleId, setSelectedRuleId] = useState<string | null>(null);
  const [selectedThreadIds, setSelectedThreadIds] = useState<string[]>([]);
  const [selectedTrashIds, setSelectedTrashIds] = useState<string[]>([]);
  const [threadPage, setThreadPage] = useState(1);
  const [familyPage, setFamilyPage] = useState(1);
  const [familyThreadPage, setFamilyThreadPage] = useState(1);
  const [workspacePage, setWorkspacePage] = useState(1);
  const [backupPage, setBackupPage] = useState(1);
  const [trashPage, setTrashPage] = useState(1);
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [backupInventoryState, setBackupInventoryState] = useState<BackupInventoryState>({
    kind: "loading",
    snapshot: null,
  });
  const [trashState, setTrashState] = useState<TrashState>({
    kind: "loading",
    records: [],
  });
  const [lastHandoff, setLastHandoff] = useState<HandoffRecord | null>(null);
  const [handoffPreview, setHandoffPreview] = useState<HandoffPreviewRecord | null>(null);
  const [backupImportPreview, setBackupImportPreview] = useState<BackupRecord | null>(null);
  const [showHandoffSecret, setShowHandoffSecret] = useState(false);
  const [backupDirectory, setBackupDirectory] = useState(() =>
    readTextSetting("threaddock.backupDirectory"),
  );
  const [backupFormat, setBackupFormat] = useState<BackupArtifactFormat>("zip");
  const [codexBinaryPath, setCodexBinaryPath] = useState("");
  const [codexHomeOverride, setCodexHomeOverride] = useState("");
  const [alternateArchivePath, setAlternateArchivePath] = useState("");
  const [githubRepository, setGithubRepository] = useState(OFFICIAL_GITHUB_REPOSITORY);
  const [importArtifactPath, setImportArtifactPath] = useState("");
  const [importCollisionMode, setImportCollisionMode] = useState<"skip" | "replace">("skip");
  const [importRestoreMode, setImportRestoreMode] = useState<"archive_only" | "preserve_status">(
    "archive_only",
  );
  const [handoffImportPath, setHandoffImportPath] = useState("");
  const [handoffPassphrase, setHandoffPassphrase] = useState("");
  const [ruleDraft, setRuleDraft] = useState<RuleDraft>(() => readRuleDraftSetting());
  const [previewState, setPreviewState] = useState<null | PreviewState>(null);
  const [busyToken, setBusyToken] = useState<string | null>(null);
  const [operationError, setOperationError] = useState<string | null>(null);
  const [operationNotice, setOperationNotice] = useState<string | null>(null);
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>({ kind: "idle" });

  const applyFilters = useEffectEvent((partial: Partial<ThreadFilters>) => {
    setFilters((current) => ({ ...current, ...partial }));
    setActiveSavedViewId(null);
  });

  const clearSimpleHiddenFilters = useEffectEvent(() => {
    applyFilters({
      dateFrom: "",
      dateTo: "",
      includeReadOnly: "all",
      maxBytesMb: "",
      minBytesMb: "",
      parentThreadIdQuery: "",
      sortKey: "updated_desc",
      sourceFilter: "all",
      threadIdQuery: "",
      workspaceFilter: "",
    });
  });

  const patchSnapshot = useEffectEvent(
    (
      updater: (snapshot: ThreadLibrarySnapshot) => ThreadLibrarySnapshot,
    ) => {
      setState((current) =>
        current.kind === "ready"
          ? {
              kind: "ready",
              snapshot: updater(current.snapshot),
            }
          : current,
      );
    },
  );

  const loadSnapshot = useEffectEvent(async (preferredThreadId: null | string = null) => {
    const snapshot = await loadThreadLibrarySnapshot();
    setState({ kind: "ready", snapshot });
    setBackupDirectory(snapshot.preferences.backupDirectory ?? "");
    setBackupFormat(snapshot.preferences.backupFormat);
    setCodexBinaryPath(snapshot.preferences.codexBinaryPath ?? "");
    setCodexHomeOverride(snapshot.preferences.codexHomeOverride ?? "");
    setAlternateArchivePath(snapshot.preferences.alternateArchivePath ?? "");
    setGithubRepository(snapshot.preferences.githubRepository ?? OFFICIAL_GITHUB_REPOSITORY);
    const nextThreadId =
      preferredThreadId && snapshot.threads.some((thread) => thread.threadId === preferredThreadId)
        ? preferredThreadId
        : snapshot.threads[0]?.threadId ?? null;
    setSelectedId(nextThreadId);
  });

  const refreshBackupInventory = useEffectEvent(async (preferredDirectory: null | string = null) => {
    const currentSnapshot = backupInventoryState.snapshot;
    setBackupInventoryState({ kind: "loading", snapshot: currentSnapshot });
    try {
      const snapshot = await loadBackupInventory(preferredDirectory ?? (backupDirectory || null));
      setBackupInventoryState({ kind: "ready", snapshot });
      setBackupDirectory(snapshot.backupDirectory);
      setSelectedBackupId((current) =>
        current && snapshot.records.some((record) => record.backupId === current)
          ? current
          : snapshot.records[0]?.backupId ?? null,
      );
    } catch (error) {
      setBackupInventoryState({
        kind: "error",
        message: asErrorMessage(error, "Failed to load backup inventory."),
        snapshot: currentSnapshot,
      });
    }
  });

  const refreshTrashInventory = useEffectEvent(async () => {
    const currentRecords = trashState.records;
    setTrashState({ kind: "loading", records: currentRecords });
    try {
      const records = await loadTrashInventory();
      setTrashState({ kind: "ready", records });
      setSelectedTrashId((current) =>
        current && records.some((record) => record.trashId === current)
          ? current
          : records[0]?.trashId ?? null,
      );
    } catch (error) {
      setTrashState({
        kind: "error",
        message: asErrorMessage(error, "Failed to load the trash inventory."),
        records: currentRecords,
      });
    }
  });

  useEffect(() => {
    let active = true;

    async function load() {
      try {
        await loadSnapshot(selectedId);
        await refreshBackupInventory(null);
        await refreshTrashInventory();
      } catch (error) {
        if (!active) {
          return;
        }
        setState({
          kind: "error",
          message: asErrorMessage(error, "Failed to load ThreadDock."),
        });
      }
    }

    void load();
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    writeFilterSettings(filters);
  }, [filters]);

  useEffect(() => {
    writeTextSetting("threaddock.complexityMode", complexityMode);
  }, [complexityMode]);

  useEffect(() => {
    writeTextSetting("threaddock.backupDirectory", backupDirectory);
  }, [backupDirectory]);

  useEffect(() => {
    writeRuleDraftSetting(ruleDraft);
  }, [ruleDraft]);

  useEffect(() => {
    setThreadPage(1);
    setFamilyPage(1);
    setFamilyThreadPage(1);
    setWorkspacePage(1);
    setBackupPage(1);
    setTrashPage(1);
    setSelectedThreadIds([]);
    setSelectedTrashIds([]);
  }, [filters, section]);

  const catalog = useMemo(() => {
    if (state.kind !== "ready") {
      return null;
    }

    const threadById = new Map(
      state.snapshot.threads.map((thread) => [thread.threadId, thread] as const),
    );
    const subagentThreads = state.snapshot.threads.filter(isSubagentThread);
    const topLevelThreads = state.snapshot.threads.filter((thread) => !isSubagentThread(thread));
    const activeThreads = topLevelThreads.filter((thread) => thread.status === "active");
    const archivedThreads = topLevelThreads.filter((thread) => thread.status === "archived");
    const familyMap = new Map<string, FamilyGroup>();

    for (const thread of subagentThreads) {
      const familyId = thread.parentThreadId ?? `detached:${thread.threadId}`;
      const parentThread = thread.parentThreadId
        ? threadById.get(thread.parentThreadId) ?? null
        : null;
      const existing = familyMap.get(familyId);
      if (existing) {
        existing.threads.push(thread);
        existing.memberThreadIds.push(thread.threadId);
        existing.totalBytes += thread.rawRolloutBytes;
        if (compareDates(thread.updatedAt, existing.latestUpdatedAt) > 0) {
          existing.latestUpdatedAt = thread.updatedAt;
        }
        continue;
      }

      familyMap.set(familyId, {
        familyId,
        isOrphaned: Boolean(thread.parentThreadId && !parentThread),
        latestUpdatedAt:
          compareDates(parentThread?.updatedAt ?? null, thread.updatedAt) > 0
            ? parentThread?.updatedAt ?? null
            : thread.updatedAt,
        memberThreadIds: parentThread
          ? [parentThread.threadId, thread.threadId]
          : [thread.threadId],
        parentThread,
        parentThreadId: thread.parentThreadId,
        parentTitle:
          parentThread?.title ??
          (thread.parentThreadId
            ? `Detached from ${thread.parentThreadId.slice(0, 8)}`
            : "Detached subagents"),
        threads: [thread],
        totalBytes: thread.rawRolloutBytes + (parentThread?.rawRolloutBytes ?? 0),
      });
    }

    const families = [...familyMap.values()]
      .map((family) => ({
        ...family,
        memberThreadIds: [...new Set(family.memberThreadIds)],
        threads: [...family.threads].sort((left, right) => {
          return (
            compareDates(right.updatedAt, left.updatedAt) || left.title.localeCompare(right.title)
          );
        }),
      }))
      .sort((left, right) => {
        return (
          compareDates(right.latestUpdatedAt, left.latestUpdatedAt) ||
          left.parentTitle.localeCompare(right.parentTitle)
        );
      });

    const workspaceMap = new Map<string, ThreadRecord[]>();
    for (const thread of state.snapshot.threads) {
      const workspaceKey = normalizeWorkspaceKey(thread.cwd);
      const records = workspaceMap.get(workspaceKey);
      if (records) {
        records.push(thread);
      } else {
        workspaceMap.set(workspaceKey, [thread]);
      }
    }

    const familyWorkspaceMap = new Map<string, FamilyGroup[]>();
    for (const family of families) {
      const workspaceKey = normalizeWorkspaceKey(
        family.parentThread?.cwd ?? family.threads[0]?.cwd ?? null,
      );
      const records = familyWorkspaceMap.get(workspaceKey);
      if (records) {
        records.push(family);
      } else {
        familyWorkspaceMap.set(workspaceKey, [family]);
      }
    }

    const workspaceGroups = [...workspaceMap.entries()]
      .map(([workspaceKey, threads]) => {
        const summary = buildWorkspaceSummary(workspaceKey, threads);
        return {
          families: familyWorkspaceMap.get(workspaceKey) ?? [],
          summary,
          threads: sortThreads(threads, "updated_desc"),
        } satisfies WorkspaceGroup;
      })
      .sort((left, right) => sortWorkspaceGroups([left, right], filters.sortKey)[0] === left ? -1 : 1);

    return {
      activeThreads,
      archivedThreads,
      families,
      familyCount: families.length,
      subagentBytes: subagentThreads.reduce((total, thread) => total + thread.rawRolloutBytes, 0),
      subagentThreads,
      topLevelThreads,
      workspaceGroups,
    } satisfies SurfaceCatalog;
  }, [filters.sortKey, state]);

  const effectiveFilters = useMemo(
    () => ({
      ...filters,
      query: deferredQuery,
    }),
    [deferredQuery, filters],
  );

  const visibleSurface = useMemo(() => {
    if (state.kind !== "ready" || !catalog) {
      return { families: [], threads: [] } satisfies VisibleSurface;
    }

    switch (section) {
      case "library":
        return {
          families: [],
          threads: sortThreads(
            catalog.activeThreads.filter((thread) => matchesThreadFilters(thread, effectiveFilters)),
            effectiveFilters.sortKey,
          ),
        } satisfies VisibleSurface;
      case "archives":
        return {
          families: [],
          threads: sortThreads(
            catalog.archivedThreads.filter((thread) => matchesThreadFilters(thread, effectiveFilters)),
            effectiveFilters.sortKey,
          ),
        } satisfies VisibleSurface;
      case "subagents":
        return {
          families: sortFamilies(
            catalog.families.filter((family) => matchesFamilyFilters(family, effectiveFilters)),
            effectiveFilters.sortKey,
          ),
          threads: [],
        } satisfies VisibleSurface;
      default:
        return { families: [], threads: [] } satisfies VisibleSurface;
    }
  }, [catalog, effectiveFilters, section, state]);

  const visibleWorkspaces = useMemo(() => {
    if (!catalog) {
      return [];
    }
    return sortWorkspaceGroups(
      catalog.workspaceGroups.filter((group) => matchesWorkspaceFilters(group, effectiveFilters)),
      effectiveFilters.sortKey,
    );
  }, [catalog, effectiveFilters]);

  const visibleTrash = useMemo(() => {
    return sortTrashRecords(
      trashState.records.filter((record) => matchesTrashFilters(record, effectiveFilters)),
      effectiveFilters.sortKey,
    );
  }, [effectiveFilters, trashState.records]);

  const familySizeByThreadId = useMemo(() => {
    const sizes = new Map<string, number>();
    if (!catalog) {
      return sizes;
    }
    for (const family of catalog.families) {
      if (family.parentThread) {
        sizes.set(family.parentThread.threadId, family.totalBytes);
      }
      for (const thread of family.threads) {
        sizes.set(thread.threadId, family.totalBytes);
      }
    }
    return sizes;
  }, [catalog]);

  const backupInventory = backupInventoryState.snapshot;
  const backupRecords = backupInventory?.records ?? [];
  const backupIssues = backupInventory?.issues ?? [];
  const sectionCopy = getSectionCopy(section, catalog, visibleSurface, visibleWorkspaces, visibleTrash);
  const threadPageData = useMemo(
    () => paginateItems(visibleSurface.threads, threadPage, THREADS_PER_PAGE),
    [threadPage, visibleSurface.threads],
  );
  const familyPageData = useMemo(
    () => paginateItems(visibleSurface.families, familyPage, FAMILIES_PER_PAGE),
    [familyPage, visibleSurface.families],
  );
  const workspacePageData = useMemo(
    () => paginateItems(visibleWorkspaces, workspacePage, WORKSPACES_PER_PAGE),
    [visibleWorkspaces, workspacePage],
  );
  const backupPageData = useMemo(
    () => paginateItems(backupRecords, backupPage, BACKUPS_PER_PAGE),
    [backupPage, backupRecords],
  );
  const trashPageData = useMemo(
    () => paginateItems(visibleTrash, trashPage, TRASH_PER_PAGE),
    [trashPage, visibleTrash],
  );
  const selectedThread = useMemo(() => {
    if (threadPageData.items.length === 0) {
      return null;
    }
    return (
      threadPageData.items.find((thread) => thread.threadId === selectedId) ??
      threadPageData.items[0]
    );
  }, [selectedId, threadPageData.items]);
  const selectedFamily = useMemo(() => {
    if (familyPageData.items.length === 0) {
      return null;
    }
    return (
      familyPageData.items.find((family) => family.familyId === selectedFamilyId) ??
      familyPageData.items[0]
    );
  }, [familyPageData.items, selectedFamilyId]);
  const selectedWorkspace = useMemo(() => {
    if (workspacePageData.items.length === 0) {
      return null;
    }
    return (
      workspacePageData.items.find((group) => group.summary.workspaceKey === selectedWorkspaceKey) ??
      workspacePageData.items[0]
    );
  }, [selectedWorkspaceKey, workspacePageData.items]);
  const selectedBackup = useMemo(() => {
    if (backupPageData.items.length === 0) {
      return null;
    }
    return (
      backupPageData.items.find((record) => record.backupId === selectedBackupId) ??
      backupPageData.items[0]
    );
  }, [backupPageData.items, selectedBackupId]);
  const selectedTrash = useMemo(() => {
    if (trashPageData.items.length === 0) {
      return null;
    }
    return (
      trashPageData.items.find((record) => record.trashId === selectedTrashId) ??
      trashPageData.items[0]
    );
  }, [selectedTrashId, trashPageData.items]);
  const selectedVisibleThreads = useMemo(() => {
    const selected = new Set(selectedThreadIds);
    return visibleSurface.threads.filter((thread) => selected.has(thread.threadId));
  }, [selectedThreadIds, visibleSurface.threads]);
  const selectedVisibleTrash = useMemo(() => {
    const selected = new Set(selectedTrashIds);
    return visibleTrash.filter((record) => selected.has(record.trashId));
  }, [selectedTrashIds, visibleTrash]);
  const familyThreadPageData = useMemo(
    () => paginateItems(selectedFamily ? getFamilyMembers(selectedFamily) : [], familyThreadPage, FAMILY_THREADS_PER_PAGE),
    [familyThreadPage, selectedFamily],
  );
  const savedViews = state.kind === "ready" ? state.snapshot.savedViews : [];
  const cleanupRules = state.kind === "ready" ? state.snapshot.cleanupRules : [];
  const visibleSavedViews = useMemo(
    () => savedViews.filter((view) => view.section === section),
    [savedViews, section],
  );
  const selectedRule = useMemo(
    () =>
      cleanupRules.find((rule) => rule.ruleId === selectedRuleId) ??
      cleanupRules[0] ??
      null,
    [cleanupRules, selectedRuleId],
  );

  const healthData = useMemo(() => {
    if (state.kind !== "ready" || !catalog) {
      return null;
    }

    const orphanedFamilies = catalog.families.filter((family) => family.isOrphaned);
    const missingRollouts = state.snapshot.scanIssues.filter((issue) => issue.kind === "missing_rollout");
    const unreadableMetadata = state.snapshot.scanIssues.filter(
      (issue) => issue.kind === "metadata_unreadable",
    );
    return {
      activityLog: state.snapshot.activityLog,
      appServer: state.snapshot.appServer,
      largestFamilies: sortFamilies([...catalog.families], "size_desc").slice(0, 8),
      largestThreads: sortThreads([...state.snapshot.threads], "size_desc").slice(0, 8),
      largestWorkspaces: sortWorkspaceGroups([...catalog.workspaceGroups], "size_desc").slice(0, 8),
      missingRollouts,
      orphanedFamilies,
      reclaimCandidates: sortThreads([...catalog.archivedThreads], "size_desc").slice(0, 8),
      totalIssues: state.snapshot.scanIssues.length + orphanedFamilies.length,
      unreadableMetadata,
    } satisfies HealthSummary;
  }, [catalog, state]);

  const backupHealth = useMemo(() => {
    if (state.kind !== "ready") {
      return null;
    }
    return buildBackupHealth(state.snapshot.threads, backupRecords, backupIssues);
  }, [backupIssues, backupRecords, state]);

  const heroMetrics = useMemo(
    () =>
      buildHeroMetrics({
        backupRecords,
        catalog,
        cleanupRules,
        filters,
        healthData,
        section,
        visibleSurface,
        visibleTrash,
        visibleWorkspaces,
      }),
    [
      backupRecords,
      catalog,
      cleanupRules,
      filters,
      healthData,
      section,
      visibleSurface,
      visibleTrash,
      visibleWorkspaces,
    ],
  );
  const isAdvancedMode = complexityMode === "advanced";
  const visibleHeroMetrics = isAdvancedMode ? heroMetrics : heroMetrics.slice(0, 2);
  const hiddenSimpleFilterCount = isAdvancedMode ? 0 : countSimpleHiddenFilters(filters);
  const sectionIndex = sections.findIndex((item) => item.id === section) + 1;

  const rulePreviewThreads = useMemo(() => {
    if (state.kind !== "ready") {
      return [];
    }
    return buildRuleMatches(state.snapshot.threads, ruleDraft);
  }, [ruleDraft, state]);

  const handleArchiveToggle = useEffectEvent(async (thread: ThreadRecord) => {
    const action = thread.status === "archived" ? "unarchive" : "archive";
    setBusyToken(`thread:${action}:${thread.threadId}`);
    setOperationError(null);
    setOperationNotice(null);
    try {
      if (action === "archive") {
        await archiveThread(thread.threadId);
      } else {
        await unarchiveThread(thread.threadId);
      }
      await loadSnapshot(thread.threadId);
      setOperationNotice(`${action === "archive" ? "Archived" : "Restored"} ${thread.title}.`);
    } catch (error) {
      setOperationError(
        asErrorMessage(error, `Failed to ${action} the selected thread.`),
      );
    } finally {
      setBusyToken(null);
    }
  });

  const handlePreviewExecute = useEffectEvent(async () => {
    if (!previewState) {
      return;
    }
    setBusyToken(`preview:${previewState.confirmLabel}`);
    setOperationError(null);
    setOperationNotice(null);
    try {
      await previewState.execute();
      setPreviewState(null);
    } catch (error) {
      setOperationError(asErrorMessage(error, "The selected operation failed."));
    } finally {
      setBusyToken(null);
    }
  });

  const handleThreadSelection = useEffectEvent((threadId: string, checked: boolean) => {
    setSelectedThreadIds((current) => {
      const next = new Set(current);
      if (checked) {
        next.add(threadId);
      } else {
        next.delete(threadId);
      }
      return [...next];
    });
  });

  const handleTrashSelection = useEffectEvent((trashId: string, checked: boolean) => {
    setSelectedTrashIds((current) => {
      const next = new Set(current);
      if (checked) {
        next.add(trashId);
      } else {
        next.delete(trashId);
      }
      return [...next];
    });
  });

  const handlePageSelection = useEffectEvent((threadIds: string[], checked: boolean) => {
    setSelectedThreadIds((current) => {
      const next = new Set(current);
      for (const threadId of threadIds) {
        if (checked) {
          next.add(threadId);
        } else {
          next.delete(threadId);
        }
      }
      return [...next];
    });
  });

  const handleTrashPageSelection = useEffectEvent((trashIds: string[], checked: boolean) => {
    setSelectedTrashIds((current) => {
      const next = new Set(current);
      for (const trashId of trashIds) {
        if (checked) {
          next.add(trashId);
        } else {
          next.delete(trashId);
        }
      }
      return [...next];
    });
  });

  const handleCopyText = useEffectEvent(async (value: string, label: string) => {
    try {
      await copyText(value);
      setOperationError(null);
      setOperationNotice(`Copied ${label}.`);
    } catch (error) {
      setOperationError(asErrorMessage(error, `Failed to copy ${label}.`));
    }
  });

  const handleRevealPath = useEffectEvent(async (targetPath: string) => {
    try {
      await revealPath(targetPath);
      setOperationError(null);
      setOperationNotice(`Revealed ${targetPath}.`);
    } catch (error) {
      setOperationError(asErrorMessage(error, `Failed to reveal ${targetPath}.`));
    }
  });

  const openPreview = useEffectEvent((preview: PreviewState) => {
    setPreviewState(preview);
  });

  const handleThreadTrash = useEffectEvent((thread: ThreadRecord) => {
    if (thread.readOnly) {
      setOperationError("Read-only archive threads cannot be moved to trash.");
      return;
    }
    openPreview({
      bytes: thread.rawRolloutBytes,
      confirmLabel: "Move to trash",
      danger: true,
      description:
        "ThreadDock will archive the thread if needed, move its rollout into Trash, and keep it restorable for 30 days.",
      execute: async () => {
        await trashThreads([thread.threadId]);
        await loadSnapshot(null);
        await refreshTrashInventory();
        setOperationNotice(`Moved ${thread.title} to trash.`);
      },
      readOnlyCount: 0,
      threads: [thread],
      title: `Trash ${thread.title}?`,
      trashItems: [],
    });
  });

  const handleFamilyAction = useEffectEvent(
    (family: FamilyGroup, action: "archive" | "backup" | "trash" | "unarchive") => {
      const familyMembers = getFamilyMembers(family);
      const actionable =
        action === "backup"
          ? familyMembers
          : familyMembers.filter((thread) => {
              if (thread.readOnly) {
                return false;
              }
              if (action === "archive") {
                return thread.status === "active";
              }
              if (action === "unarchive") {
                return thread.status === "archived";
              }
              return true;
            });

      if (actionable.length === 0) {
        setOperationError(`No family threads are available for ${action}.`);
        return;
      }

      if (action === "backup") {
        void handleFamilyBackup(family);
        return;
      }

      openPreview({
        bytes: actionable.reduce((total, thread) => total + thread.rawRolloutBytes, 0),
        confirmLabel:
          action === "archive"
            ? "Archive family"
            : action === "unarchive"
              ? "Restore family"
              : "Move family to trash",
        danger: action === "trash",
        description:
          action === "trash"
            ? "This will move the parent thread and every mutable descendant in the family to Trash with the 30-day restore guard."
            : "This family operation applies to the parent thread when present plus every mutable descendant that matches the requested lifecycle state.",
        execute: async () => {
          const threadIds = actionable.map((thread) => thread.threadId);
          if (action === "archive") {
            await archiveThreads(threadIds);
            setOperationNotice(`Archived ${threadIds.length} family threads.`);
          } else if (action === "unarchive") {
            await unarchiveThreads(threadIds);
            setOperationNotice(`Restored ${threadIds.length} family threads.`);
          } else {
            await trashThreads(threadIds);
            await refreshTrashInventory();
            setOperationNotice(`Moved ${threadIds.length} family threads to trash.`);
          }
          await loadSnapshot(family.parentThread?.threadId ?? actionable[0]?.threadId ?? null);
        },
        readOnlyCount: familyMembers.length - actionable.length,
        threads: actionable,
        title: `${action === "trash" ? "Trash" : action === "archive" ? "Archive" : "Restore"} ${family.parentTitle}?`,
        trashItems: [],
      });
    },
  );

  const handleBulkThreadAction = useEffectEvent(
    (action: "archive" | "backup" | "trash" | "unarchive") => {
      if (selectedVisibleThreads.length === 0) {
        return;
      }

      const actionable =
        action === "backup"
          ? selectedVisibleThreads
          : selectedVisibleThreads.filter((thread) => {
              if (thread.readOnly) {
                return false;
              }
              if (action === "archive") {
                return thread.status === "active";
              }
              if (action === "unarchive") {
                return thread.status === "archived";
              }
              return true;
            });

      if (actionable.length === 0) {
        setOperationError(`No selected threads are available for ${action}.`);
        return;
      }

      openPreview({
        bytes: actionable.reduce((total, thread) => total + thread.rawRolloutBytes, 0),
        confirmLabel:
          action === "backup"
            ? "Export backup"
            : action === "archive"
              ? "Archive selected"
              : action === "unarchive"
                ? "Restore selected"
                : "Move to trash",
        danger: action === "trash",
        description:
          action === "backup"
            ? "ThreadDock will package the current selection into a portable backup artifact."
            : action === "trash"
              ? "Selected threads move into Trash and remain restorable for 30 days before purge."
              : "ThreadDock will run the selected lifecycle change only on mutable threads that match the requested state.",
        execute: async () => {
          const threadIds = actionable.map((thread) => thread.threadId);
          if (action === "backup") {
            const record = await exportBackup({
              destinationDir: backupDirectory || null,
              families: [],
              format: backupFormat,
              mode: "threads",
              threadIds,
            });
            setSection("backups");
            setSelectedBackupId(record.backupId);
            await refreshBackupInventory(backupDirectory || null);
            setOperationNotice(`Exported ${record.label} to ${record.targetPath}.`);
          } else if (action === "archive") {
            await archiveThreads(threadIds);
            setOperationNotice(`Archived ${threadIds.length} selected threads.`);
          } else if (action === "unarchive") {
            await unarchiveThreads(threadIds);
            setOperationNotice(`Restored ${threadIds.length} selected threads.`);
          } else {
            await trashThreads(threadIds);
            await refreshTrashInventory();
            setOperationNotice(`Moved ${threadIds.length} selected threads to trash.`);
          }
          await loadSnapshot(threadIds[0] ?? null);
          setSelectedThreadIds([]);
        },
        readOnlyCount: selectedVisibleThreads.length - actionable.length,
        threads: actionable,
        title:
          action === "backup"
            ? `Export ${actionable.length} selected threads?`
            : action === "trash"
              ? `Trash ${actionable.length} selected threads?`
              : `${action === "archive" ? "Archive" : "Restore"} ${actionable.length} selected threads?`,
        trashItems: [],
      });
    },
  );

  const runBackupExport = useEffectEvent(
    async (
      scope:
        | { kind: "thread"; thread: ThreadRecord }
        | { kind: "family"; descriptor: BackupFamilyDescriptor; family: FamilyGroup },
    ) => {
      const threadIds =
        scope.kind === "thread" ? [scope.thread.threadId] : scope.family.memberThreadIds;
      const token =
        scope.kind === "thread"
          ? `backup:thread:${scope.thread.threadId}`
          : `backup:family:${scope.family.familyId}`;
      setBusyToken(token);
      setOperationError(null);
      setOperationNotice(null);
      try {
        const record = await exportBackup({
          destinationDir: backupDirectory || null,
          families: scope.kind === "family" ? [scope.descriptor] : [],
          format: backupFormat,
          mode: scope.kind === "family" ? "family" : "threads",
          threadIds,
        });
        await loadSnapshot(threadIds[0] ?? null);
        await refreshBackupInventory(backupDirectory || null);
        setSelectedBackupId(record.backupId);
        setSection("backups");
        setOperationNotice(`Exported ${record.label} to ${record.targetPath}.`);
      } catch (error) {
        setOperationError(asErrorMessage(error, "Failed to export the selected backup."));
      } finally {
        setBusyToken(null);
      }
    },
  );

  const handleThreadBackup = useEffectEvent(async (thread: ThreadRecord) => {
    await runBackupExport({ kind: "thread", thread });
  });

  const handleFamilyBackup = useEffectEvent(async (family: FamilyGroup) => {
    await runBackupExport({
      kind: "family",
      descriptor: {
        familyId: family.familyId,
        label: family.parentTitle,
        orphaned: family.isOrphaned,
        rootThreadId: family.parentThread?.threadId ?? null,
        threadIds: family.memberThreadIds,
      },
      family,
    });
  });

  const handleTrashBulkAction = useEffectEvent((action: "purge" | "restore") => {
    if (selectedVisibleTrash.length === 0) {
      return;
    }
    const actionableTrash =
      action === "restore"
        ? selectedVisibleTrash.filter((record) => !isCorruptTrashRecord(record))
        : selectedVisibleTrash;
    if (actionableTrash.length === 0) {
      setOperationError("Corrupt trash entries cannot be restored, but they can be deleted permanently.");
      return;
    }
    const trashIds = actionableTrash.map((record) => record.trashId);
    openPreview({
      bytes: actionableTrash.reduce((total, record) => total + record.rawRolloutBytes, 0),
      confirmLabel: action === "restore" ? "Restore from trash" : "Delete permanently",
      danger: action === "purge",
      description:
        action === "restore"
          ? "Restored trash items return to the archive vault so you can review them before reactivating anything."
          : "Purge permanently removes these trash entries now instead of waiting for the 30-day guard to expire.",
      execute: async () => {
        if (action === "restore") {
          await restoreTrashItems(trashIds);
          setOperationNotice(`Restored ${trashIds.length} trash entries to the archive vault.`);
        } else {
          await purgeTrashItems(trashIds);
          setOperationNotice(`Permanently removed ${trashIds.length} trash entries.`);
        }
        await refreshTrashInventory();
        await loadSnapshot(null);
        setSelectedTrashIds([]);
      },
      readOnlyCount: 0,
      threads: [],
      title:
        action === "restore"
          ? `Restore ${trashIds.length} trashed threads?`
          : `Delete ${trashIds.length} trashed threads permanently?`,
      trashItems: actionableTrash,
    });
  });

  const handleSingleTrashAction = useEffectEvent((record: TrashRecord, action: "purge" | "restore") => {
    if (action === "restore" && isCorruptTrashRecord(record)) {
      setOperationError("This trash entry is corrupt and cannot be restored. Delete it permanently after confirming you no longer need the payload.");
      return;
    }
    openPreview({
      bytes: record.rawRolloutBytes,
      confirmLabel: action === "restore" ? "Restore from trash" : "Delete permanently",
      danger: action === "purge",
      description:
        action === "restore"
          ? "The rollout will be restored into the archive vault, not directly into the live thread library."
          : "This permanently removes the trash payload immediately.",
      execute: async () => {
        if (action === "restore") {
          await restoreTrashItems([record.trashId]);
          setOperationNotice(`Restored ${record.title} to the archive vault.`);
        } else {
          await purgeTrashItems([record.trashId]);
          setOperationNotice(`Permanently removed ${record.title}.`);
        }
        await refreshTrashInventory();
        await loadSnapshot(null);
      },
      readOnlyCount: 0,
      threads: [],
      title:
        action === "restore"
          ? `Restore ${record.title}?`
          : `Delete ${record.title} permanently?`,
      trashItems: [record],
    });
  });

  const handleSaveCurrentView = useEffectEvent(async () => {
    if (state.kind !== "ready") {
      return;
    }
    const name = savedViewName.trim();
    if (!name) {
      setOperationError("Saved views need a name.");
      return;
    }
    try {
      const result = await saveSavedView({
        dateFrom: filters.dateFrom,
        dateTo: filters.dateTo,
        includeReadOnly: filters.includeReadOnly,
        maxBytesMb: filters.maxBytesMb,
        minBytesMb: filters.minBytesMb,
        name,
        parentThreadIdQuery: filters.parentThreadIdQuery,
        query: filters.query,
        section,
        sortKey: filters.sortKey,
        sourceFilter: filters.sourceFilter,
        threadIdQuery: filters.threadIdQuery,
        viewId: activeSavedViewId ?? createLocalId(),
        workspaceFilter: filters.workspaceFilter,
      });
      patchSnapshot((snapshot) => ({ ...snapshot, savedViews: result }));
      const saved = result.find((view) => view.name === name && view.section === section);
      setActiveSavedViewId(saved?.viewId ?? activeSavedViewId);
      setOperationNotice(`Saved view "${name}".`);
      setSavedViewName("");
    } catch (error) {
      setOperationError(asErrorMessage(error, "Failed to save the current view."));
    }
  });

  const handleDeleteSavedView = useEffectEvent(async (viewId: string) => {
    try {
      const result = await deleteSavedView(viewId);
      patchSnapshot((snapshot) => ({ ...snapshot, savedViews: result }));
      if (activeSavedViewId === viewId) {
        setActiveSavedViewId(null);
      }
      setOperationNotice("Deleted the saved view.");
    } catch (error) {
      setOperationError(asErrorMessage(error, "Failed to delete the saved view."));
    }
  });

  const handleApplySavedView = useEffectEvent((view: SavedViewRecord) => {
    setSection(isSectionId(view.section) ? view.section : "library");
    setFilters({
      dateFrom: view.dateFrom,
      dateTo: view.dateTo,
      includeReadOnly: view.includeReadOnly,
      maxBytesMb: view.maxBytesMb,
      minBytesMb: view.minBytesMb,
      parentThreadIdQuery: view.parentThreadIdQuery,
      query: view.query,
      sortKey: view.sortKey,
      sourceFilter: view.sourceFilter,
      threadIdQuery: view.threadIdQuery,
      workspaceFilter: view.workspaceFilter,
    });
    setActiveSavedViewId(view.viewId);
  });

  const handleSaveRule = useEffectEvent(async () => {
    if (!ruleDraft.name.trim()) {
      setOperationError("Cleanup rules need a name.");
      return;
    }
    try {
      const result = await saveCleanupRule({
        action: ruleDraft.action,
        createdAt: new Date().toISOString(),
        includeSubagents: ruleDraft.includeSubagents,
        minBytesMb: ruleDraft.minBytesMb,
        name: ruleDraft.name.trim(),
        olderThanDays: ruleDraft.olderThanDays,
        ruleId: selectedRule?.ruleId ?? createLocalId(),
        scope: ruleDraft.scope,
        workspaceFilter: ruleDraft.workspaceFilter,
      });
      patchSnapshot((snapshot) => ({ ...snapshot, cleanupRules: result }));
      setOperationNotice(`Saved cleanup rule "${ruleDraft.name.trim()}".`);
      setRuleDraft(DEFAULT_RULE_DRAFT);
      setSelectedRuleId(result[0]?.ruleId ?? null);
    } catch (error) {
      setOperationError(asErrorMessage(error, "Failed to save the cleanup rule."));
    }
  });

  const handleDeleteRule = useEffectEvent(async (ruleId: string) => {
    try {
      const result = await deleteCleanupRule(ruleId);
      patchSnapshot((snapshot) => ({ ...snapshot, cleanupRules: result }));
      if (selectedRuleId === ruleId) {
        setSelectedRuleId(null);
      }
      setOperationNotice("Deleted the cleanup rule.");
    } catch (error) {
      setOperationError(asErrorMessage(error, "Failed to delete the cleanup rule."));
    }
  });

  const handleRunRule = useEffectEvent((rule: CleanupRuleRecord) => {
    if (state.kind !== "ready") {
      return;
    }
    const matches = buildRuleMatches(state.snapshot.threads, {
      action: rule.action,
      includeSubagents: rule.includeSubagents,
      minBytesMb: rule.minBytesMb,
      name: rule.name,
      olderThanDays: rule.olderThanDays,
      scope: rule.scope,
      workspaceFilter: rule.workspaceFilter,
    });
    if (matches.length === 0) {
      setOperationError("That rule does not currently match any threads.");
      return;
    }
    openPreview({
      bytes: matches.reduce((total, thread) => total + thread.rawRolloutBytes, 0),
      confirmLabel: rule.action === "archive" ? "Run archive rule" : "Run trash rule",
      danger: rule.action === "trash",
      description:
        rule.action === "trash"
          ? "Matched threads will move into Trash with the 30-day restore guard."
          : "Matched threads will move into the Archive Vault now.",
      execute: async () => {
        const threadIds = matches.map((thread) => thread.threadId);
        if (rule.action === "archive") {
          await archiveThreads(threadIds);
          setOperationNotice(`Archived ${threadIds.length} rule matches.`);
        } else {
          await trashThreads(threadIds);
          await refreshTrashInventory();
          setOperationNotice(`Moved ${threadIds.length} rule matches to trash.`);
        }
        await loadSnapshot(threadIds[0] ?? null);
      },
      readOnlyCount: 0,
      threads: matches,
      title: `Run "${rule.name}" now?`,
      trashItems: [],
    });
  });

  const handlePreviewBackupImport = useEffectEvent(async () => {
    if (!importArtifactPath.trim()) {
      setOperationError("A backup artifact path is required.");
      return;
    }
    setBusyToken("import:preview");
    setOperationError(null);
    setOperationNotice(null);
    try {
      const preview = await previewBackupArtifact({
        artifactPath: importArtifactPath.trim(),
      });
      setBackupImportPreview(preview);
      setOperationNotice(
        `Preview verified ${preview.threadCount} backup thread${preview.threadCount === 1 ? "" : "s"}.`,
      );
    } catch (error) {
      setBackupImportPreview(null);
      setOperationError(asErrorMessage(error, "Failed to preview the backup artifact."));
    } finally {
      setBusyToken(null);
    }
  });

  const handleImportArtifact = useEffectEvent(async () => {
    if (!importArtifactPath.trim()) {
      setOperationError("A backup artifact path is required.");
      return;
    }
    if (!backupImportPreview) {
      setOperationError("Preview and verify the backup artifact before importing it.");
      return;
    }
    setBusyToken("import:artifact");
    setOperationError(null);
    try {
      const result = await importBackupArtifact({
        artifactPath: importArtifactPath.trim(),
        collisionMode: importCollisionMode,
        restoreMode: importRestoreMode,
      });
      await loadSnapshot(result.importedThreadIds[0] ?? null);
      await refreshTrashInventory();
      setBackupImportPreview(null);
      setOperationNotice(
        `Imported ${result.importedCount} threads and skipped ${result.skippedCount}.`,
      );
      setSection("archives");
    } catch (error) {
      setOperationError(asErrorMessage(error, "Failed to import the backup artifact."));
    } finally {
      setBusyToken(null);
    }
  });

  const handleCreateHandoff = useEffectEvent(async (record: BackupRecord) => {
    setBusyToken(`handoff:create:${record.backupId}`);
    setOperationError(null);
    setOperationNotice(null);
    try {
      const handoff = await createSecureHandoff({
        artifactPath: record.targetPath,
        destinationDir: backupDirectory || null,
        label: record.label,
      });
      setLastHandoff(handoff);
      setHandoffImportPath(handoff.targetPath);
      setHandoffPassphrase(handoff.recoveryPhrase);
      setHandoffPreview(null);
      setShowHandoffSecret(false);
      setOperationNotice(
        `Created secure handoff for ${record.label}. Save the recovery phrase before sharing the file.`,
      );
    } catch (error) {
      setOperationError(asErrorMessage(error, "Failed to create the secure handoff."));
    } finally {
      setBusyToken(null);
    }
  });

  const handlePreviewHandoff = useEffectEvent(async () => {
    if (!handoffImportPath.trim() || !handoffPassphrase.trim()) {
      setOperationError("A secure handoff path and recovery phrase are required.");
      return;
    }
    setBusyToken("handoff:preview");
    setOperationError(null);
    setOperationNotice(null);
    try {
      const preview = await previewSecureHandoff({
        handoffPath: handoffImportPath.trim(),
        passphrase: handoffPassphrase.trim(),
      });
      setHandoffPreview(preview);
      setOperationNotice(
        `Preview verified ${preview.threadCount} secure handoff thread${preview.threadCount === 1 ? "" : "s"}.`,
      );
    } catch (error) {
      setHandoffPreview(null);
      setOperationError(asErrorMessage(error, "Failed to preview the secure handoff."));
    } finally {
      setBusyToken(null);
    }
  });

  const handleImportHandoff = useEffectEvent(async () => {
    if (!handoffImportPath.trim() || !handoffPassphrase.trim()) {
      setOperationError("A secure handoff path and recovery phrase are required.");
      return;
    }
    if (!handoffPreview) {
      setOperationError("Preview and verify the secure handoff before importing it.");
      return;
    }
    setBusyToken("handoff:import");
    setOperationError(null);
    try {
      const result = await importSecureHandoff({
        collisionMode: importCollisionMode,
        handoffPath: handoffImportPath.trim(),
        passphrase: handoffPassphrase.trim(),
        restoreMode: importRestoreMode,
      });
      await loadSnapshot(result.importedThreadIds[0] ?? null);
      await refreshBackupInventory(backupDirectory || null);
      await refreshTrashInventory();
      setHandoffPreview(null);
      setOperationNotice(
        `Imported ${result.importedCount} secure handoff threads and skipped ${result.skippedCount}.`,
      );
      setSection("archives");
    } catch (error) {
      setOperationError(asErrorMessage(error, "Failed to import the secure handoff."));
    } finally {
      setBusyToken(null);
    }
  });

  const handleBackupRefresh = useEffectEvent(async () => {
    setOperationError(null);
    await refreshBackupInventory(backupDirectory || null);
  });

  const handleCheckUpdates = useEffectEvent(async () => {
    const repository = parseGitHubRepository(githubRepository);
    if (!repository) {
      setUpdateStatus({
        kind: "error",
        message: "Enter a GitHub repository as owner/name or a full GitHub repository URL.",
      });
      return;
    }

    setUpdateStatus({ kind: "loading" });
    try {
      const response = await fetch(`https://api.github.com/repos/${repository}/releases/latest`, {
        headers: {
          Accept: "application/vnd.github+json",
        },
      });

      if (response.status === 404) {
        setUpdateStatus({
          checkedAt: new Date().toISOString(),
          kind: "ready",
          message: "No public GitHub release is published for this repository yet.",
          release: null,
          repository,
        });
        return;
      }

      if (!response.ok) {
        throw new Error(`GitHub returned HTTP ${response.status}.`);
      }

      const payload = (await response.json()) as {
        body?: string;
        html_url?: string;
        name?: string;
        published_at?: string;
        tag_name?: string;
      };
      const tagName = payload.tag_name?.trim() || "unknown";
      setUpdateStatus({
        checkedAt: new Date().toISOString(),
        kind: "ready",
        message: "Latest GitHub release loaded.",
        release: {
          body: payload.body ?? "",
          htmlUrl: payload.html_url ?? `https://github.com/${repository}/releases`,
          name: payload.name?.trim() || tagName,
          publishedAt: payload.published_at ?? null,
          tagName,
        },
        repository,
      });
    } catch (error) {
      setUpdateStatus({
        kind: "error",
        message: asErrorMessage(error, "Failed to check GitHub releases."),
      });
    }
  });

  const handleSettingsSave = useEffectEvent(async () => {
    try {
      await saveAppPreferences({
        alternateArchivePath: alternateArchivePath || null,
        backupDirectory: backupDirectory || null,
        backupFormat,
        codexBinaryPath: codexBinaryPath || null,
        codexHomeOverride: codexHomeOverride || null,
        githubRepository: githubRepository || OFFICIAL_GITHUB_REPOSITORY,
      });
      await loadSnapshot(selectedId);
      await refreshBackupInventory(backupDirectory || null);
      await refreshTrashInventory();
      setOperationNotice("Saved ThreadDock settings and refreshed the library.");
    } catch (error) {
      setOperationError(asErrorMessage(error, "Failed to save ThreadDock settings."));
    }
  });

  const handleSettingsReset = useEffectEvent(async () => {
    setCodexBinaryPath("");
    setCodexHomeOverride("");
    setAlternateArchivePath("");
    try {
      await saveAppPreferences({
        alternateArchivePath: null,
        backupDirectory: backupDirectory || null,
        backupFormat,
        codexBinaryPath: null,
        codexHomeOverride: null,
        githubRepository: githubRepository || OFFICIAL_GITHUB_REPOSITORY,
      });
      await loadSnapshot(selectedId);
      setOperationNotice("Cleared custom Codex paths and reloaded the library.");
    } catch (error) {
      setOperationError(asErrorMessage(error, "Failed to clear custom Codex paths."));
    }
  });

  const totalExportedBytes = backupRecords.reduce((total, record) => total + record.totalBytes, 0);

  return (
    <div className="shell" data-mode={complexityMode} data-section={section}>
      <div className="shell-atmosphere" aria-hidden="true">
        <span className="atmosphere-orb atmosphere-orb-large" />
        <span className="atmosphere-orb atmosphere-orb-small" />
        <span className="atmosphere-grid" />
      </div>
      <aside className="rail">
        <div className="brand">
          <div className="brand-mark">TD</div>
          <div className="brand-copy">
            <p className="eyebrow">Codex Thread Manager</p>
            <h1>ThreadDock</h1>
            <p className="brand-note">Archive less blindly. Shape the thread library like a living workspace.</p>
          </div>
        </div>

        <nav className="nav">
          {sections.map((item, index) => (
            <button
              key={item.id}
              type="button"
              className={item.id === section ? "nav-item nav-item-active" : "nav-item"}
              onClick={() => setSection(item.id)}
            >
              <span className="nav-item-copy">
                <strong>{item.label}</strong>
                <small>{navTagline(item.id)}</small>
              </span>
              <span className="nav-item-index">{String(index + 1).padStart(2, "0")}</span>
            </button>
          ))}
        </nav>

      </aside>

      <main className="workspace">
        <section className="toolbar-stage">
          <header className="toolbar">
            <div className="toolbar-copy">
              <p className="eyebrow">{sectionCopy.eyebrow}</p>
              <div className="toolbar-heading-row">
                <h2>{sectionCopy.title}</h2>
                <span className="toolbar-index">{String(sectionIndex).padStart(2, "0")}</span>
              </div>
              <p className="toolbar-note">{sectionCopy.note}</p>
            </div>

            <div className="toolbar-side">
              <ModeToggle mode={complexityMode} onChange={setComplexityMode} />
              {sectionCopy.searchable && (
                <label className="search">
                  <span>Search</span>
                  <input
                    value={filters.query}
                    onChange={(event) => applyFilters({ query: event.target.value })}
                    placeholder="Search title, thread id, or workspace"
                  />
                </label>
              )}
              <div className="toolbar-monogram">
                <span>{sectionMonogram(section)}</span>
                <p>{sectionAtmosphere(section)}</p>
              </div>
            </div>
          </header>

          <div className="hero-metrics">
            {visibleHeroMetrics.map((metric) => (
              <article key={metric.label} className="hero-metric-card">
                <p>{metric.label}</p>
                <strong>{metric.value}</strong>
                <span>{metric.detail}</span>
              </article>
            ))}
          </div>
        </section>

        {state.kind === "ready" &&
          SEARCHABLE_SECTIONS.includes(section) &&
          !isAdvancedMode &&
          hiddenSimpleFilterCount > 0 && (
            <section className="simple-mode-note">
              <div>
                <p className="panel-label">Simple mode</p>
                <strong>{hiddenSimpleFilterCount} advanced filter active</strong>
                <span>Results are still filtered. Review or clear the hidden filters.</span>
              </div>
              <div className="action-row action-row-wrap">
                <button
                  type="button"
                  className="action-secondary"
                  onClick={() => setComplexityMode("advanced")}
                >
                  Review filters
                </button>
                <button
                  type="button"
                  className="action-secondary"
                  onClick={() => clearSimpleHiddenFilters()}
                >
                  Clear hidden filters
                </button>
              </div>
            </section>
          )}

        {state.kind === "ready" && SEARCHABLE_SECTIONS.includes(section) && isAdvancedMode && (
          <>
            <SavedViewsBar
              activeSavedViewId={activeSavedViewId}
              name={savedViewName}
              onApply={handleApplySavedView}
              onDelete={handleDeleteSavedView}
              onNameChange={setSavedViewName}
              onSave={handleSaveCurrentView}
              savedViews={visibleSavedViews}
            />
            <AdvancedFilterBar filters={filters} onChange={applyFilters} />
          </>
        )}

        {state.kind === "loading" && (
          <IndexingStatusCard />
        )}

        {state.kind === "error" && (
          <section className="status-card status-card-error">
            <h3>Unable to load ThreadDock</h3>
            <p>{state.message}</p>
          </section>
        )}

        {operationError && (
          <section className="status-card status-card-error">
            <h3>Operation failed</h3>
            <p>{operationError}</p>
          </section>
        )}

        {operationNotice && (
          <section className="status-card">
            <h3>Operation complete</h3>
            <p>{operationNotice}</p>
          </section>
        )}

        {state.kind === "ready" && catalog && (
          <>
            {sectionCopy.showSummary && isAdvancedMode && (
              <section className="summary-grid">
                <SummaryCard
                  active={section === "library"}
                  description="Live top-level threads only"
                  label="Library"
                  onClick={() => setSection("library")}
                  value={String(catalog.activeThreads.length)}
                />
                <SummaryCard
                  description="Archived top-level threads"
                  label="Archive Vault"
                  onClick={() => setSection("archives")}
                  value={String(catalog.archivedThreads.length)}
                />
                <SummaryCard
                  description={`${catalog.subagentThreads.length} subagents kept separate`}
                  label="Agent Families"
                  onClick={() => setSection("subagents")}
                  value={String(catalog.familyCount)}
                />
                <SummaryCard
                  description="Top-level and subagent workspaces"
                  label="Workspace Lanes"
                  onClick={() => setSection("workspaces")}
                  value={String(catalog.workspaceGroups.length)}
                />
              </section>
            )}

            {(section === "library" || section === "archives") && (
              <div className="content-grid">
                <section className="table-panel">
                  <div className="table-header">
                    <div>
                      <p className="panel-label">Visible threads</p>
                      <p className="panel-value">{visibleSurface.threads.length}</p>
                    </div>
                    {isAdvancedMode && (
                      <>
                        <div>
                          <p className="panel-label">Indexed from</p>
                          <p className="panel-value">{state.snapshot.codexHome}</p>
                        </div>
                        <div>
                          <p className="panel-label">Scanned</p>
                          <p className="panel-value">{formatDate(state.snapshot.scannedAt)}</p>
                        </div>
                      </>
                    )}
                  </div>

                  {threadPageData.items.length > 0 ? (
                    <>
                      {selectedVisibleThreads.length > 0 && (
                        <div className="selection-bar">
                          <div>
                            <p className="panel-label">Selected threads</p>
                            <p className="panel-value">{selectedVisibleThreads.length}</p>
                          </div>
                          <div className="selection-actions">
                            <button
                              type="button"
                              className="action-primary selection-action"
                              onClick={() =>
                                handleBulkThreadAction(section === "library" ? "archive" : "unarchive")
                              }
                            >
                              {section === "library" ? "Archive selected" : "Restore selected"}
                            </button>
                            <button
                              type="button"
                              className="action-secondary selection-action"
                              onClick={() => handleBulkThreadAction("backup")}
                            >
                              Backup selected
                            </button>
                            <button
                              type="button"
                              className="action-secondary selection-action"
                              onClick={() => handleBulkThreadAction("trash")}
                            >
                              Move to trash
                            </button>
                            <button
                              type="button"
                              className="action-secondary selection-action"
                              onClick={() => setSelectedThreadIds([])}
                            >
                              Clear
                            </button>
                          </div>
                        </div>
                      )}

                      <div className="table-wrap">
                        <table>
                          <thead>
                            <tr>
                              <th>
                                <input
                                  type="checkbox"
                                  checked={
                                    threadPageData.items.length > 0 &&
                                    threadPageData.items.every((thread) =>
                                      selectedThreadIds.includes(thread.threadId),
                                    )
                                  }
                                  onChange={(event) =>
                                    handlePageSelection(
                                      threadPageData.items.map((thread) => thread.threadId),
                                      event.target.checked,
                                    )
                                  }
                                />
                              </th>
                              <th>Thread</th>
                              <th>Workspace</th>
                              <th>Updated</th>
                              <th>Rollout size</th>
                            </tr>
                          </thead>
                          <tbody>
                            {threadPageData.items.map((thread) => {
                              const isSelected = thread.threadId === selectedThread?.threadId;
                              return (
                                <tr
                                  key={thread.threadId}
                                  className={isSelected ? "row-selected" : undefined}
                                  onClick={() => setSelectedId(thread.threadId)}
                                >
                                  <td onClick={(event) => event.stopPropagation()}>
                                    <input
                                      type="checkbox"
                                      checked={selectedThreadIds.includes(thread.threadId)}
                                      onChange={(event) =>
                                        handleThreadSelection(
                                          thread.threadId,
                                          event.target.checked,
                                        )
                                      }
                                    />
                                  </td>
                                  <td>
                                    <div className="title-cell">
                                      <span>{thread.title}</span>
                                      <code>{thread.threadId.slice(0, 8)}</code>
                                    </div>
                                  </td>
                                  <td>{thread.cwd ?? "Unknown workspace"}</td>
                                  <td>{formatDate(thread.updatedAt)}</td>
                                  <td>{formatBytes(thread.rawRolloutBytes)}</td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>

                      <div className="table-footer">
                        <PaginationControls
                          currentPage={threadPageData.page}
                          itemLabel="threads"
                          onPageChange={setThreadPage}
                          pageCount={threadPageData.pageCount}
                          pageSize={threadPageData.pageSize}
                          totalItems={threadPageData.totalItems}
                        />
                      </div>
                    </>
                  ) : (
                    <EmptySurfaceCard body={sectionCopy.emptyBody} title={sectionCopy.emptyTitle} />
                  )}
                </section>

                <aside className="inspector">
                  {selectedThread ? (
                    <ThreadInspector
                      busyToken={busyToken}
                      familyRolloutBytes={
                        familySizeByThreadId.get(selectedThread.threadId) ??
                        selectedThread.rawRolloutBytes
                      }
                      onArchiveToggle={handleArchiveToggle}
                      onBackup={handleThreadBackup}
                      onCopyThreadId={handleCopyText}
                      onRevealPath={handleRevealPath}
                      onTrash={handleThreadTrash}
                      thread={selectedThread}
                    />
                  ) : (
                    <div className="empty-inspector">
                      <h3>{sectionCopy.emptyTitle}</h3>
                      <p>{sectionCopy.emptyBody}</p>
                    </div>
                  )}
                </aside>
              </div>
            )}

            {section === "subagents" && (
              <div className="content-grid">
                <section className="table-panel families-panel">
                  <div className="table-header">
                    <div>
                      <p className="panel-label">Families</p>
                      <p className="panel-value">{visibleSurface.families.length}</p>
                    </div>
                    <div>
                      <p className="panel-label">Stored subagents</p>
                      <p className="panel-value">{catalog.subagentThreads.length}</p>
                    </div>
                    <div>
                      <p className="panel-label">Subagent storage</p>
                      <p className="panel-value">{formatBytes(catalog.subagentBytes)}</p>
                    </div>
                  </div>
                  {familyPageData.items.length > 0 ? (
                    <>
                      <div className="family-summary-list">
                        {familyPageData.items.map((family) => {
                          const isSelected = family.familyId === selectedFamily?.familyId;
                          return (
                            <button
                              key={family.familyId}
                              type="button"
                              className={
                                isSelected
                                  ? "family-summary-row family-summary-row-selected"
                                  : "family-summary-row"
                              }
                              onClick={() => {
                                setSelectedFamilyId(family.familyId);
                                setFamilyThreadPage(1);
                              }}
                            >
                              <div className="family-summary-copy">
                                <strong>{family.parentTitle}</strong>
                                <span>
                                  {family.memberThreadIds.length} family threads
                                  {family.isOrphaned ? " · orphaned parent" : ""}
                                </span>
                              </div>
                              <div className="family-summary-metrics">
                                <span>{family.threads.length} subagents</span>
                                <span>{formatDate(family.latestUpdatedAt)}</span>
                                <strong>{formatBytes(family.totalBytes)}</strong>
                              </div>
                            </button>
                          );
                        })}
                      </div>
                      <div className="table-footer">
                        <PaginationControls
                          currentPage={familyPageData.page}
                          itemLabel="families"
                          onPageChange={setFamilyPage}
                          pageCount={familyPageData.pageCount}
                          pageSize={familyPageData.pageSize}
                          totalItems={familyPageData.totalItems}
                        />
                      </div>
                    </>
                  ) : (
                    <EmptySurfaceCard body={sectionCopy.emptyBody} title={sectionCopy.emptyTitle} />
                  )}
                </section>

                <aside className="inspector">
                  {selectedFamily ? (
                    <SubagentFamilyInspector
                      busyToken={busyToken}
                      family={selectedFamily}
                      onAction={handleFamilyAction}
                      onArchiveToggle={handleArchiveToggle}
                      onPageChange={setFamilyThreadPage}
                      pageData={familyThreadPageData}
                    />
                  ) : (
                    <div className="empty-inspector">
                      <h3>{sectionCopy.emptyTitle}</h3>
                      <p>{sectionCopy.emptyBody}</p>
                    </div>
                  )}
                </aside>
              </div>
            )}

            {section === "workspaces" && (
              <div className="content-grid">
                <section className="table-panel">
                  <div className="table-header">
                    <div>
                      <p className="panel-label">Visible workspaces</p>
                      <p className="panel-value">{visibleWorkspaces.length}</p>
                    </div>
                    <div>
                      <p className="panel-label">Indexed threads</p>
                      <p className="panel-value">{catalog.topLevelThreads.length + catalog.subagentThreads.length}</p>
                    </div>
                    <div>
                      <p className="panel-label">Largest workspace</p>
                      <p className="panel-value">
                        {visibleWorkspaces[0] ? formatBytes(visibleWorkspaces[0].summary.totalBytes) : "0 B"}
                      </p>
                    </div>
                  </div>

                  {workspacePageData.items.length > 0 ? (
                    <>
                      <div className="workspace-list">
                        {workspacePageData.items.map((group) => {
                          const isSelected =
                            group.summary.workspaceKey === selectedWorkspace?.summary.workspaceKey;
                          return (
                            <button
                              key={group.summary.workspaceKey}
                              type="button"
                              className={
                                isSelected ? "workspace-row workspace-row-selected" : "workspace-row"
                              }
                              onClick={() => setSelectedWorkspaceKey(group.summary.workspaceKey)}
                            >
                              <div className="workspace-row-copy">
                                <strong>{group.summary.workspaceLabel}</strong>
                                <span>
                                  {group.summary.threadCount} threads · {group.summary.subagentCount} subagents
                                </span>
                              </div>
                              <div className="workspace-row-metrics">
                                <span>{formatDate(group.summary.latestUpdatedAt)}</span>
                                <strong>{formatBytes(group.summary.totalBytes)}</strong>
                              </div>
                            </button>
                          );
                        })}
                      </div>
                      <div className="table-footer">
                        <PaginationControls
                          currentPage={workspacePageData.page}
                          itemLabel="workspaces"
                          onPageChange={setWorkspacePage}
                          pageCount={workspacePageData.pageCount}
                          pageSize={workspacePageData.pageSize}
                          totalItems={workspacePageData.totalItems}
                        />
                      </div>
                    </>
                  ) : (
                    <EmptySurfaceCard body={sectionCopy.emptyBody} title={sectionCopy.emptyTitle} />
                  )}
                </section>

                <aside className="inspector">
                  {selectedWorkspace ? (
                    <WorkspaceInspector
                      group={selectedWorkspace}
                      onCopy={handleCopyText}
                      onRevealPath={handleRevealPath}
                    />
                  ) : (
                    <div className="empty-inspector">
                      <h3>{sectionCopy.emptyTitle}</h3>
                      <p>{sectionCopy.emptyBody}</p>
                    </div>
                  )}
                </aside>
              </div>
            )}

            {section === "backups" && (
              <>
                <section className="backup-panel">
                  <div className="backup-header">
                    <div>
                      <p className="panel-label">Default export directory</p>
                      <p className="panel-value backup-path">
                        {backupInventory?.backupDirectory ?? (backupDirectory || "Loading...")}
                      </p>
                    </div>
                    <div>
                      <p className="panel-label">Recorded artifacts</p>
                      <p className="panel-value">{backupRecords.length}</p>
                    </div>
                    <div>
                      <p className="panel-label">Rollout bytes exported</p>
                      <p className="panel-value">{formatBytes(totalExportedBytes)}</p>
                    </div>
                    <div>
                      <p className="panel-label">Default format</p>
                      <p className="panel-value">{backupFormat === "folder" ? "Folder" : "Zip"}</p>
                    </div>
                  </div>

                  <div className="backup-directory-row">
                    <label className="backup-directory-field">
                      <span>Export directory</span>
                      <input
                        value={backupDirectory}
                        onChange={(event) => setBackupDirectory(event.target.value)}
                        placeholder="Choose a folder path for backup exports"
                      />
                    </label>
                    <button
                      type="button"
                      className="action-secondary backup-refresh"
                      onClick={() => void handleBackupRefresh()}
                    >
                      {backupInventoryState.kind === "loading" ? "Refreshing..." : "Refresh inventory"}
                    </button>
                  </div>
                </section>

                <BackupHealthPanel health={backupHealth} issues={backupIssues} />

                <section className="utility-grid">
                  <article className="backup-panel">
                    <div className="inspector-heading">
                      <p className="eyebrow">Restore / Import</p>
                      <h3>Import a backup artifact</h3>
                    </div>
                    <label className="backup-directory-field">
                      <span>Artifact path</span>
                      <input
                        value={importArtifactPath}
                        onChange={(event) => {
                          setImportArtifactPath(event.target.value);
                          setBackupImportPreview(null);
                        }}
                        placeholder="Paste a .threaddock-backup.zip or .threaddock-backup path"
                      />
                    </label>
                    <div className="filter-mini-grid">
                      <label className="filter-field">
                        <span>Collision mode</span>
                        <select
                          value={importCollisionMode}
                          onChange={(event) => setImportCollisionMode(event.target.value as "skip" | "replace")}
                        >
                          <option value="skip">Skip existing threads</option>
                          <option value="replace">Replace existing threads</option>
                        </select>
                      </label>
                      <label className="filter-field">
                        <span>Restore mode</span>
                        <select
                          value={importRestoreMode}
                          onChange={(event) =>
                            setImportRestoreMode(
                              event.target.value as "archive_only" | "preserve_status",
                            )
                          }
                        >
                          <option value="archive_only">Restore into archive vault</option>
                          <option value="preserve_status">Preserve exported status</option>
                        </select>
                      </label>
                    </div>
                    {backupImportPreview ? (
                      <RestoreWizardPreview
                        collisionMode={importCollisionMode}
                        currentCodexHome={state.snapshot.codexHome}
                        preview={backupImportPreview}
                        restoreMode={importRestoreMode}
                      />
                    ) : (
                      <p className="action-note">
                        Preview verifies the manifest and SHA-256 checksums before ThreadDock writes anything.
                      </p>
                    )}
                    <div className="action-row">
                      <button
                        type="button"
                        className="action-secondary"
                        disabled={busyToken === "import:preview"}
                        onClick={() => void handlePreviewBackupImport()}
                      >
                        {busyToken === "import:preview" ? "Previewing..." : "Preview backup"}
                      </button>
                      <button
                        type="button"
                        className="action-primary"
                        disabled={busyToken === "import:artifact" || !backupImportPreview}
                        onClick={() => void handleImportArtifact()}
                      >
                        {busyToken === "import:artifact" ? "Importing..." : "Import artifact"}
                      </button>
                    </div>
                  </article>

                  <article className="backup-panel">
                    <div className="inspector-heading">
                      <p className="eyebrow">Secure Handoff</p>
                      <h3>Import encrypted handoff</h3>
                    </div>
                    <label className="backup-directory-field">
                      <span>Handoff file</span>
                      <input
                        value={handoffImportPath}
                        onChange={(event) => {
                          setHandoffImportPath(event.target.value);
                          setHandoffPreview(null);
                        }}
                        placeholder="Paste a .threaddock-handoff path"
                      />
                    </label>
                    <label className="backup-directory-field">
                      <span>Recovery phrase</span>
                      <input
                        type="password"
                        autoComplete="off"
                        spellCheck={false}
                        value={handoffPassphrase}
                        onChange={(event) => {
                          setHandoffPassphrase(event.target.value);
                          setHandoffPreview(null);
                        }}
                        placeholder="Paste the recovery phrase or passphrase"
                      />
                    </label>
                    {handoffPreview ? (
                      <div className="handoff-card">
                        <strong>{handoffPreview.label}</strong>
                        <span>
                          {handoffPreview.threadCount} thread{handoffPreview.threadCount === 1 ? "" : "s"} ·{" "}
                          {formatBytes(handoffPreview.totalBytes)} rollout ·{" "}
                          {formatBytes(handoffPreview.artifactBytes)} artifact
                        </span>
                        <span>
                          {handoffPreview.algorithm} · {handoffPreview.kdf}
                        </span>
                        <code>{handoffPreview.threadIds.slice(0, 4).join(", ")}</code>
                      </div>
                    ) : (
                      <p className="action-note">
                        Preview decrypts into a temporary staging area, verifies the checksum, then removes the staging file.
                      </p>
                    )}
                    <div className="action-row">
                      <button
                        type="button"
                        className="action-secondary"
                        disabled={busyToken === "handoff:preview"}
                        onClick={() => void handlePreviewHandoff()}
                      >
                        {busyToken === "handoff:preview" ? "Previewing..." : "Preview handoff"}
                      </button>
                      <button
                        type="button"
                        className="action-primary"
                        disabled={busyToken === "handoff:import" || !handoffPreview}
                        onClick={() => void handleImportHandoff()}
                      >
                        {busyToken === "handoff:import" ? "Decrypting..." : "Decrypt and import"}
                      </button>
                    </div>
                    <p className="action-note">
                      File-based and local-only. No open port, no LAN discovery, no cloud handoff.
                    </p>
                  </article>
                </section>

                <div className="content-grid">
                  <section className="table-panel">
                    <div className="table-header">
                      <div>
                        <p className="panel-label">Visible exports</p>
                        <p className="panel-value">{backupRecords.length}</p>
                      </div>
                      <div>
                        <p className="panel-label">Inventory scanned</p>
                        <p className="panel-value">{formatDate(backupInventory?.scannedAt ?? null)}</p>
                      </div>
                      <div>
                        <p className="panel-label">Directory</p>
                        <p className="panel-value backup-path">
                          {backupInventory?.backupDirectory ?? (backupDirectory || "Unavailable")}
                        </p>
                      </div>
                    </div>
                    {backupPageData.items.length > 0 ? (
                      <>
                        <div className="table-wrap">
                          <table>
                            <thead>
                              <tr>
                                <th>Export</th>
                                <th>Created</th>
                                <th>Threads</th>
                                <th>Rollout bytes</th>
                              </tr>
                            </thead>
                            <tbody>
                              {backupPageData.items.map((record) => {
                                const isSelected = record.backupId === selectedBackup?.backupId;
                                return (
                                  <tr
                                    key={record.backupId}
                                    className={isSelected ? "row-selected" : undefined}
                                    onClick={() => setSelectedBackupId(record.backupId)}
                                  >
                                    <td>
                                      <div className="title-cell">
                                        <span>{record.label}</span>
                                        <code>{record.familyMode ? "family export" : "thread export"}</code>
                                      </div>
                                    </td>
                                    <td>{formatDate(record.createdAt)}</td>
                                    <td>{record.threadCount}</td>
                                    <td>{formatBytes(record.totalBytes)}</td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                        <div className="table-footer">
                          <PaginationControls
                            currentPage={backupPageData.page}
                            itemLabel="exports"
                            onPageChange={setBackupPage}
                            pageCount={backupPageData.pageCount}
                            pageSize={backupPageData.pageSize}
                            totalItems={backupPageData.totalItems}
                          />
                        </div>
                      </>
                    ) : (
                      <EmptySurfaceCard body={sectionCopy.emptyBody} title={sectionCopy.emptyTitle} />
                    )}
                  </section>

                  <aside className="inspector inspector-stack">
                    {selectedBackup ? (
                      <BackupInspector
                        backup={selectedBackup}
                        busyToken={busyToken}
                        onRevealPath={handleRevealPath}
                        onCreateHandoff={handleCreateHandoff}
                      />
                    ) : (
                      <div className="empty-inspector">
                        <h3>{sectionCopy.emptyTitle}</h3>
                        <p>{sectionCopy.emptyBody}</p>
                      </div>
                    )}
                    <SecureHandoffCard
                      handoff={lastHandoff}
                      onCopy={handleCopyText}
                      onRevealPath={handleRevealPath}
                      onToggleSecret={() => setShowHandoffSecret((value) => !value)}
                      showSecret={showHandoffSecret}
                    />
                  </aside>
                </div>
              </>
            )}

            {section === "trash" && (
              <div className="content-grid">
                <section className="table-panel">
                  <div className="table-header">
                    <div>
                      <p className="panel-label">Trash entries</p>
                      <p className="panel-value">{visibleTrash.length}</p>
                    </div>
                    <div>
                      <p className="panel-label">Restorable bytes</p>
                      <p className="panel-value">
                        {formatBytes(visibleTrash.reduce((total, record) => total + record.rawRolloutBytes, 0))}
                      </p>
                    </div>
                    <div>
                      <p className="panel-label">Guard</p>
                      <p className="panel-value">30 days before purge</p>
                    </div>
                  </div>

                  {trashPageData.items.length > 0 ? (
                    <>
                      {selectedVisibleTrash.length > 0 && (
                        <div className="selection-bar">
                          <div>
                            <p className="panel-label">Selected trash entries</p>
                            <p className="panel-value">{selectedVisibleTrash.length}</p>
                          </div>
                          <div className="selection-actions">
                            <button
                              type="button"
                              className="action-primary selection-action"
                              onClick={() => handleTrashBulkAction("restore")}
                            >
                              Restore selected
                            </button>
                            <button
                              type="button"
                              className="action-secondary selection-action"
                              onClick={() => handleTrashBulkAction("purge")}
                            >
                              Delete permanently
                            </button>
                            <button
                              type="button"
                              className="action-secondary selection-action"
                              onClick={() => setSelectedTrashIds([])}
                            >
                              Clear
                            </button>
                          </div>
                        </div>
                      )}
                      <div className="table-wrap">
                        <table>
                          <thead>
                            <tr>
                              <th>
                                <input
                                  type="checkbox"
                                  checked={
                                    trashPageData.items.length > 0 &&
                                    trashPageData.items.every((record) =>
                                      selectedTrashIds.includes(record.trashId),
                                    )
                                  }
                                  onChange={(event) =>
                                    handleTrashPageSelection(
                                      trashPageData.items.map((record) => record.trashId),
                                      event.target.checked,
                                    )
                                  }
                                />
                              </th>
                              <th>Thread</th>
                              <th>Deleted</th>
                              <th>Expires</th>
                              <th>Rollout size</th>
                            </tr>
                          </thead>
                          <tbody>
                            {trashPageData.items.map((record) => {
                              const isSelected = record.trashId === selectedTrash?.trashId;
                              return (
                                <tr
                                  key={record.trashId}
                                  className={isSelected ? "row-selected" : undefined}
                                  onClick={() => setSelectedTrashId(record.trashId)}
                                >
                                  <td onClick={(event) => event.stopPropagation()}>
                                    <input
                                      type="checkbox"
                                      checked={selectedTrashIds.includes(record.trashId)}
                                      onChange={(event) =>
                                        handleTrashSelection(record.trashId, event.target.checked)
                                      }
                                    />
                                  </td>
                                  <td>
                                    <div className="title-cell">
                                      <span>{record.title}</span>
                                      <code>{record.threadId.slice(0, 8)}</code>
                                    </div>
                                  </td>
                                  <td>{formatDate(record.deletedAt)}</td>
                                  <td>{formatTrashGuard(record.expiresAt)}</td>
                                  <td>{formatBytes(record.rawRolloutBytes)}</td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                      <div className="table-footer">
                        <PaginationControls
                          currentPage={trashPageData.page}
                          itemLabel="trash entries"
                          onPageChange={setTrashPage}
                          pageCount={trashPageData.pageCount}
                          pageSize={trashPageData.pageSize}
                          totalItems={trashPageData.totalItems}
                        />
                      </div>
                    </>
                  ) : (
                    <EmptySurfaceCard body={sectionCopy.emptyBody} title={sectionCopy.emptyTitle} />
                  )}
                </section>

                <aside className="inspector">
                  {selectedTrash ? (
                    <TrashInspector
                      onAction={handleSingleTrashAction}
                      onCopy={handleCopyText}
                      onRevealPath={handleRevealPath}
                      record={selectedTrash}
                    />
                  ) : (
                    <div className="empty-inspector">
                      <h3>{sectionCopy.emptyTitle}</h3>
                      <p>{sectionCopy.emptyBody}</p>
                    </div>
                  )}
                </aside>
              </div>
            )}

            {section === "rules" && (
              <div className="content-grid">
                <section className="table-panel">
                  <div className="table-header">
                    <div>
                      <p className="panel-label">Saved rules</p>
                      <p className="panel-value">{cleanupRules.length}</p>
                    </div>
                    <div>
                      <p className="panel-label">Current draft matches</p>
                      <p className="panel-value">{rulePreviewThreads.length}</p>
                    </div>
                    <div>
                      <p className="panel-label">Draft bytes</p>
                      <p className="panel-value">
                        {formatBytes(rulePreviewThreads.reduce((total, thread) => total + thread.rawRolloutBytes, 0))}
                      </p>
                    </div>
                  </div>
                  <div className="rule-form">
                    <label className="backup-directory-field">
                      <span>Rule name</span>
                      <input
                        value={ruleDraft.name}
                        onChange={(event) =>
                          setRuleDraft((current) => ({ ...current, name: event.target.value }))
                        }
                        placeholder="e.g. Archive stale Android runs"
                      />
                    </label>
                    <div className="filter-mini-grid">
                      <label className="filter-field">
                        <span>Action</span>
                        <select
                          value={ruleDraft.action}
                          onChange={(event) =>
                            setRuleDraft((current) => ({
                              ...current,
                              action: event.target.value as RuleAction,
                            }))
                          }
                        >
                          <option value="archive">Archive matches</option>
                          <option value="trash">Move matches to trash</option>
                        </select>
                      </label>
                      <label className="filter-field">
                        <span>Scope</span>
                        <select
                          value={ruleDraft.scope}
                          onChange={(event) =>
                            setRuleDraft((current) => ({
                              ...current,
                              scope: event.target.value as RuleScope,
                            }))
                          }
                        >
                          <option value="active">Active only</option>
                          <option value="archived">Archived only</option>
                          <option value="all">Any status</option>
                        </select>
                      </label>
                      <label className="filter-field">
                        <span>Older than days</span>
                        <input
                          value={ruleDraft.olderThanDays}
                          onChange={(event) =>
                            setRuleDraft((current) => ({
                              ...current,
                              olderThanDays: event.target.value,
                            }))
                          }
                          placeholder="30"
                        />
                      </label>
                      <label className="filter-field">
                        <span>Minimum MB</span>
                        <input
                          value={ruleDraft.minBytesMb}
                          onChange={(event) =>
                            setRuleDraft((current) => ({
                              ...current,
                              minBytesMb: event.target.value,
                            }))
                          }
                          placeholder="25"
                        />
                      </label>
                    </div>
                    <label className="backup-directory-field">
                      <span>Workspace filter</span>
                      <input
                        value={ruleDraft.workspaceFilter}
                        onChange={(event) =>
                          setRuleDraft((current) => ({
                            ...current,
                            workspaceFilter: event.target.value,
                          }))
                        }
                        placeholder="Filter matching workspaces"
                      />
                    </label>
                    <label className="checkbox-field">
                      <input
                        type="checkbox"
                        checked={ruleDraft.includeSubagents}
                        onChange={(event) =>
                          setRuleDraft((current) => ({
                            ...current,
                            includeSubagents: event.target.checked,
                          }))
                        }
                      />
                      <span>Include subagent descendants</span>
                    </label>
                    <div className="action-row action-row-wrap">
                      <button type="button" className="action-primary" onClick={() => void handleSaveRule()}>
                        Save rule
                      </button>
                      <button
                        type="button"
                        className="action-secondary"
                        disabled={rulePreviewThreads.length === 0}
                        onClick={() =>
                          handleRunRule({
                            action: ruleDraft.action,
                            createdAt: new Date().toISOString(),
                            includeSubagents: ruleDraft.includeSubagents,
                            minBytesMb: ruleDraft.minBytesMb,
                            name: ruleDraft.name || "Draft rule",
                            olderThanDays: ruleDraft.olderThanDays,
                            ruleId: "draft",
                            scope: ruleDraft.scope,
                            workspaceFilter: ruleDraft.workspaceFilter,
                          })
                        }
                      >
                        Preview and run draft
                      </button>
                    </div>
                  </div>
                </section>

                <aside className="inspector inspector-stack">
                  <RuleInspector
                    matches={rulePreviewThreads}
                    onDelete={selectedRule ? handleDeleteRule : undefined}
                    onRun={selectedRule ? handleRunRule : undefined}
                    rule={selectedRule}
                    savedRules={cleanupRules}
                    selectedRuleId={selectedRuleId}
                    setSelectedRuleId={setSelectedRuleId}
                  />
                </aside>
              </div>
            )}

            {section === "health" && healthData && (
              <HealthPage backupCount={backupRecords.length} catalog={catalog} healthData={healthData} />
            )}

            {section === "settings" && (
              <SettingsPage
                alternateArchivePath={alternateArchivePath}
                appServerMessage={state.snapshot.appServer.message}
                appServerReady={state.snapshot.appServer.available}
                backupDirectory={backupDirectory}
                backupFormat={backupFormat}
                codexBinaryPath={codexBinaryPath}
                codexHome={state.snapshot.codexHome}
                codexHomeOverride={codexHomeOverride}
                currentVersion={APP_VERSION}
                githubRepository={githubRepository}
                onAlternateArchivePathChange={setAlternateArchivePath}
                onBackupDirectoryChange={setBackupDirectory}
                onBackupFormatChange={setBackupFormat}
                onCheckUpdates={handleCheckUpdates}
                onCodexBinaryPathChange={setCodexBinaryPath}
                onCodexHomeOverrideChange={setCodexHomeOverride}
                onGithubRepositoryChange={setGithubRepository}
                onRefreshBackups={handleBackupRefresh}
                onResetPaths={handleSettingsReset}
                onRevealBackupDirectory={handleRevealPath}
                onSave={handleSettingsSave}
                scannedAt={state.snapshot.scannedAt}
                updateStatus={updateStatus}
              />
            )}
          </>
        )}
      </main>

      {previewState && (
        <BulkPreviewDialog
          busy={busyToken === `preview:${previewState.confirmLabel}`}
          onCancel={() => setPreviewState(null)}
          onConfirm={() => void handlePreviewExecute()}
          preview={previewState}
        />
      )}
    </div>
  );
}

function SummaryCard({
  active = false,
  description,
  label,
  onClick,
  value,
}: {
  active?: boolean;
  description: string;
  label: string;
  onClick?: () => void;
  value: string;
}) {
  const className = active
    ? "summary-card summary-card-button summary-card-active"
    : onClick
      ? "summary-card summary-card-button"
      : "summary-card";
  if (!onClick) {
    return (
      <article className={className}>
        <p>{label}</p>
        <strong>{value}</strong>
        <span className="summary-detail">{description}</span>
      </article>
    );
  }
  return (
    <button type="button" className={className} onClick={onClick}>
      <p>{label}</p>
      <strong>{value}</strong>
      <span className="summary-detail">{description}</span>
    </button>
  );
}

function SavedViewsBar({
  activeSavedViewId,
  name,
  onApply,
  onDelete,
  onNameChange,
  onSave,
  savedViews,
}: {
  activeSavedViewId: null | string;
  name: string;
  onApply: (view: SavedViewRecord) => void;
  onDelete: (viewId: string) => Promise<void>;
  onNameChange: (value: string) => void;
  onSave: () => Promise<void>;
  savedViews: SavedViewRecord[];
}) {
  return (
    <section className="saved-view-panel">
      <div className="saved-view-head">
        <div>
          <p className="panel-label">Saved views</p>
          <p className="panel-value">{savedViews.length}</p>
        </div>
        <div className="saved-view-controls">
          <input
            value={name}
            onChange={(event) => onNameChange(event.target.value)}
            placeholder="Save current filters as..."
          />
          <button type="button" className="action-secondary compact-button" onClick={() => void onSave()}>
            Save current view
          </button>
        </div>
      </div>
      {savedViews.length > 0 ? (
        <div className="chip-row">
          {savedViews.map((view) => (
            <div key={view.viewId} className="chip-shell">
              <button
                type="button"
                className={view.viewId === activeSavedViewId ? "chip-button chip-button-active" : "chip-button"}
                onClick={() => onApply(view)}
              >
                {view.name}
              </button>
              <button
                type="button"
                className="chip-delete"
                onClick={() => void onDelete(view.viewId)}
                aria-label={`Delete ${view.name}`}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      ) : (
        <p className="action-note">
          Save common searches such as largest archived threads, stale workspaces, or subagent-only cleanup passes.
        </p>
      )}
    </section>
  );
}

function AdvancedFilterBar({
  filters,
  onChange,
}: {
  filters: ThreadFilters;
  onChange: (partial: Partial<ThreadFilters>) => void;
}) {
  return (
    <section className="filter-stack">
      <div className="filter-bar filter-bar-advanced">
        <label className="filter-field">
          <span>Workspace</span>
          <input
            value={filters.workspaceFilter}
            onChange={(event) => onChange({ workspaceFilter: event.target.value })}
            placeholder="Filter by working directory"
          />
        </label>
        <label className="filter-field">
          <span>Thread ID</span>
          <input
            value={filters.threadIdQuery}
            onChange={(event) => onChange({ threadIdQuery: event.target.value })}
            placeholder="Filter by thread id"
          />
        </label>
        <label className="filter-field">
          <span>Parent thread</span>
          <input
            value={filters.parentThreadIdQuery}
            onChange={(event) => onChange({ parentThreadIdQuery: event.target.value })}
            placeholder="Filter by parent thread id"
          />
        </label>
        <label className="filter-field">
          <span>Source</span>
          <select
            value={filters.sourceFilter}
            onChange={(event) => onChange({ sourceFilter: event.target.value as SourceFilter })}
          >
            <option value="all">Any source</option>
            <option value="user">User threads</option>
            <option value="subagent">Subagent threads</option>
            <option value="unknown">Unknown source</option>
          </select>
        </label>
        <label className="filter-field">
          <span>Read-only</span>
          <select
            value={filters.includeReadOnly}
            onChange={(event) => onChange({ includeReadOnly: event.target.value as IncludeReadOnly })}
          >
            <option value="all">Include all</option>
            <option value="exclude">Exclude read-only</option>
            <option value="only">Only read-only</option>
          </select>
        </label>
        <label className="filter-field">
          <span>Updated from</span>
          <input
            type="date"
            value={filters.dateFrom}
            onChange={(event) => onChange({ dateFrom: event.target.value })}
          />
        </label>
        <label className="filter-field">
          <span>Updated to</span>
          <input
            type="date"
            value={filters.dateTo}
            onChange={(event) => onChange({ dateTo: event.target.value })}
          />
        </label>
        <label className="filter-field">
          <span>Minimum MB</span>
          <input
            value={filters.minBytesMb}
            onChange={(event) => onChange({ minBytesMb: event.target.value })}
            placeholder="0"
          />
        </label>
        <label className="filter-field">
          <span>Maximum MB</span>
          <input
            value={filters.maxBytesMb}
            onChange={(event) => onChange({ maxBytesMb: event.target.value })}
            placeholder="500"
          />
        </label>
        <label className="filter-field filter-field-compact">
          <span>Sort</span>
          <select
            value={filters.sortKey}
            onChange={(event) => onChange({ sortKey: event.target.value as ThreadSortKey })}
          >
            <option value="updated_desc">Latest update</option>
            <option value="created_desc">Newest created</option>
            <option value="title_asc">Title A-Z</option>
            <option value="size_desc">Largest rollout</option>
          </select>
        </label>
      </div>
    </section>
  );
}

type LensMetric = {
  detail?: string;
  label: string;
  value: string;
};

function InspectorLens({
  badge,
  children,
  className,
  code,
  danger,
  eyebrow,
  metrics,
  note,
  primaryActions,
  secondaryActions,
  title,
  tone,
}: {
  badge?: ReactNode;
  children?: ReactNode;
  className?: string;
  code?: string;
  danger?: ReactNode;
  eyebrow: string;
  metrics?: LensMetric[];
  note?: string;
  primaryActions?: ReactNode;
  secondaryActions?: ReactNode;
  title: string;
  tone: string;
}) {
  const classes = ["inspector-card", "lens-card", `lens-${tone}`, className].filter(Boolean).join(" ");
  return (
    <div className={classes}>
      <div className="lens-topline">
        <p className="eyebrow">{eyebrow}</p>
        {badge}
      </div>
      <div className="lens-heading">
        <h3>{title}</h3>
        {code && <code>{code}</code>}
      </div>
      {metrics && metrics.length > 0 && (
        <div className="lens-metrics">
          {metrics.map((metric) => (
            <div key={metric.label}>
              <span>{metric.label}</span>
              <strong>{metric.value}</strong>
              {metric.detail && <em>{metric.detail}</em>}
            </div>
          ))}
        </div>
      )}
      {note && <p className="lens-note">{note}</p>}
      {children && <div className="lens-body">{children}</div>}
      {(primaryActions || secondaryActions) && (
        <div className="lens-action-dock">
          {primaryActions && <div className="lens-action-row lens-action-row-primary">{primaryActions}</div>}
          {secondaryActions && <div className="lens-action-row lens-action-row-secondary">{secondaryActions}</div>}
        </div>
      )}
      {danger && (
        <details className="lens-danger-zone">
          <summary>Lifecycle operations</summary>
          <div className="lens-danger-body">{danger}</div>
        </details>
      )}
    </div>
  );
}

function LensPath({ label, value }: { label: string; value: string }) {
  return (
    <div className="lens-path">
      <span>{label}</span>
      <code>{value}</code>
    </div>
  );
}

function ThreadInspector({
  busyToken,
  familyRolloutBytes,
  onArchiveToggle,
  onBackup,
  onCopyThreadId,
  onRevealPath,
  onTrash,
  thread,
}: {
  busyToken: null | string;
  familyRolloutBytes: number;
  onArchiveToggle: (thread: ThreadRecord) => Promise<void>;
  onBackup: (thread: ThreadRecord) => Promise<void>;
  onCopyThreadId: (value: string, label: string) => Promise<void>;
  onRevealPath: (path: string) => Promise<void>;
  onTrash: (thread: ThreadRecord) => void;
  thread: ThreadRecord;
}) {
  const action =
    thread.status === "archived"
      ? { kind: "unarchive" as const, label: "Restore", pendingLabel: "Restoring..." }
      : { kind: "archive" as const, label: "Archive", pendingLabel: "Archiving..." };
  const isArchivePending = busyToken === `thread:${action.kind}:${thread.threadId}`;
  const isBackupPending = busyToken === `backup:thread:${thread.threadId}`;
  return (
    <InspectorLens
      badge={<StatusBadge status={thread.status} />}
      code={thread.threadId}
      danger={
        <>
          <button
            type="button"
            className="action-secondary"
            disabled={isArchivePending || thread.readOnly}
            onClick={() => void onArchiveToggle(thread)}
          >
            {thread.readOnly ? "Read-only archive" : isArchivePending ? action.pendingLabel : action.label}
          </button>
          <button
            type="button"
            className="action-secondary action-danger-outline"
            disabled={thread.readOnly}
            onClick={() => onTrash(thread)}
          >
            Move to trash
          </button>
        </>
      }
      eyebrow="Thread lens"
      metrics={[
        { label: "Rollout", value: formatBytes(thread.rawRolloutBytes), detail: "single file" },
        { label: "Family", value: formatBytes(familyRolloutBytes), detail: "estimated" },
        { label: "Updated", value: formatDate(thread.updatedAt), detail: thread.threadSource },
      ]}
      note={isSubagentThread(thread) ? "Subagent runs stay scoped to family cleanup." : "Top-level thread ready for backup, reveal, or lifecycle review."}
      primaryActions={
        <button
          type="button"
          className="action-primary"
          disabled={isBackupPending}
          onClick={() => void onBackup(thread)}
        >
          {isBackupPending ? "Exporting..." : "Backup"}
        </button>
      }
      secondaryActions={
        <>
          <button type="button" className="action-secondary" onClick={() => void onRevealPath(thread.rolloutPath)}>
            Reveal file
          </button>
          <button
            type="button"
            className="action-secondary"
            onClick={() => void onCopyThreadId(thread.threadId, "thread id")}
          >
            Copy ID
          </button>
        </>
      }
      title={thread.title}
      tone="thread"
    >
      <dl className="detail-list lens-detail-list">
        <div>
          <dt>Type</dt>
          <dd>{isSubagentThread(thread) ? "subagent" : "top-level thread"}</dd>
        </div>
        <div>
          <dt>Created</dt>
          <dd>{formatDate(thread.createdAt)}</dd>
        </div>
      </dl>
      <LensPath label="Working directory" value={thread.cwd ?? "Unknown"} />
      <LensPath label="Rollout path" value={thread.rolloutPath} />
    </InspectorLens>
  );
}

function SubagentFamilyInspector({
  busyToken,
  family,
  onAction,
  onArchiveToggle,
  onPageChange,
  pageData,
}: {
  busyToken: null | string;
  family: FamilyGroup;
  onAction: (family: FamilyGroup, action: "archive" | "backup" | "trash" | "unarchive") => void;
  onArchiveToggle: (thread: ThreadRecord) => Promise<void>;
  onPageChange: (page: number) => void;
  pageData: PaginatedResult<ThreadRecord>;
}) {
  const familyMembers = getFamilyMembers(family);
  return (
    <InspectorLens
      code={formatFamilyLabel(family.parentThreadId)}
      danger={
        <>
          <button type="button" className="action-secondary" onClick={() => onAction(family, "archive")}>
            Archive family
          </button>
          <button type="button" className="action-secondary" onClick={() => onAction(family, "unarchive")}>
            Restore family
          </button>
          <button type="button" className="action-secondary action-danger-outline" onClick={() => onAction(family, "trash")}>
            Move family to trash
          </button>
        </>
      }
      eyebrow="Family lens"
      metrics={[
        { label: "Threads", value: String(family.memberThreadIds.length), detail: "parent + children" },
        { label: "Subagents", value: String(family.threads.length), detail: family.isOrphaned ? "orphaned" : "linked" },
        { label: "Storage", value: formatBytes(family.totalBytes), detail: formatDate(family.latestUpdatedAt) },
      ]}
      note="A family lens keeps subagent runs visually separate from normal thread work."
      primaryActions={
        <button type="button" className="action-primary" onClick={() => onAction(family, "backup")}>
          Backup family
        </button>
      }
      title={family.parentTitle}
      tone="family"
    >
      <div className="timeline-card">
        <p className="eyebrow">Family timeline</p>
        <div className="timeline">
          {familyMembers
            .slice()
            .sort((left, right) => compareDates(right.updatedAt, left.updatedAt))
            .map((thread) => (
              <div
                key={thread.threadId}
                className={thread.threadId === family.parentThread?.threadId ? "timeline-item timeline-item-parent" : "timeline-item"}
              >
                <div>
                  <strong>{thread.title}</strong>
                  <span>{thread.threadId.slice(0, 8)}</span>
                </div>
                <div>
                  <span>{thread.status}</span>
                  <span>{formatDate(thread.updatedAt)}</span>
                </div>
              </div>
            ))}
        </div>
      </div>

      <div className="subagent-table-wrap">
        <table>
          <thead>
            <tr>
              <th>Thread</th>
              <th>Status</th>
              <th>Updated</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {pageData.items.map((thread) => {
              const token =
                thread.status === "archived"
                  ? `thread:unarchive:${thread.threadId}`
                  : `thread:archive:${thread.threadId}`;
              return (
                <tr key={thread.threadId}>
                  <td>
                    <div className="title-cell">
                      <span>{thread.title}</span>
                      <code>{thread.threadId.slice(0, 8)}</code>
                    </div>
                  </td>
                  <td>
                    <StatusBadge status={thread.status} />
                  </td>
                  <td>{formatDate(thread.updatedAt)}</td>
                  <td>
                    <button
                      type="button"
                      className="subagent-action"
                      disabled={busyToken === token}
                      onClick={() => void onArchiveToggle(thread)}
                    >
                      {busyToken === token
                        ? thread.status === "archived"
                          ? "Restoring..."
                          : "Archiving..."
                        : thread.status === "archived"
                          ? "Restore"
                          : "Archive"}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="table-footer">
        <PaginationControls
          currentPage={pageData.page}
          itemLabel="family threads"
          onPageChange={onPageChange}
          pageCount={pageData.pageCount}
          pageSize={pageData.pageSize}
          totalItems={pageData.totalItems}
        />
      </div>
    </InspectorLens>
  );
}

function WorkspaceInspector({
  group,
  onCopy,
  onRevealPath,
}: {
  group: WorkspaceGroup;
  onCopy: (value: string, label: string) => Promise<void>;
  onRevealPath: (path: string) => Promise<void>;
}) {
  const largestThread = sortThreads([...group.threads], "size_desc")[0] ?? null;
  return (
    <InspectorLens
      code={group.summary.workspaceKey}
      eyebrow="Workspace lens"
      metrics={[
        { label: "Threads", value: String(group.summary.threadCount), detail: `${group.summary.subagentCount} subagents` },
        { label: "Storage", value: formatBytes(group.summary.totalBytes), detail: "workspace total" },
        { label: "Latest", value: formatDate(group.summary.latestUpdatedAt), detail: "last activity" },
      ]}
      note="Use this lane to spot oversized workspaces before touching individual threads."
      secondaryActions={
        <>
          <button type="button" className="action-secondary" onClick={() => void onCopy(group.summary.workspaceKey, "workspace key")}>
            Copy key
          </button>
          {largestThread && (
            <button type="button" className="action-secondary" onClick={() => void onRevealPath(largestThread.rolloutPath)}>
              Reveal largest
            </button>
          )}
        </>
      }
      title={group.summary.workspaceLabel}
      tone="workspace"
    >
      <dl className="detail-list lens-detail-list">
        <div>
          <dt>Top-level threads</dt>
          <dd>{group.summary.activeCount + group.summary.archivedCount}</dd>
        </div>
        <div>
          <dt>Subagent descendants</dt>
          <dd>{group.summary.subagentCount}</dd>
        </div>
        <div>
          <dt>Read-only records</dt>
          <dd>{group.summary.readOnlyCount}</dd>
        </div>
        <div>
          <dt>Largest thread</dt>
          <dd>{largestThread ? `${largestThread.title} · ${formatBytes(largestThread.rawRolloutBytes)}` : "None"}</dd>
        </div>
      </dl>
      <div className="mini-list">
        <p className="eyebrow">Top threads</p>
        {sortThreads(group.threads.slice(), "size_desc").slice(0, 5).map((thread) => (
          <button
            key={thread.threadId}
            type="button"
            className="mini-row"
            onClick={() => void onRevealPath(thread.rolloutPath)}
          >
            <span>{thread.title}</span>
            <strong>{formatBytes(thread.rawRolloutBytes)}</strong>
          </button>
        ))}
      </div>
    </InspectorLens>
  );
}

function BackupInspector({
  backup,
  busyToken,
  onCreateHandoff,
  onRevealPath,
}: {
  backup: BackupRecord;
  busyToken: null | string;
  onCreateHandoff: (record: BackupRecord) => Promise<void>;
  onRevealPath: (path: string) => Promise<void>;
}) {
  const isHandoffPending = busyToken === `handoff:create:${backup.backupId}`;
  return (
    <InspectorLens
      code={backup.backupId}
      eyebrow="Backup lens"
      metrics={[
        { label: "Threads", value: String(backup.threadCount), detail: backup.familyMode ? "family export" : "selection" },
        { label: "Rollout", value: formatBytes(backup.totalBytes), detail: backup.format },
        { label: "Artifact", value: formatBytes(backup.artifactBytes), detail: formatDate(backup.createdAt) },
      ]}
      note="Portable artifact ready for restore-first workflows or a private handoff."
      primaryActions={
        <button type="button" className="action-secondary" onClick={() => void onRevealPath(backup.targetPath)}>
          Reveal artifact
        </button>
      }
      secondaryActions={
          <button
            type="button"
            className="action-primary"
            disabled={isHandoffPending}
            onClick={() => void onCreateHandoff(backup)}
          >
          {isHandoffPending ? "Encrypting..." : "Create Secure Handoff"}
        </button>
      }
      title={backup.label}
      tone="backup"
    >
      <dl className="detail-list lens-detail-list">
        <div>
          <dt>Created</dt>
          <dd>{formatDate(backup.createdAt)}</dd>
        </div>
        <div>
          <dt>Mode</dt>
          <dd>{backup.familyMode ? "family export" : "thread selection"}</dd>
        </div>
        <div>
          <dt>Format</dt>
          <dd>{backup.format}</dd>
        </div>
        <div>
          <dt>Threads</dt>
          <dd>{backup.threadCount}</dd>
        </div>
        <div>
          <dt>Rollout bytes</dt>
          <dd>{formatBytes(backup.totalBytes)}</dd>
        </div>
        <div>
          <dt>Artifact size</dt>
          <dd>{formatBytes(backup.artifactBytes)}</dd>
        </div>
      </dl>
      <LensPath label="Backup path" value={backup.targetPath} />
    </InspectorLens>
  );
}

function SecureHandoffCard({
  handoff,
  onCopy,
  onRevealPath,
  onToggleSecret,
  showSecret,
}: {
  handoff: HandoffRecord | null;
  onCopy: (value: string, label: string) => Promise<void>;
  onRevealPath: (path: string) => Promise<void>;
  onToggleSecret: () => void;
  showSecret: boolean;
}) {
  return (
    <InspectorLens
      code={handoff ? handoff.handoffId : "no network listener"}
      eyebrow="Handoff lens"
      metrics={[
        { label: "Mode", value: "File", detail: "offline" },
        { label: "Crypto", value: "AES-GCM", detail: "PBKDF2" },
        { label: "Network", value: "None", detail: "local-only" },
      ]}
      note="Create an encrypted file from a backup, then move it with USB, Bluetooth, AirDrop, Nearby Share, or any private channel."
      title="Secure handoff desk"
      tone="handoff"
    >
      {handoff ? (
        <div className="handoff-card">
          <strong>{handoff.label}</strong>
          <span>{formatDate(handoff.createdAt)}</span>
          <span>
            {handoff.threadCount} thread{handoff.threadCount === 1 ? "" : "s"} · {formatBytes(handoff.encryptedBytes)}
          </span>
          <div className="handoff-code-row">
            <code>{showSecret ? handoff.recoveryPhrase : maskSecret(handoff.recoveryPhrase)}</code>
            <button
              type="button"
              className="action-secondary compact-button"
              onClick={onToggleSecret}
            >
              {showSecret ? "Hide phrase" : "Reveal phrase"}
            </button>
            <button
              type="button"
              className="action-secondary compact-button"
              onClick={() => void onCopy(handoff.recoveryPhrase, "recovery phrase")}
            >
              Copy phrase
            </button>
          </div>
          <div className="handoff-code-row">
            <code>{handoff.targetPath}</code>
            <button
              type="button"
              className="action-secondary compact-button"
              onClick={() => void onCopy(handoff.targetPath, "handoff path")}
            >
              Copy path
            </button>
          </div>
          <button
            type="button"
            className="action-secondary compact-button"
            onClick={() => void onRevealPath(handoff.targetPath)}
          >
            Reveal handoff
          </button>
        </div>
      ) : (
        <p className="action-note">
          Select a backup artifact and create a secure handoff when you need to move it to another computer.
        </p>
      )}
    </InspectorLens>
  );
}

function TrashInspector({
  onAction,
  onCopy,
  onRevealPath,
  record,
}: {
  onAction: (record: TrashRecord, action: "purge" | "restore") => void;
  onCopy: (value: string, label: string) => Promise<void>;
  onRevealPath: (path: string) => Promise<void>;
  record: TrashRecord;
}) {
  const isCorrupt = isCorruptTrashRecord(record);
  return (
    <InspectorLens
      badge={<span className="status-badge status-trashed">trashed</span>}
      code={record.threadId}
      danger={
        <button type="button" className="action-secondary action-danger-outline" onClick={() => onAction(record, "purge")}>
          Delete permanently
        </button>
      }
      eyebrow="Trash lens"
      metrics={[
        { label: "Guard", value: formatTrashGuard(record.expiresAt), detail: "before purge" },
        { label: "Size", value: formatBytes(record.rawRolloutBytes), detail: record.originalStatus },
        { label: "Deleted", value: formatDate(record.deletedAt), detail: "trash entry" },
      ]}
      note="Trash entries stay recoverable until the guard expires."
      primaryActions={
        <button
          type="button"
          className="action-primary"
          disabled={isCorrupt}
          onClick={() => onAction(record, "restore")}
        >
          {isCorrupt ? "Restore unavailable" : "Restore to archive vault"}
        </button>
      }
      secondaryActions={
        <>
          <button type="button" className="action-secondary" onClick={() => void onRevealPath(record.trashedPath)}>
            Reveal payload
          </button>
          <button type="button" className="action-secondary" onClick={() => void onCopy(record.threadId, "thread id")}>
            Copy ID
          </button>
        </>
      }
      title={record.title}
      tone="trash"
    >
      <dl className="detail-list lens-detail-list">
        <div>
          <dt>Deleted</dt>
          <dd>{formatDate(record.deletedAt)}</dd>
        </div>
        <div>
          <dt>Expires</dt>
          <dd>{formatTrashGuard(record.expiresAt)}</dd>
        </div>
        <div>
          <dt>Original status</dt>
          <dd>{record.originalStatus}</dd>
        </div>
        <div>
          <dt>Rollout size</dt>
          <dd>{formatBytes(record.rawRolloutBytes)}</dd>
        </div>
        <div>
          <dt>Original path</dt>
          <dd>{record.originalPath}</dd>
        </div>
      </dl>
      <LensPath label="Trash payload" value={record.trashedPath} />
    </InspectorLens>
  );
}

function RuleInspector({
  matches,
  onDelete,
  onRun,
  rule,
  savedRules,
  selectedRuleId,
  setSelectedRuleId,
}: {
  matches: ThreadRecord[];
  onDelete?: (ruleId: string) => Promise<void>;
  onRun?: (rule: CleanupRuleRecord) => void;
  rule: CleanupRuleRecord | null;
  savedRules: CleanupRuleRecord[];
  selectedRuleId: null | string;
  setSelectedRuleId: (ruleId: null | string) => void;
}) {
  return (
    <>
      <InspectorLens
        code={`${matches.length} matching threads`}
        danger={
          rule && (
            <button type="button" className="action-secondary action-danger-outline" onClick={() => void onDelete?.(rule.ruleId)}>
              Delete rule
            </button>
          )
        }
        eyebrow="Rule lens"
        metrics={[
          { label: "Matches", value: String(matches.length), detail: "current filters" },
          { label: "Action", value: rule?.action ?? "draft", detail: rule?.scope ?? "not saved" },
        ]}
        note="Preview rule impact before running cleanup against matching threads."
        primaryActions={
          rule && (
            <button type="button" className="action-primary" onClick={() => onRun?.(rule)}>
              Preview and run
            </button>
          )
        }
        title={rule?.name ?? "Draft rule"}
        tone="rule"
      >
        {matches.length > 0 ? (
          <div className="mini-list">
            {matches.slice(0, 8).map((thread) => (
              <div key={thread.threadId} className="mini-row mini-row-static">
                <span>{thread.title}</span>
                <strong>{formatBytes(thread.rawRolloutBytes)}</strong>
              </div>
            ))}
          </div>
        ) : (
          <p className="action-note">No threads currently match the active rule draft.</p>
        )}
      </InspectorLens>

      <InspectorLens
        code={`${savedRules.length} stored rules`}
        eyebrow="Saved rules"
        metrics={[
          { label: "Stored", value: String(savedRules.length), detail: "rules" },
          { label: "Selected", value: selectedRuleId ? "1" : "0", detail: "active draft" },
        ]}
        title="Rule library"
        tone="rule"
      >
        {savedRules.length > 0 ? (
          <div className="rule-list">
            {savedRules.map((savedRule) => (
              <button
                key={savedRule.ruleId}
                type="button"
                className={
                  savedRule.ruleId === selectedRuleId
                    ? "workspace-row workspace-row-selected"
                    : "workspace-row"
                }
                onClick={() => setSelectedRuleId(savedRule.ruleId)}
              >
                <div className="workspace-row-copy">
                  <strong>{savedRule.name}</strong>
                  <span>{savedRule.action} · {savedRule.scope}</span>
                </div>
                <div className="workspace-row-metrics">
                  <span>{savedRule.olderThanDays} days</span>
                  <strong>{savedRule.minBytesMb || "0"} MB</strong>
                </div>
              </button>
            ))}
          </div>
        ) : (
          <p className="action-note">Save a cleanup rule here to reuse it for recurring thread maintenance.</p>
        )}
      </InspectorLens>
    </>
  );
}

function HealthPage({
  backupCount,
  catalog,
  healthData,
}: {
  backupCount: number;
  catalog: SurfaceCatalog;
  healthData: HealthSummary;
}) {
  const issues = [
    ...healthData.unreadableMetadata,
    ...healthData.missingRollouts,
    ...healthData.orphanedFamilies.map((family) => ({
      kind: "orphaned_family" as const,
      message: `${family.parentTitle} has subagents but no readable parent rollout on disk.`,
      path: family.threads[0]?.rolloutPath ?? null,
    })),
  ];
  return (
    <>
      <section className="summary-grid health-summary-grid">
        <SummaryCard
          description="Active rollout storage"
          label="Active Storage"
          value={formatBytes(catalog.activeThreads.reduce((total, thread) => total + thread.rawRolloutBytes, 0))}
        />
        <SummaryCard
          description="Archived rollout storage"
          label="Archived Storage"
          value={formatBytes(catalog.archivedThreads.reduce((total, thread) => total + thread.rawRolloutBytes, 0))}
        />
        <SummaryCard description="Indexed backup artifacts" label="Backup Artifacts" value={String(backupCount)} />
        <SummaryCard description="Unreadable or orphaned records" label="Integrity Issues" value={String(healthData.totalIssues)} />
      </section>

      <section className={healthData.appServer.available ? "status-card" : "status-card status-card-error"}>
        <h3>{healthData.appServer.available ? "Codex App Server available" : "Codex App Server degraded"}</h3>
        <p>
          {healthData.appServer.available
            ? "Lifecycle actions are available through the official Codex App Server."
            : healthData.appServer.message ?? "ThreadDock is in a degraded read-mostly mode for lifecycle actions."}
        </p>
      </section>

      <div className="content-grid">
        <section className="table-panel">
          <div className="table-header">
            <div>
              <p className="panel-label">Largest threads</p>
              <p className="panel-value">{healthData.largestThreads.length}</p>
            </div>
            <div>
              <p className="panel-label">Largest families</p>
              <p className="panel-value">{healthData.largestFamilies.length}</p>
            </div>
            <div>
              <p className="panel-label">Largest workspaces</p>
              <p className="panel-value">{healthData.largestWorkspaces.length}</p>
            </div>
          </div>
          <div className="health-section">
            <h3>Largest workspaces</h3>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Workspace</th>
                    <th>Threads</th>
                    <th>Updated</th>
                    <th>Storage</th>
                  </tr>
                </thead>
                <tbody>
                  {healthData.largestWorkspaces.map((group) => (
                    <tr key={group.summary.workspaceKey}>
                      <td>{group.summary.workspaceLabel}</td>
                      <td>{group.summary.threadCount}</td>
                      <td>{formatDate(group.summary.latestUpdatedAt)}</td>
                      <td>{formatBytes(group.summary.totalBytes)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          <div className="health-section">
            <h3>Reclaim candidates</h3>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Thread</th>
                    <th>Status</th>
                    <th>Updated</th>
                    <th>Storage</th>
                  </tr>
                </thead>
                <tbody>
                  {healthData.reclaimCandidates.map((thread) => (
                    <tr key={thread.threadId}>
                      <td>
                        <div className="title-cell">
                          <span>{thread.title}</span>
                          <code>{thread.threadId.slice(0, 8)}</code>
                        </div>
                      </td>
                      <td><StatusBadge status={thread.status} /></td>
                      <td>{formatDate(thread.updatedAt)}</td>
                      <td>{formatBytes(thread.rawRolloutBytes)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>

        <aside className="inspector inspector-stack">
          <InspectorLens
            code={`${issues.length} flagged records`}
            eyebrow="Integrity lens"
            metrics={[
              { label: "Issues", value: String(issues.length), detail: "flagged" },
              { label: "Backups", value: String(backupCount), detail: "artifacts" },
            ]}
            note="Read-only diagnostics for missing rollouts, unreadable metadata, and orphaned families."
            title="Scan issues"
            tone="health"
          >
            {issues.length > 0 ? (
              <div className="issue-list">
                {issues.map((issue, index) => (
                  <div key={`${issue.kind}-${index}`} className="issue-card">
                    <p className="eyebrow">{issue.kind.replaceAll("_", " ")}</p>
                    <strong>{issue.message}</strong>
                    {issue.path && <span>{issue.path}</span>}
                  </div>
                ))}
              </div>
            ) : (
              <p className="action-note">No malformed or orphaned records are currently flagged.</p>
            )}
          </InspectorLens>

          <InspectorLens
            code={`${healthData.activityLog.length} recent entries`}
            eyebrow="Recent actions"
            metrics={[
              { label: "Entries", value: String(healthData.activityLog.length), detail: "local ledger" },
              { label: "Server", value: healthData.appServer.available ? "ready" : "degraded", detail: "app server" },
            ]}
            title="Activity log"
            tone="health"
          >
            {healthData.activityLog.length > 0 ? (
              <div className="issue-list">
                {healthData.activityLog.map((entry) => (
                  <div key={entry.activityId} className="issue-card">
                    <p className="eyebrow">{entry.kind} · {entry.scope}</p>
                    <strong>{entry.label}</strong>
                    <span>{formatDate(entry.createdAt)}</span>
                    <span>{entry.detail}</span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="action-note">Archive, restore, backup, import, and trash operations will appear here.</p>
            )}
          </InspectorLens>
        </aside>
      </div>
    </>
  );
}

function SettingsPage({
  alternateArchivePath,
  appServerMessage,
  appServerReady,
  backupDirectory,
  backupFormat,
  codexBinaryPath,
  codexHome,
  codexHomeOverride,
  currentVersion,
  githubRepository,
  onAlternateArchivePathChange,
  onBackupDirectoryChange,
  onBackupFormatChange,
  onCheckUpdates,
  onCodexBinaryPathChange,
  onCodexHomeOverrideChange,
  onGithubRepositoryChange,
  onRefreshBackups,
  onResetPaths,
  onRevealBackupDirectory,
  onSave,
  scannedAt,
  updateStatus,
}: {
  alternateArchivePath: string;
  appServerMessage: null | string;
  appServerReady: boolean;
  backupDirectory: string;
  backupFormat: BackupArtifactFormat;
  codexBinaryPath: string;
  codexHome: string;
  codexHomeOverride: string;
  currentVersion: string;
  githubRepository: string;
  onAlternateArchivePathChange: (value: string) => void;
  onBackupDirectoryChange: (value: string) => void;
  onBackupFormatChange: (value: BackupArtifactFormat) => void;
  onCheckUpdates: () => Promise<void>;
  onCodexBinaryPathChange: (value: string) => void;
  onCodexHomeOverrideChange: (value: string) => void;
  onGithubRepositoryChange: (value: string) => void;
  onRefreshBackups: () => Promise<void>;
  onResetPaths: () => Promise<void>;
  onRevealBackupDirectory: (path: string) => Promise<void>;
  onSave: () => Promise<void>;
  scannedAt: string;
  updateStatus: UpdateStatus;
}) {
  return (
    <div className="settings-grid">
      <section className="backup-panel">
        <div className="inspector-heading">
          <p className="eyebrow">Codex pathing</p>
          <h3>Local environment</h3>
        </div>
        <div className="detail-list">
          <div>
            <dt>Detected Codex home</dt>
            <dd>{codexHome}</dd>
          </div>
          <div>
            <dt>Last library scan</dt>
            <dd>{formatDate(scannedAt)}</dd>
          </div>
          <div>
            <dt>App Server</dt>
            <dd>{appServerReady ? "Available" : appServerMessage ?? "Unavailable"}</dd>
          </div>
        </div>
        <label className="backup-directory-field">
          <span>Custom Codex home override</span>
          <input
            value={codexHomeOverride}
            onChange={(event) => onCodexHomeOverrideChange(event.target.value)}
            placeholder="Leave blank to use CODEX_HOME or ~/.codex"
          />
        </label>
        <label className="backup-directory-field">
          <span>Codex CLI binary path</span>
          <input
            value={codexBinaryPath}
            onChange={(event) => onCodexBinaryPathChange(event.target.value)}
            placeholder="Optional absolute path to codex, codex.exe, or codex.cmd"
          />
        </label>
        <label className="backup-directory-field">
          <span>Read-only alternate archive path</span>
          <input
            value={alternateArchivePath}
            onChange={(event) => onAlternateArchivePathChange(event.target.value)}
            placeholder="Optional external archive folder to index as read-only"
          />
        </label>
      </section>

      <section className="backup-panel">
        <div className="inspector-heading">
          <p className="eyebrow">Backup defaults</p>
          <h3>Export settings</h3>
        </div>
        <label className="backup-directory-field">
          <span>Default backup directory</span>
          <input
            value={backupDirectory}
            onChange={(event) => onBackupDirectoryChange(event.target.value)}
            placeholder="Choose a persistent export directory"
          />
        </label>
        <label className="backup-directory-field">
          <span>Default backup format</span>
          <select
            value={backupFormat}
            onChange={(event) => onBackupFormatChange(event.target.value as BackupArtifactFormat)}
          >
            <option value="zip">Zip bundle</option>
            <option value="folder">Plain folder export</option>
          </select>
        </label>
        <div className="action-row action-row-wrap">
          <button
            type="button"
            className="action-secondary"
            onClick={() => void onRevealBackupDirectory(backupDirectory)}
          >
            Reveal directory
          </button>
          <button type="button" className="action-secondary" onClick={() => void onRefreshBackups()}>
            Refresh inventory
          </button>
          <button type="button" className="action-secondary" onClick={() => void onResetPaths()}>
            Clear custom paths
          </button>
          <button type="button" className="action-primary" onClick={() => void onSave()}>
            Save settings
          </button>
        </div>
      </section>

      <UpdateCenter
        currentVersion={currentVersion}
        githubRepository={githubRepository}
        onCheckUpdates={onCheckUpdates}
        onGithubRepositoryChange={onGithubRepositoryChange}
        onSave={onSave}
        updateStatus={updateStatus}
      />
    </div>
  );
}

function BackupHealthPanel({
  health,
  issues,
}: {
  health: BackupHealthSummary | null;
  issues: BackupInventorySnapshot["issues"];
}) {
  if (!health) {
    return null;
  }

  const lastBackupLabel = health.lastBackup
    ? health.lastBackupAgeDays === 0
      ? "Today"
      : health.lastBackupAgeDays === 1
        ? "1 day ago"
        : `${health.lastBackupAgeDays} days ago`
    : "Never";

  return (
    <section className="backup-health-panel">
      <div className="health-score-orb" aria-label={`Backup health score ${health.score} out of 100`}>
        <strong>{health.score}</strong>
        <span>{health.label}</span>
      </div>
      <div className="backup-health-copy">
        <div className="inspector-heading">
          <p className="eyebrow">Backup Health Score</p>
          <h3>Restore readiness at a glance</h3>
        </div>
        <div className="backup-health-grid">
          <div>
            <span>Last backup</span>
            <strong>{lastBackupLabel}</strong>
          </div>
          <div>
            <span>Verified artifacts</span>
            <strong>{health.verifiedArtifacts}</strong>
          </div>
          <div>
            <span>Thread coverage</span>
            <strong>{health.coveragePercent}%</strong>
          </div>
          <div>
            <span>Warnings</span>
            <strong>{health.warningCount}</strong>
          </div>
        </div>
        {health.largestUnbackedThreads.length > 0 ? (
          <div className="mini-list">
            {health.largestUnbackedThreads.map((thread) => (
              <div key={thread.threadId} className="mini-row mini-row-static">
                <span>{thread.title}</span>
                <strong>{formatBytes(thread.rawRolloutBytes)}</strong>
              </div>
            ))}
          </div>
        ) : (
          <p className="action-note">No unbacked writable threads were found in the current library.</p>
        )}
        {issues.length > 0 && (
          <div className="backup-warning-strip">
            <strong>{issues.length} backup artifact warning{issues.length === 1 ? "" : "s"}</strong>
            <span>{issues[0].message}</span>
          </div>
        )}
      </div>
    </section>
  );
}

function RestoreWizardPreview({
  collisionMode,
  currentCodexHome,
  preview,
  restoreMode,
}: {
  collisionMode: "skip" | "replace";
  currentCodexHome: string;
  preview: BackupRecord;
  restoreMode: "archive_only" | "preserve_status";
}) {
  const sourcePlatform = inferPathPlatform(preview.sourceCodexHome);
  const destinationPlatform = inferPathPlatform(currentCodexHome);
  const platformShift =
    sourcePlatform !== "unknown" &&
    destinationPlatform !== "unknown" &&
    sourcePlatform !== destinationPlatform;
  const destinationHint =
    restoreMode === "archive_only"
      ? joinDisplayPath(currentCodexHome, "archived_sessions")
      : `${joinDisplayPath(currentCodexHome, "sessions")} + archive vault`;

  return (
    <div className="restore-wizard">
      <div className="restore-wizard-head">
        <div>
          <p className="eyebrow">Restore Wizard</p>
          <strong>{preview.label}</strong>
        </div>
        <span>{platformShift ? "Cross-OS remap" : "Same-OS restore"}</span>
      </div>
      <div className="restore-map-grid">
        <div>
          <span>Artifact</span>
          <strong>
            {preview.threadCount} thread{preview.threadCount === 1 ? "" : "s"}
          </strong>
          <small>{formatBytes(preview.artifactBytes)} verified artifact</small>
        </div>
        <div>
          <span>Source root</span>
          <strong>{formatPlatformLabel(sourcePlatform)}</strong>
          <small>{preview.sourceCodexHome || "Unknown source Codex home"}</small>
        </div>
        <div>
          <span>Destination root</span>
          <strong>{formatPlatformLabel(destinationPlatform)}</strong>
          <small>{destinationHint}</small>
        </div>
        <div>
          <span>Collision guard</span>
          <strong>{collisionMode === "skip" ? "Skip existing" : "Replace existing"}</strong>
          <small>
            {collisionMode === "skip"
              ? "Existing thread ids stay untouched."
              : "Matching thread ids are overwritten only during import."}
          </small>
        </div>
      </div>
      <div className="restore-remap-strip">
        <strong>{restoreMode === "archive_only" ? "Archive-only restore" : "Preserve exported status"}</strong>
        <span>
          Source paths are remapped to this machine. ThreadDock never writes back into the exported
          machine path.
        </span>
      </div>
      <code>{preview.threadIds.slice(0, 4).join(", ")}</code>
    </div>
  );
}

function UpdateCenter({
  currentVersion,
  githubRepository,
  onCheckUpdates,
  onGithubRepositoryChange,
  onSave,
  updateStatus,
}: {
  currentVersion: string;
  githubRepository: string;
  onCheckUpdates: () => Promise<void>;
  onGithubRepositoryChange: (value: string) => void;
  onSave: () => Promise<void>;
  updateStatus: UpdateStatus;
}) {
  const parsedRepository = parseGitHubRepository(githubRepository);
  const release = updateStatus.kind === "ready" ? updateStatus.release : null;
  const releaseState = release
    ? releaseIsDifferent(release.tagName, currentVersion)
      ? "Update available"
      : "Current release"
    : updateStatus.kind === "ready"
      ? "No release yet"
      : "Not checked";

  return (
    <section className="backup-panel update-center">
      <div className="inspector-heading">
        <p className="eyebrow">Update Center</p>
        <h3>Version and release notes</h3>
      </div>
      <div className="update-current-strip">
        <div>
          <span>Installed</span>
          <strong>v{currentVersion}</strong>
        </div>
        <div>
          <span>Repository</span>
          <strong>{parsedRepository ?? "Not configured"}</strong>
        </div>
        <div>
          <span>Status</span>
          <strong>{releaseState}</strong>
        </div>
      </div>
      <label className="backup-directory-field">
        <span>GitHub repository</span>
        <input
          value={githubRepository}
          onChange={(event) => onGithubRepositoryChange(event.target.value)}
          placeholder="owner/repo or https://github.com/owner/repo"
        />
      </label>
      <div className="action-row action-row-wrap">
        <button
          type="button"
          className="action-secondary"
          disabled={updateStatus.kind === "loading" || !githubRepository.trim()}
          onClick={() => void onCheckUpdates()}
        >
          {updateStatus.kind === "loading" ? "Checking..." : "Check GitHub release"}
        </button>
        <button type="button" className="action-secondary" onClick={() => void onSave()}>
          Save repository
        </button>
      </div>
      {updateStatus.kind === "error" && (
        <div className="backup-warning-strip">
          <strong>Update check failed</strong>
          <span>{updateStatus.message}</span>
        </div>
      )}
      {updateStatus.kind === "ready" && (
        <div className="release-card">
          {release ? (
            <>
              <div className="release-card-head">
                <div>
                  <span>Latest release</span>
                  <strong>
                    {release.name} · {release.tagName}
                  </strong>
                </div>
                <span>{formatDate(release.publishedAt)}</span>
              </div>
              <p>{trimChangelog(release.body)}</p>
              <a href={release.htmlUrl} rel="noreferrer" target="_blank">
                Open GitHub release
              </a>
            </>
          ) : (
            <p>{updateStatus.message}</p>
          )}
        </div>
      )}
      <ol className="safe-update-list">
        <li>Run a backup health check and export important threads before installing.</li>
        <li>Close Codex and ThreadDock so session files are not being written during update.</li>
        <li>Install the signed package from GitHub Releases, then reopen ThreadDock and refresh inventory.</li>
      </ol>
    </section>
  );
}

function StatusBadge({ status }: { status: ThreadRecord["status"] }) {
  return <span className={`status-badge status-${status}`}>{status}</span>;
}

function ModeToggle({
  mode,
  onChange,
}: {
  mode: ComplexityMode;
  onChange: (mode: ComplexityMode) => void;
}) {
  return (
    <div className="mode-toggle" aria-label="Interface mode" role="group">
      <button
        type="button"
        className={mode === "simple" ? "mode-toggle-button mode-toggle-active" : "mode-toggle-button"}
        onClick={() => onChange("simple")}
      >
        Simple
      </button>
      <button
        type="button"
        className={mode === "advanced" ? "mode-toggle-button mode-toggle-active" : "mode-toggle-button"}
        onClick={() => onChange("advanced")}
      >
        Advanced
      </button>
    </div>
  );
}

function PaginationControls({
  currentPage,
  itemLabel,
  onPageChange,
  pageCount,
  pageSize,
  totalItems,
}: {
  currentPage: number;
  itemLabel: string;
  onPageChange: (page: number) => void;
  pageCount: number;
  pageSize: number;
  totalItems: number;
}) {
  if (totalItems === 0) {
    return null;
  }
  const start = (currentPage - 1) * pageSize + 1;
  const end = Math.min(currentPage * pageSize, totalItems);
  const pages = buildPageList(currentPage, pageCount);
  return (
    <div className="pagination">
      <p className="pagination-info">
        Showing {start}-{end} of {totalItems} {itemLabel}
      </p>
      {pageCount > 1 && (
        <div className="pagination-actions">
          <button
            type="button"
            className="pagination-button"
            disabled={currentPage === 1}
            onClick={() => onPageChange(currentPage - 1)}
          >
            Previous
          </button>
          {pages.map((page, index) =>
            page === null ? (
              <span key={`ellipsis-${currentPage}-${index}`} className="pagination-ellipsis">
                ...
              </span>
            ) : (
              <button
                key={page}
                type="button"
                className={
                  page === currentPage ? "pagination-button pagination-button-active" : "pagination-button"
                }
                onClick={() => onPageChange(page)}
              >
                {page}
              </button>
            ),
          )}
          <button
            type="button"
            className="pagination-button"
            disabled={currentPage === pageCount}
            onClick={() => onPageChange(currentPage + 1)}
          >
            Next
          </button>
        </div>
      )}
    </div>
  );
}

function EmptySurfaceCard({ body, title }: { body: string; title: string }) {
  return (
    <div className="empty-surface">
      <h3>{title}</h3>
      <p>{body}</p>
    </div>
  );
}

function IndexingStatusCard() {
  return (
    <section className="status-card indexing-card" aria-busy="true" aria-live="polite">
      <div className="indexing-orbit" aria-hidden="true">
        <div className="indexing-ring" />
        <span />
        <span />
        <span />
      </div>
      <div className="indexing-copy">
        <p className="eyebrow">Indexing Codex home</p>
        <h3>Building the thread map</h3>
        <p>
          ThreadDock is reading the session index, measuring rollout files, and separating live,
          archived, and subagent threads.
        </p>
        <div
          className="indexing-progress"
          role="progressbar"
          aria-label="Indexing local Codex data"
        >
          <span />
        </div>
        <div className="indexing-steps" aria-hidden="true">
          <span>Locate Codex home</span>
          <span>Read sessions</span>
          <span>Measure storage</span>
          <span>Map families</span>
        </div>
      </div>
      <div className="indexing-grid" aria-hidden="true">
        {Array.from({ length: 18 }, (_, index) => (
          <span key={index} />
        ))}
      </div>
    </section>
  );
}

function BulkPreviewDialog({
  busy,
  onCancel,
  onConfirm,
  preview,
}: {
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  preview: PreviewState;
}) {
  return (
    <div className="dialog-backdrop" role="presentation">
      <div className="dialog-card" role="dialog" aria-modal="true" aria-labelledby="preview-title">
        <p className="eyebrow">Bulk preview</p>
        <h3 id="preview-title">{preview.title}</h3>
        <p className="toolbar-note">{preview.description}</p>
        <div className="inspector-stats">
          <div>
            <span>Threads</span>
            <strong>{preview.threads.length || preview.trashItems.length}</strong>
          </div>
          <div>
            <span>Bytes</span>
            <strong>{formatBytes(preview.bytes)}</strong>
          </div>
          <div>
            <span>Read-only skipped</span>
            <strong>{preview.readOnlyCount}</strong>
          </div>
        </div>
        {preview.threads.length > 0 && (
          <div className="dialog-list">
            {preview.threads.slice(0, 10).map((thread) => (
              <div key={thread.threadId} className="mini-row mini-row-static">
                <span>{thread.title}</span>
                <strong>{formatBytes(thread.rawRolloutBytes)}</strong>
              </div>
            ))}
          </div>
        )}
        {preview.trashItems.length > 0 && (
          <div className="dialog-list">
            {preview.trashItems.slice(0, 10).map((record) => (
              <div key={record.trashId} className="mini-row mini-row-static">
                <span>{record.title}</span>
                <strong>{formatTrashGuard(record.expiresAt)}</strong>
              </div>
            ))}
          </div>
        )}
        <div className="action-row action-row-wrap">
          <button type="button" className="action-secondary" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className={preview.danger ? "action-primary action-danger" : "action-primary"}
            disabled={busy}
            onClick={onConfirm}
          >
            {busy ? "Working..." : preview.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

function isSubagentThread(thread: ThreadRecord): boolean {
  return thread.threadSource === "subagent" || thread.parentThreadId !== null;
}

function getFamilyMembers(family: FamilyGroup): ThreadRecord[] {
  return family.parentThread ? [family.parentThread, ...family.threads] : family.threads;
}

function matchesThreadFilters(thread: ThreadRecord, filters: ThreadFilters): boolean {
  const normalizedQuery = filters.query.trim().toLowerCase();
  if (
    normalizedQuery &&
    !(
      thread.title.toLowerCase().includes(normalizedQuery) ||
      thread.threadId.toLowerCase().includes(normalizedQuery) ||
      (thread.cwd ?? "").toLowerCase().includes(normalizedQuery)
    )
  ) {
    return false;
  }

  if (
    filters.threadIdQuery.trim() &&
    !thread.threadId.toLowerCase().includes(filters.threadIdQuery.trim().toLowerCase())
  ) {
    return false;
  }

  if (
    filters.parentThreadIdQuery.trim() &&
    !(thread.parentThreadId ?? "")
      .toLowerCase()
      .includes(filters.parentThreadIdQuery.trim().toLowerCase())
  ) {
    return false;
  }

  if (
    filters.workspaceFilter.trim() &&
    !(thread.cwd ?? "").toLowerCase().includes(filters.workspaceFilter.trim().toLowerCase())
  ) {
    return false;
  }

  if (filters.sourceFilter !== "all" && thread.threadSource !== filters.sourceFilter) {
    return false;
  }

  if (filters.includeReadOnly === "only" && !thread.readOnly) {
    return false;
  }
  if (filters.includeReadOnly === "exclude" && thread.readOnly) {
    return false;
  }

  const comparable = thread.updatedAt ?? thread.createdAt;
  if ((filters.dateFrom || filters.dateTo) && !comparable) {
    return false;
  }
  const comparableDate = comparable?.slice(0, 10) ?? null;
  if (filters.dateFrom && comparableDate && comparableDate < filters.dateFrom) {
    return false;
  }
  if (filters.dateTo && comparableDate && comparableDate > filters.dateTo) {
    return false;
  }

  const minBytes = parseMb(filters.minBytesMb);
  const maxBytes = parseMb(filters.maxBytesMb);
  if (minBytes !== null && thread.rawRolloutBytes < minBytes) {
    return false;
  }
  if (maxBytes !== null && thread.rawRolloutBytes > maxBytes) {
    return false;
  }

  return true;
}

function matchesFamilyFilters(family: FamilyGroup, filters: ThreadFilters): boolean {
  const members = getFamilyMembers(family);
  if (
    filters.query.trim() &&
    !(
      family.parentTitle.toLowerCase().includes(filters.query.trim().toLowerCase()) ||
      members.some((thread) => matchesThreadFilters(thread, { ...filters, query: "", workspaceFilter: "", threadIdQuery: "", parentThreadIdQuery: "", dateFrom: "", dateTo: "" }))
    )
  ) {
    return false;
  }
  return members.some((thread) => matchesThreadFilters(thread, filters));
}

function matchesWorkspaceFilters(group: WorkspaceGroup, filters: ThreadFilters): boolean {
  if (
    filters.query.trim() &&
    !group.summary.workspaceLabel.toLowerCase().includes(filters.query.trim().toLowerCase()) &&
    !group.threads.some((thread) => matchesThreadFilters(thread, filters))
  ) {
    return false;
  }
  return group.threads.some((thread) => matchesThreadFilters(thread, filters));
}

function matchesTrashFilters(record: TrashRecord, filters: ThreadFilters): boolean {
  const normalizedQuery = filters.query.trim().toLowerCase();
  if (
    normalizedQuery &&
    !(
      record.title.toLowerCase().includes(normalizedQuery) ||
      record.threadId.toLowerCase().includes(normalizedQuery) ||
      (record.cwd ?? "").toLowerCase().includes(normalizedQuery) ||
      record.originalPath.toLowerCase().includes(normalizedQuery)
    )
  ) {
    return false;
  }
  if (
    filters.workspaceFilter.trim() &&
    !(record.cwd ?? "").toLowerCase().includes(filters.workspaceFilter.trim().toLowerCase())
  ) {
    return false;
  }
  if (
    filters.threadIdQuery.trim() &&
    !record.threadId.toLowerCase().includes(filters.threadIdQuery.trim().toLowerCase())
  ) {
    return false;
  }
  const minBytes = parseMb(filters.minBytesMb);
  const maxBytes = parseMb(filters.maxBytesMb);
  if (minBytes !== null && record.rawRolloutBytes < minBytes) {
    return false;
  }
  if (maxBytes !== null && record.rawRolloutBytes > maxBytes) {
    return false;
  }
  return true;
}

function isCorruptTrashRecord(record: TrashRecord): boolean {
  return record.threadId.startsWith("corrupt-trash-");
}

function buildRuleMatches(threads: ThreadRecord[], draft: RuleDraft): ThreadRecord[] {
  const cutoffDate = dateBeforeDays(draft.olderThanDays);
  const minBytes = parseMb(draft.minBytesMb);
  return threads.filter((thread) => {
    if (!draft.includeSubagents && isSubagentThread(thread)) {
      return false;
    }
    if (thread.readOnly) {
      return false;
    }
    if (draft.scope !== "all" && thread.status !== draft.scope) {
      return false;
    }
    if (
      draft.workspaceFilter.trim() &&
      !(thread.cwd ?? "").toLowerCase().includes(draft.workspaceFilter.trim().toLowerCase())
    ) {
      return false;
    }
    if (minBytes !== null && thread.rawRolloutBytes < minBytes) {
      return false;
    }
    if (cutoffDate) {
      const comparable = thread.updatedAt ?? thread.createdAt;
      if (!comparable || comparable.slice(0, 10) > cutoffDate) {
        return false;
      }
    }
    return true;
  });
}

function sortThreads(threads: ThreadRecord[], sortKey: ThreadSortKey): ThreadRecord[] {
  return [...threads].sort((left, right) => {
    switch (sortKey) {
      case "created_desc":
        return (
          compareDates(right.createdAt, left.createdAt) ||
          compareDates(right.updatedAt, left.updatedAt) ||
          left.title.localeCompare(right.title)
        );
      case "title_asc":
        return left.title.localeCompare(right.title) || compareDates(right.updatedAt, left.updatedAt);
      case "size_desc":
        return (
          right.rawRolloutBytes - left.rawRolloutBytes ||
          compareDates(right.updatedAt, left.updatedAt) ||
          left.title.localeCompare(right.title)
        );
      case "updated_desc":
      default:
        return (
          compareDates(right.updatedAt, left.updatedAt) ||
          compareDates(right.createdAt, left.createdAt) ||
          left.title.localeCompare(right.title)
        );
    }
  });
}

function sortFamilies(families: FamilyGroup[], sortKey: ThreadSortKey): FamilyGroup[] {
  return [...families].sort((left, right) => {
    switch (sortKey) {
      case "created_desc":
        return (
          compareDates(right.parentThread?.createdAt ?? null, left.parentThread?.createdAt ?? null) ||
          compareDates(right.latestUpdatedAt, left.latestUpdatedAt) ||
          left.parentTitle.localeCompare(right.parentTitle)
        );
      case "title_asc":
        return left.parentTitle.localeCompare(right.parentTitle);
      case "size_desc":
        return (
          right.totalBytes - left.totalBytes ||
          compareDates(right.latestUpdatedAt, left.latestUpdatedAt) ||
          left.parentTitle.localeCompare(right.parentTitle)
        );
      case "updated_desc":
      default:
        return (
          compareDates(right.latestUpdatedAt, left.latestUpdatedAt) ||
          right.totalBytes - left.totalBytes ||
          left.parentTitle.localeCompare(right.parentTitle)
        );
    }
  });
}

function sortWorkspaceGroups(groups: WorkspaceGroup[], sortKey: ThreadSortKey): WorkspaceGroup[] {
  return [...groups].sort((left, right) => {
    switch (sortKey) {
      case "title_asc":
        return left.summary.workspaceLabel.localeCompare(right.summary.workspaceLabel);
      case "created_desc":
      case "updated_desc":
        return (
          compareDates(right.summary.latestUpdatedAt, left.summary.latestUpdatedAt) ||
          right.summary.totalBytes - left.summary.totalBytes ||
          left.summary.workspaceLabel.localeCompare(right.summary.workspaceLabel)
        );
      case "size_desc":
      default:
        return (
          right.summary.totalBytes - left.summary.totalBytes ||
          compareDates(right.summary.latestUpdatedAt, left.summary.latestUpdatedAt) ||
          left.summary.workspaceLabel.localeCompare(right.summary.workspaceLabel)
        );
    }
  });
}

function sortTrashRecords(records: TrashRecord[], sortKey: ThreadSortKey): TrashRecord[] {
  return [...records].sort((left, right) => {
    switch (sortKey) {
      case "title_asc":
        return left.title.localeCompare(right.title);
      case "size_desc":
        return right.rawRolloutBytes - left.rawRolloutBytes || right.deletedAt.localeCompare(left.deletedAt);
      case "created_desc":
        return right.deletedAt.localeCompare(left.deletedAt) || left.title.localeCompare(right.title);
      case "updated_desc":
      default:
        return right.expiresAt.localeCompare(left.expiresAt) || left.title.localeCompare(right.title);
    }
  });
}

function buildBackupHealth(
  threads: ThreadRecord[],
  records: BackupRecord[],
  issues: BackupInventorySnapshot["issues"],
): BackupHealthSummary {
  const backedThreadIds = new Set(records.flatMap((record) => record.threadIds));
  const writableThreads = threads.filter((thread) => !thread.readOnly);
  const unbackedThreads = sortThreads(
    writableThreads.filter((thread) => !backedThreadIds.has(thread.threadId)),
    "size_desc",
  );
  const sortedRecords = [...records].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  const lastBackup = sortedRecords[0] ?? null;
  const lastBackupAgeDays = getAgeDays(lastBackup?.createdAt ?? null);
  const coveragePercent =
    writableThreads.length === 0
      ? records.length > 0
        ? 100
        : 0
      : Math.round(((writableThreads.length - unbackedThreads.length) / writableThreads.length) * 100);

  let score = 100;
  if (records.length === 0) {
    score -= 45;
  }
  if (lastBackupAgeDays !== null) {
    if (lastBackupAgeDays >= 30) {
      score -= 25;
    } else if (lastBackupAgeDays >= 14) {
      score -= 15;
    } else if (lastBackupAgeDays >= 7) {
      score -= 6;
    }
  }
  if (unbackedThreads.length > 0) {
    score -= coveragePercent < 50 ? 25 : 15;
  }
  score -= Math.min(30, issues.length * 12);

  const boundedScore = Math.max(0, Math.min(100, score));
  return {
    coveragePercent,
    label: boundedScore >= 90 ? "Strong" : boundedScore >= 70 ? "Watch" : "Needs backup",
    largestUnbackedThreads: unbackedThreads.slice(0, 4),
    lastBackup,
    lastBackupAgeDays,
    score: boundedScore,
    verifiedArtifacts: records.length,
    warningCount: issues.length,
  };
}

function getAgeDays(value: null | string): number | null {
  if (!value) {
    return null;
  }
  const parsed = new Date(value).getTime();
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return Math.max(0, Math.floor((Date.now() - parsed) / 86_400_000));
}

type PathPlatform = "linux" | "macos" | "unknown" | "windows";

function inferPathPlatform(value: string): PathPlatform {
  const normalized = value.trim();
  if (/^[a-zA-Z]:\\/.test(normalized) || normalized.startsWith("\\\\")) {
    return "windows";
  }
  if (normalized.startsWith("/Users/") || normalized === "/Users") {
    return "macos";
  }
  if (normalized.startsWith("/home/") || normalized.startsWith("/var/") || normalized.startsWith("/tmp/")) {
    return "linux";
  }
  if (typeof navigator !== "undefined") {
    const platform = navigator.platform.toLowerCase();
    if (platform.includes("win")) return "windows";
    if (platform.includes("mac")) return "macos";
    if (platform.includes("linux")) return "linux";
  }
  return "unknown";
}

function formatPlatformLabel(platform: PathPlatform): string {
  switch (platform) {
    case "windows":
      return "Windows";
    case "macos":
      return "macOS";
    case "linux":
      return "Linux";
    case "unknown":
      return "Unknown OS";
  }
}

function joinDisplayPath(root: string, leaf: string): string {
  const separator = root.includes("\\") ? "\\" : "/";
  return `${root.replace(/[\\/]+$/, "")}${separator}${leaf}`;
}

function parseGitHubRepository(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const fullUrlMatch = trimmed.match(/^https?:\/\/github\.com\/([^/\s]+)\/([^/\s#?]+)(?:[/?#].*)?$/i);
  const shorthandMatch = trimmed.match(/^([^/\s]+)\/([^/\s]+)$/);
  const match = fullUrlMatch ?? shorthandMatch;
  if (!match) {
    return null;
  }

  const owner = match[1];
  const repo = match[2].replace(/\.git$/i, "");
  return `${owner}/${repo}`;
}

function normalizeReleaseVersion(value: string): string {
  return value.trim().replace(/^v/i, "");
}

function releaseIsDifferent(tagName: string, currentVersion: string): boolean {
  const normalizedTag = normalizeReleaseVersion(tagName);
  return normalizedTag !== "unknown" && normalizedTag !== normalizeReleaseVersion(currentVersion);
}

function trimChangelog(value: string): string {
  const normalized = value.trim();
  if (!normalized) {
    return "No changelog text was published with this release.";
  }
  if (normalized.length <= 520) {
    return normalized;
  }
  return `${normalized.slice(0, 520).trimEnd()}...`;
}

function paginateItems<T>(items: T[], requestedPage: number, pageSize: number): PaginatedResult<T> {
  const pageCount = Math.max(1, Math.ceil(items.length / pageSize));
  const page = Math.min(Math.max(requestedPage, 1), pageCount);
  const startIndex = (page - 1) * pageSize;
  return {
    items: items.slice(startIndex, startIndex + pageSize),
    page,
    pageCount,
    pageSize,
    totalItems: items.length,
  };
}

function buildPageList(currentPage: number, pageCount: number): Array<null | number> {
  if (pageCount <= 5) {
    return Array.from({ length: pageCount }, (_, index) => index + 1);
  }
  const pages = new Set<number>([1, pageCount, currentPage]);
  if (currentPage > 1) {
    pages.add(currentPage - 1);
  }
  if (currentPage < pageCount) {
    pages.add(currentPage + 1);
  }
  const ordered = [...pages].sort((left, right) => left - right);
  const result: Array<null | number> = [];
  for (let index = 0; index < ordered.length; index += 1) {
    const value = ordered[index];
    const previous = ordered[index - 1];
    if (previous !== undefined && value - previous > 1) {
      result.push(null);
    }
    result.push(value);
  }
  return result;
}

function compareDates(left: null | string, right: null | string): number {
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

function formatFamilyLabel(parentThreadId: null | string): string {
  return parentThreadId ? `Parent ${parentThreadId.slice(0, 8)}` : "Detached family";
}

function maskSecret(value: string): string {
  return value
    .split("-")
    .map((segment) => "*".repeat(Math.max(4, Math.min(segment.length, 8))))
    .join("-");
}

function buildWorkspaceSummary(workspaceKey: string, threads: ThreadRecord[]): WorkspaceSummary {
  const topLevelThreads = threads.filter((thread) => !isSubagentThread(thread));
  const sortedBySize = sortThreads(threads.slice(), "size_desc");
  const sortedByDate = sortThreads(threads.slice(), "updated_desc");
  return {
    activeCount: topLevelThreads.filter((thread) => thread.status === "active").length,
    archivedCount: topLevelThreads.filter((thread) => thread.status === "archived").length,
    largestThreadTitle: sortedBySize[0]?.title ?? null,
    latestUpdatedAt: sortedByDate[0]?.updatedAt ?? sortedByDate[0]?.createdAt ?? null,
    readOnlyCount: threads.filter((thread) => thread.readOnly).length,
    subagentCount: threads.filter(isSubagentThread).length,
    threadCount: threads.length,
    totalBytes: threads.reduce((total, thread) => total + thread.rawRolloutBytes, 0),
    workspaceKey,
    workspaceLabel: workspaceKey === "__unknown__" ? "Unknown workspace" : workspaceKey,
  };
}

function normalizeWorkspaceKey(cwd: null | string): string {
  const trimmed = cwd?.trim();
  return trimmed ? trimmed : "__unknown__";
}

function parseMb(value: string): null | number {
  const normalized = value.trim();
  if (!normalized) {
    return null;
  }
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return null;
  }
  return Math.round(parsed * 1024 * 1024);
}

function dateBeforeDays(value: string): null | string {
  const parsed = Number(value.trim());
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  const current = new Date();
  current.setDate(current.getDate() - parsed);
  return current.toISOString().slice(0, 10);
}

function formatTrashGuard(expiresAt: string): string {
  const expires = new Date(expiresAt);
  const now = new Date();
  const days = Math.ceil((expires.getTime() - now.getTime()) / 86_400_000);
  if (Number.isNaN(days)) {
    return formatDate(expiresAt);
  }
  if (days <= 0) {
    return `Expired · ${formatDate(expiresAt)}`;
  }
  if (days === 1) {
    return `1 day left · ${formatDate(expiresAt)}`;
  }
  return `${days} days left · ${formatDate(expiresAt)}`;
}

function buildHeroMetrics({
  backupRecords,
  catalog,
  cleanupRules,
  filters,
  healthData,
  section,
  visibleSurface,
  visibleTrash,
  visibleWorkspaces,
}: {
  backupRecords: BackupRecord[];
  catalog: null | SurfaceCatalog;
  cleanupRules: CleanupRuleRecord[];
  filters: ThreadFilters;
  healthData: HealthSummary | null;
  section: SectionId;
  visibleSurface: VisibleSurface;
  visibleTrash: TrashRecord[];
  visibleWorkspaces: WorkspaceGroup[];
}): HeroMetric[] {
  const activeFilterCount = countActiveFilters(filters);
  switch (section) {
    case "library":
      return [
        {
          detail: "live top-level threads on this surface",
          label: "Visible set",
          value: String(visibleSurface.threads.length),
        },
        {
          detail: "storage in the current filtered library",
          label: "Surface weight",
          value: formatBytes(
            visibleSurface.threads.reduce((total, thread) => total + thread.rawRolloutBytes, 0),
          ),
        },
        {
          detail: activeFilterCount === 0 ? "wide-open library read" : "filters shaping the surface",
          label: "Signal tuning",
          value: activeFilterCount === 0 ? "Open" : `${activeFilterCount} active`,
        },
      ];
    case "archives":
      return [
        {
          detail: "archived top-level threads now visible",
          label: "Vault rows",
          value: String(visibleSurface.threads.length),
        },
        {
          detail: "reclaimable rollout bytes in view",
          label: "Cold storage",
          value: formatBytes(
            visibleSurface.threads.reduce((total, thread) => total + thread.rawRolloutBytes, 0),
          ),
        },
        {
          detail: "backup artifacts already captured",
          label: "Safety net",
          value: String(backupRecords.length),
        },
      ];
    case "subagents":
      return [
        {
          detail: "families currently matching the surface",
          label: "Family count",
          value: String(visibleSurface.families.length),
        },
        {
          detail: "subagent rollouts inside those families",
          label: "Descendant storage",
          value: formatBytes(
            visibleSurface.families.reduce((total, family) => total + family.totalBytes, 0),
          ),
        },
        {
          detail: "families missing a readable parent rollout",
          label: "Orphans",
          value: String(visibleSurface.families.filter((family) => family.isOrphaned).length),
        },
      ];
    case "workspaces":
      return [
        {
          detail: "workspaces visible after the current filters",
          label: "Workspace lanes",
          value: String(visibleWorkspaces.length),
        },
        {
          detail: "largest visible workspace footprint",
          label: "Heaviest lane",
          value: visibleWorkspaces[0]
            ? formatBytes(visibleWorkspaces[0].summary.totalBytes)
            : "0 B",
        },
        {
          detail: "subagent-heavy workspaces currently in frame",
          label: "Agent-rich",
          value: String(
            visibleWorkspaces.filter((group) => group.summary.subagentCount > 0).length,
          ),
        },
      ];
    case "backups":
      return [
        {
          detail: "artifacts currently indexed by ThreadDock",
          label: "Artifact count",
          value: String(backupRecords.length),
        },
        {
          detail: "encrypted file handoffs without an open network port",
          label: "Secure handoff",
          value: "Offline",
        },
        {
          detail: "restorable rollout bytes inside exports",
          label: "Portable mass",
          value: formatBytes(
            backupRecords.reduce((total, record) => total + record.totalBytes, 0),
          ),
        },
      ];
    case "trash":
      return [
        {
          detail: "trashed threads still within the restore guard",
          label: "Trash queue",
          value: String(visibleTrash.length),
        },
        {
          detail: "rollout bytes waiting for restore or purge",
          label: "Guarded bytes",
          value: formatBytes(
            visibleTrash.reduce((total, record) => total + record.rawRolloutBytes, 0),
          ),
        },
        {
          detail: "items expiring within the next three days",
          label: "Urgent exits",
          value: String(
            visibleTrash.filter((record) => {
              const remaining = new Date(record.expiresAt).getTime() - Date.now();
              return remaining > 0 && remaining <= 3 * 86_400_000;
            }).length,
          ),
        },
      ];
    case "rules":
      return [
        {
          detail: "saved cleanup rules in the library",
          label: "Rule book",
          value: String(cleanupRules.length),
        },
        {
          detail: "current integrity and cleanup warnings",
          label: "Pressure",
          value: String(healthData?.totalIssues ?? 0),
        },
        {
          detail: "filter tuning still applies to previews",
          label: "Surface mode",
          value: activeFilterCount === 0 ? "Draft" : `${activeFilterCount} tuned`,
        },
      ];
    case "health":
      return [
        {
          detail: "missing, unreadable, or orphaned records",
          label: "Integrity issues",
          value: String(healthData?.totalIssues ?? 0),
        },
        {
          detail: "largest workspace currently indexed",
          label: "Peak footprint",
          value: healthData?.largestWorkspaces[0]
            ? formatBytes(healthData.largestWorkspaces[0].summary.totalBytes)
            : "0 B",
        },
        {
          detail: "recent recorded lifecycle actions",
          label: "Pulse",
          value: String(healthData?.activityLog.length ?? 0),
        },
      ];
    case "settings":
      return [
        {
          detail: "live top-level threads still indexed",
          label: "Current library",
          value: String(catalog?.activeThreads.length ?? 0),
        },
        {
          detail: "workspace groups known to ThreadDock",
          label: "Workspace map",
          value: String(catalog?.workspaceGroups.length ?? 0),
        },
        {
          detail: "backup artifacts currently on disk",
          label: "Stored exports",
          value: String(backupRecords.length),
        },
      ];
  }
}

function countActiveFilters(filters: ThreadFilters): number {
  let count = 0;
  if (filters.query.trim()) count += 1;
  if (filters.workspaceFilter.trim()) count += 1;
  if (filters.threadIdQuery.trim()) count += 1;
  if (filters.parentThreadIdQuery.trim()) count += 1;
  if (filters.dateFrom) count += 1;
  if (filters.dateTo) count += 1;
  if (filters.minBytesMb.trim()) count += 1;
  if (filters.maxBytesMb.trim()) count += 1;
  if (filters.includeReadOnly !== "all") count += 1;
  if (filters.sourceFilter !== "all") count += 1;
  if (filters.sortKey !== "updated_desc") count += 1;
  return count;
}

function countSimpleHiddenFilters(filters: ThreadFilters): number {
  let count = 0;
  if (filters.workspaceFilter.trim()) count += 1;
  if (filters.threadIdQuery.trim()) count += 1;
  if (filters.parentThreadIdQuery.trim()) count += 1;
  if (filters.dateFrom) count += 1;
  if (filters.dateTo) count += 1;
  if (filters.minBytesMb.trim()) count += 1;
  if (filters.maxBytesMb.trim()) count += 1;
  if (filters.includeReadOnly !== "all") count += 1;
  if (filters.sourceFilter !== "all") count += 1;
  if (filters.sortKey !== "updated_desc") count += 1;
  return count;
}

function navTagline(section: SectionId): string {
  switch (section) {
    case "library":
      return "live stack";
    case "archives":
      return "cold shelf";
    case "subagents":
      return "branch map";
    case "workspaces":
      return "repo atlas";
    case "backups":
      return "portable vault";
    case "trash":
      return "30-day guard";
    case "rules":
      return "cleanup score";
    case "health":
      return "integrity pulse";
    case "settings":
      return "environment";
  }
}

function sectionMonogram(section: SectionId): string {
  switch (section) {
    case "library":
      return "LD";
    case "archives":
      return "AV";
    case "subagents":
      return "SG";
    case "workspaces":
      return "WS";
    case "backups":
      return "BK";
    case "trash":
      return "TR";
    case "rules":
      return "RL";
    case "health":
      return "HT";
    case "settings":
      return "ST";
  }
}

function sectionAtmosphere(section: SectionId): string {
  switch (section) {
    case "library":
      return "Active work, filtered and ready.";
    case "archives":
      return "Cold storage without losing context.";
    case "subagents":
      return "Branching runs kept in their own lane.";
    case "workspaces":
      return "Project weight by working directory.";
    case "backups":
      return "Portable artifacts for restore-first workflows.";
    case "trash":
      return "Guarded deletion with time to recover.";
    case "rules":
      return "Reusable cleanup rules with preview.";
    case "health":
      return "Storage pressure and integrity signals.";
    case "settings":
      return "Paths and defaults for this machine.";
  }
}

function getSectionCopy(
  section: SectionId,
  catalog: null | SurfaceCatalog,
  visibleSurface: VisibleSurface,
  visibleWorkspaces: WorkspaceGroup[],
  visibleTrash: TrashRecord[],
): SectionCopy {
  switch (section) {
    case "library":
      return {
        eyebrow: "Focus Library",
        title: "Active top-level threads",
        note: "Only live top-level threads stay here. Archives, subagents, and cleanup flows now move through separate operational lanes.",
        searchable: true,
        showSummary: true,
        emptyTitle: "No active top-level threads",
        emptyBody:
          visibleSurface.threads.length === 0 && (catalog?.activeThreads.length ?? 0) > 0
            ? "No live top-level thread matches the current filters."
            : "Your main library is clear.",
      };
    case "archives":
      return {
        eyebrow: "Archive Vault",
        title: "Archived top-level threads",
        note: "Historic top-level threads live here so the main library stays fast and readable.",
        searchable: true,
        showSummary: false,
        emptyTitle: "No archived top-level threads",
        emptyBody:
          visibleSurface.threads.length === 0 && (catalog?.archivedThreads.length ?? 0) > 0
            ? "No archived top-level thread matches the current filters."
            : "The archive vault is currently empty.",
      };
    case "subagents":
      return {
        eyebrow: "Agent Families",
        title: "Subagent cleanup lanes",
        note: "Subagents stay separate from the main library, grouped by parent workflow, with timeline, archive, backup, and trash actions at the family boundary.",
        searchable: true,
        showSummary: false,
        emptyTitle: "No subagent families",
        emptyBody:
          visibleSurface.families.length === 0 && (catalog?.familyCount ?? 0) > 0
            ? "No subagent family matches the current filters."
            : "No subagent families are currently indexed.",
      };
    case "workspaces":
      return {
        eyebrow: "Workspace Dashboard",
        title: "Workspace storage lanes",
        note: "See which repos and working directories are consuming the most Codex storage, where subagents are accumulating, and which workspace needs cleanup first.",
        searchable: true,
        showSummary: false,
        emptyTitle: "No workspaces",
        emptyBody:
          visibleWorkspaces.length === 0 && (catalog?.workspaceGroups.length ?? 0) > 0
            ? "No workspace matches the current filters."
            : "No workspace inventory is currently available.",
      };
    case "backups":
      return {
        eyebrow: "Backups",
        title: "Portable backup exports",
        note: "Export, import, and share thread bundles across machines without touching live Codex state until you explicitly restore.",
        searchable: false,
        showSummary: false,
        emptyTitle: "No backups recorded yet",
        emptyBody: "Create a backup from a thread or family inspector to populate this export library.",
      };
    case "trash":
      return {
        eyebrow: "Trash",
        title: "30-day restore guard",
        note: "Delete flows land here first. Nothing is hard-removed immediately unless you explicitly purge it.",
        searchable: true,
        showSummary: false,
        emptyTitle: "Trash is empty",
        emptyBody:
          visibleTrash.length === 0 && (catalog?.topLevelThreads.length ?? 0) > 0
            ? "No trash entry matches the current filters."
            : "No threads are currently waiting in Trash.",
      };
    case "rules":
      return {
        eyebrow: "Cleanup Rules",
        title: "Saved cleanup automation drafts",
        note: "Create reusable archive or trash rules, preview exact matches, then run them with a bulk confirmation instead of guessing what will move.",
        searchable: false,
        showSummary: false,
        emptyTitle: "No cleanup rules",
        emptyBody: "Create the first cleanup rule from the draft editor.",
      };
    case "health":
      return {
        eyebrow: "Health",
        title: "Storage and integrity",
        note: "Health surfaces the biggest workspaces, reclaim candidates, and rollout integrity problems without repeating dashboard cards on every page.",
        searchable: false,
        showSummary: false,
        emptyTitle: "No health diagnostics",
        emptyBody: "Storage and integrity diagnostics will populate here after ThreadDock indexes real data.",
      };
    case "settings":
      return {
        eyebrow: "Settings",
        title: "ThreadDock configuration",
        note: "Settings manages Codex-home overrides, read-only external archive paths, backup locations, and default export format.",
        searchable: false,
        showSummary: false,
        emptyTitle: "No settings loaded",
        emptyBody: "Configuration controls appear here once ThreadDock loads the current environment.",
      };
  }
}

function isSectionId(value: string): value is SectionId {
  return sections.some((item) => item.id === value);
}

function readFilterSettings(): ThreadFilters {
  if (typeof window === "undefined") {
    return DEFAULT_FILTERS;
  }
  try {
    const raw = window.localStorage.getItem("threaddock.filters");
    if (!raw) {
      return DEFAULT_FILTERS;
    }
    const parsed = JSON.parse(raw) as Partial<ThreadFilters>;
    return {
      ...DEFAULT_FILTERS,
      ...parsed,
      sortKey: isThreadSortKey(parsed.sortKey) ? parsed.sortKey : DEFAULT_FILTERS.sortKey,
      includeReadOnly: isIncludeReadOnly(parsed.includeReadOnly)
        ? parsed.includeReadOnly
        : DEFAULT_FILTERS.includeReadOnly,
      sourceFilter: isSourceFilter(parsed.sourceFilter) ? parsed.sourceFilter : DEFAULT_FILTERS.sourceFilter,
    };
  } catch {
    return DEFAULT_FILTERS;
  }
}

function readComplexityModeSetting(): ComplexityMode {
  if (typeof window === "undefined") {
    return "simple";
  }
  try {
    const raw = window.localStorage.getItem("threaddock.complexityMode");
    return isComplexityMode(raw) ? raw : "simple";
  } catch {
    return "simple";
  }
}

function writeFilterSettings(filters: ThreadFilters) {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem("threaddock.filters", JSON.stringify(filters));
  } catch {
    // Ignore local persistence failures.
  }
}

function readRuleDraftSetting(): RuleDraft {
  if (typeof window === "undefined") {
    return DEFAULT_RULE_DRAFT;
  }
  try {
    const raw = window.localStorage.getItem("threaddock.ruleDraft");
    if (!raw) {
      return DEFAULT_RULE_DRAFT;
    }
    return { ...DEFAULT_RULE_DRAFT, ...(JSON.parse(raw) as Partial<RuleDraft>) };
  } catch {
    return DEFAULT_RULE_DRAFT;
  }
}

function writeRuleDraftSetting(draft: RuleDraft) {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem("threaddock.ruleDraft", JSON.stringify(draft));
  } catch {
    // Ignore local persistence failures.
  }
}

function isThreadSortKey(value: unknown): value is ThreadSortKey {
  return value === "updated_desc" || value === "created_desc" || value === "title_asc" || value === "size_desc";
}

function isIncludeReadOnly(value: unknown): value is IncludeReadOnly {
  return value === "all" || value === "only" || value === "exclude";
}

function isSourceFilter(value: unknown): value is SourceFilter {
  return value === "all" || value === "user" || value === "subagent" || value === "unknown";
}

function isComplexityMode(value: unknown): value is ComplexityMode {
  return value === "simple" || value === "advanced";
}

function readTextSetting(key: string): string {
  if (typeof window === "undefined") {
    return "";
  }
  try {
    return window.localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

function writeTextSetting(key: string, value: string) {
  if (typeof window === "undefined") {
    return;
  }
  try {
    if (value.trim()) {
      window.localStorage.setItem(key, value);
    } else {
      window.localStorage.removeItem(key);
    }
  } catch {
    // Ignore local preference write failures.
  }
}

function createLocalId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function asErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
