import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent, ReactNode } from "react";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  ClockIcon,
  DatabaseIcon,
  ChevronsUpDownIcon,
  FileDownIcon,
  FileIcon,
  FileTextIcon,
  FilesIcon,
  Loader2Icon,
  ListTreeIcon,
  NetworkIcon,
  PlusIcon,
  RefreshCwIcon,
  XIcon,
} from "lucide-react";
import type { ApiContext, ApiGraphEdge, ApiGraphNode, ApiHistory, ApiNoteMetadataPatch, ApiNoteSource, ApiSection, ApiVaultCheck, ApiVaultTree, ApiVaultTreeNode, ApiWorkspaceStatus } from "../../src/api/contracts";
import type { NoteFrontmatter } from "../../src/core/types";
const Editor = lazy(() => import("./Editor").then((module) => ({ default: module.Editor })));
const GraphPane = lazy(() => import("./GraphPane").then((module) => ({ default: module.GraphPane })));
import { VaultPicker } from "./VaultPicker";
import { NoteMetadata } from "./components/note-metadata";
import { InspectorDrawer } from "./components/inspector-drawer";
import { ThemeToggle } from "./components/theme-toggle";
import { VaultTree } from "./components/vault-tree";
import { useDocumentSession } from "./document-session";
import { closeMainWindow, openRegisteredVault, invoke, type VaultEntry, type VaultRegistry } from "./vault-registry";
import type { Mode } from "./types";
import {
  getContext,
  createNote,
  getDiff,
  getHealth,
  getHistory,
  getNoteSource,
  getRepoDiff,
  getRepoHistory,
  getVaultCheck,
  getVaultTree,
  getWorkspaceStatus,
  exportNotePdf,
  listNotes,
  rebuildIndex,
  restoreNote,
  searchNotes,
  subscribeToChanges,
  type NoteSummary,
  updateNote,
} from "./api";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInput,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";

type Panel = "context" | "outline" | "git" | "diagnostics";
type Route = "notes" | "graph";

// A resolvable destination for one context-rail item: notes open in the
// notes view, cross-repo code opens the Git panel scoped to that repository
// and path (the only "workspace API" this runtime exposes for arbitrary
// files today). Same-repo code/project/package nodes carry no repository id
// (see project-graph.ts) so they have no destination yet — rendered plain.
type ContextDestination =
  | { kind: "note"; path: string }
  | { kind: "code"; repository: string; path: string };

type NoteCreationIssue = {
  kind: "save" | "create" | "load" | "refresh";
  message: string;
  path?: string;
};

type FocusRequest = { path: string; nonce: number };

type SaveResult =
  | { ok: true }
  | { ok: false; message: string };

function destinationFor(node: ApiGraphNode): ContextDestination | undefined {
  if (node.kind === "note" && node.path) return { kind: "note", path: node.path };
  const repository = node.metadata?.repository_id;
  if (typeof repository === "string" && node.path) return { kind: "code", repository, path: node.path };
  return undefined;
}

type VaultSession = {
  tabs: string[];
  activeTabPath: string | null;
  expandedTreePaths: string[];
  contextPanelOpen: boolean;
  panel: Panel;
  mode: Mode;
};

const DEFAULT_SESSION: VaultSession = {
  tabs: [],
  activeTabPath: null,
  expandedTreePaths: [],
  contextPanelOpen: false,
  panel: "context",
  mode: "reading",
};

const RECENTS_LIMIT = 8;

function routeFromHash(hash: string): Route {
  return hash.replace(/^#\/?/, "").startsWith("graph") ? "graph" : "notes";
}

// The graph route can carry an optional centered node id (#/graph/<nodeId>),
// set by the context rail's "View in graph" action — plain "#/graph" (from
// the header nav button) has no center and leaves the graph wherever it was.
function graphCenterFromHash(hash: string): string | undefined {
  const match = hash.replace(/^#\/?/, "").match(/^graph\/(.+)$/);
  return match ? decodeURIComponent(match[1]) : undefined;
}

function useRoute(): [Route, string | undefined, (next: Route, center?: string) => void] {
  const [route, setRoute] = useState<Route>(() => routeFromHash(window.location.hash));
  const [graphCenter, setGraphCenter] = useState<string | undefined>(() => graphCenterFromHash(window.location.hash));

  useEffect(() => {
    const onHashChange = () => {
      setRoute(routeFromHash(window.location.hash));
      setGraphCenter(graphCenterFromHash(window.location.hash));
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  return [route, graphCenter, (next: Route, center?: string) => {
    window.location.hash = next === "graph" ? "#/graph" + (center ? "/" + encodeURIComponent(center) : "") : "#/notes";
  }];
}

const isTauri = typeof window !== "undefined" && "__TAURI__" in window;
const isTauriDev = isTauri && import.meta.env.DEV;
const isTauriMac = isTauri && typeof navigator !== "undefined" && navigator.userAgent.includes("Macintosh");

type SidebarToolbarLayout = {
  sidebarWidth: string;
  collapsed: boolean;
};

function SidebarAlignedToolbar({ children }: { children: (layout: SidebarToolbarLayout) => ReactNode }) {
  const { isMobile, state } = useSidebar();
  const collapsed = isMobile || state === "collapsed";
  return <>{children({ sidebarWidth: isMobile ? "0px" : collapsed ? "3.5rem" : "18.75rem", collapsed })}</>;
}

function WorkspaceViewSwitcher({ route, onNavigate, disabled = false }: { route: Route; onNavigate: (next: Route) => void; disabled?: boolean }) {
  return (
    <div
      data-testid="workspace-view-switcher"
      role="tablist"
      aria-label="Workspace view"
      className="inline-flex shrink-0 items-center gap-0.5 rounded-md border border-border/70 bg-muted/45 p-px"
    >
      <Button
        type="button"
        role="tab"
        aria-selected={route === "notes"}
        data-testid="nodes-view"
        disabled={disabled}
        variant="ghost"
        size="sm"
        className={`h-7 gap-1 rounded-sm px-2 text-[11px] ${route === "notes" ? "bg-background/65 text-foreground shadow-sm hover:bg-background/65" : "text-muted-foreground"}`}
        onClick={() => onNavigate("notes")}
      >
        <ListTreeIcon className="size-3.5" />
        <span>Nodes</span>
      </Button>
      <Button
        type="button"
        role="tab"
        aria-selected={route === "graph"}
        data-testid="graph-view"
        disabled={disabled}
        variant="ghost"
        size="sm"
        className={`h-7 gap-1 rounded-sm px-2 text-[11px] ${route === "graph" ? "bg-background/65 text-foreground shadow-sm hover:bg-background/65" : "text-muted-foreground"}`}
        onClick={() => onNavigate("graph")}
      >
        <NetworkIcon className="size-3.5" />
        <span>Graph</span>
      </Button>
    </div>
  );
}

// Per-vault session isolation (Desktop V2 Multi-Vault UX Contract): the
// Tauri shell appends ?vault=<id> when it navigates into a vault's sidecar.
// Plain browser/dev usage (no Tauri, no query param) shares one "default"
// session, matching today's single-vault behavior.
const vaultKey = typeof window !== "undefined"
  ? new URLSearchParams(window.location.search).get("vault") ?? "default"
  : "default";
const sessionStorageKey = "cortex.vaultSession." + vaultKey;

function parseVaultSession(raw: string | null): VaultSession {
  try {
    if (!raw) return DEFAULT_SESSION;
    const parsed = JSON.parse(raw) as Partial<VaultSession>;
    return {
      tabs: Array.isArray(parsed.tabs) ? parsed.tabs : DEFAULT_SESSION.tabs,
      activeTabPath: typeof parsed.activeTabPath === "string" ? parsed.activeTabPath : null,
      expandedTreePaths: Array.isArray(parsed.expandedTreePaths) ? parsed.expandedTreePaths.filter((path): path is string => typeof path === "string") : DEFAULT_SESSION.expandedTreePaths,
      contextPanelOpen: typeof parsed.contextPanelOpen === "boolean" ? parsed.contextPanelOpen : false,
      panel: parsed.panel === "git" || parsed.panel === "outline" || parsed.panel === "diagnostics" ? parsed.panel : "context",
      mode: parsed.mode === "source" || parsed.mode === "live" ? parsed.mode : "reading",
    };
  } catch {
    return DEFAULT_SESSION;
  }
}

function loadVaultSession(): VaultSession {
  try {
    return parseVaultSession(localStorage.getItem(sessionStorageKey));
  } catch {
    return DEFAULT_SESSION;
  }
}

function cloneMetadata(metadata: NoteFrontmatter): NoteFrontmatter {
  return {
    ...metadata,
    aliases: [...metadata.aliases],
    tags: [...metadata.tags],
    applies_to: metadata.applies_to.map((item) => ({ ...item })),
    extra: { ...metadata.extra },
  };
}

function WorkspaceApp() {
  const [route, graphCenter, navigate] = useRoute();
  const [notes, setNotes] = useState<NoteSummary[]>([]);
  const initialSession = useMemo(loadVaultSession, []);
  const [sessionReady, setSessionReady] = useState(!isTauri);
  const [selected, setSelected] = useState<string | undefined>(initialSession.activeTabPath ?? undefined);
  // useEffect cleanup (which flips a closure's `stale` flag) is a *passive*
  // effect: React defers running it until after paint, whereas a fast local
  // fetch's .then() can resolve within the same microtask flush as the
  // click that changed `selected` — beating the cleanup and applying a
  // superseded note's content. Updating this ref happens synchronously
  // during render, before any effect (old or new) runs, so it never lags.
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const [tabs, setTabs] = useState<string[]>(initialSession.tabs);
  const [contextPanelOpen, setContextPanelOpen] = useState(initialSession.contextPanelOpen);
  const [expandedTreePaths, setExpandedTreePaths] = useState<Set<string>>(() => new Set(initialSession.expandedTreePaths));
  const [navHistory, setNavHistory] = useState<{ stack: string[]; index: number }>({ stack: [], index: -1 });
  const [source, setSource] = useState<ApiNoteSource>();
  const {
    draft,
    metadataDraft,
    isDirty,
    localRevision: localEditRevisionRef,
    draftRef,
    metadataDraftRef,
    isDirtyRef,
    updateDraft,
    updateMetadata,
    replace: replaceDocument,
    acknowledge: acknowledgeDocument,
  } = useDocumentSession();
  const [mode, setMode] = useState<Mode>(initialSession.mode);
  const [vaultTree, setVaultTree] = useState<ApiVaultTree>();
  const [previewPath, setPreviewPath] = useState<string>();
  const [vaultRegistry, setVaultRegistry] = useState<VaultRegistry>();
  const [vaultMenuOpen, setVaultMenuOpen] = useState(false);
  const [vaultMenuStatus, setVaultMenuStatus] = useState("");
  const [panel, setPanel] = useState<Panel>(initialSession.panel);
  const [query, setQuery] = useState("");
  const [searchResults, setSearchResults] = useState<Array<{ title: string; path: string; snippet: string }>>([]);
  const [status, setStatus] = useState("Ready");
  const [conflict, setConflict] = useState<{ remote: string; hash: string; sections: string[] }>();
  const [context, setContext] = useState<ApiContext>();
  const [history, setHistory] = useState<ApiHistory>();
  const [selectedRevision, setSelectedRevision] = useState<string>();
  const [diff, setDiff] = useState("");
  const [workspaceStatus, setWorkspaceStatus] = useState<ApiWorkspaceStatus>();
  const [workspaceGitLoaded, setWorkspaceGitLoaded] = useState(false);
  const [noteCount, setNoteCount] = useState<number>();
  const [vaultCheck, setVaultCheck] = useState<ApiVaultCheck>();
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [indexRefreshError, setIndexRefreshError] = useState(false);
  const [isExportingPdf, setIsExportingPdf] = useState(false);
  const [isCreatingNote, setIsCreatingNote] = useState(false);
  const [isRefreshingCreatedNote, setIsRefreshingCreatedNote] = useState(false);
  const [creationIssue, setCreationIssue] = useState<NoteCreationIssue>();
  const [focusTitleRequest, setFocusTitleRequest] = useState<FocusRequest>();
  const [focusBodyRequest, setFocusBodyRequest] = useState<FocusRequest>();
  const [noteLoadNonce, setNoteLoadNonce] = useState(0);
  const creationInFlightRef = useRef(false);
  const createdRefreshQueueRef = useRef(Promise.resolve());
  const pendingCreatedNoteRef = useRef<{ id: string; path: string } | undefined>(undefined);
  const lastCreatedNoteRef = useRef<{ id: string; path: string } | undefined>(undefined);
  const createdNotePathsRef = useRef(new Set<string>());
  const createdNoteSummariesRef = useRef(new Map<string, NoteSummary>());
  // Set when a context-rail "Implements"/"Owned by" item resolves to a
  // cross-repo code file: the Git panel switches from the active note's own
  // history to this repository-scoped file's history (the destination
  // "code opens through workspace APIs" requires).
  const [codeTarget, setCodeTarget] = useState<{ repository: string; path: string; name: string }>();
  const [codeHistory, setCodeHistory] = useState<ApiHistory>();
  const [codeSelectedRevision, setCodeSelectedRevision] = useState<string>();
  const [codeDiff, setCodeDiff] = useState("");
  const [jumpRequest, setJumpRequest] = useState<{ section: ApiSection; nonce: number }>();
  // Bumped whenever `draft`/`base` are replaced by something other than the
  // user's own typing (external reload, reconcile merge, conflict
  // resolution, revision restore) — AtomicCodeMirrorEditor's markdownSource
  // is mount-time only, so Editor keys its reading-mode documentId on this
  // to force the rendered pane to pick up the new content instead of going
  // stale (see Editor.tsx's contentRevision prop).
  const [contentRevision, setContentRevision] = useState(0);
  const saveRequestRef = useRef(0);
  const sessionSaveQueueRef = useRef(Promise.resolve());

  const currentTitle = metadataDraft?.title ?? source?.note.title ?? "Select a note";
  const activeNotePath = source?.note.path;

  const recentNotes = useMemo(
    () => notes.slice(0, RECENTS_LIMIT),
    [notes],
  );
  const openTabs = useMemo(
    () => tabs.map((path) => ({ path, title: notes.find((note) => note.path === path)?.title ?? path })),
    [tabs, notes],
  );
  const isStale = workspaceStatus?.repositories.some((repository) => repository.status === "stale") ?? false;
  const isIndexing = workspaceStatus?.phase === "warming" || workspaceStatus?.phase === "rebuilding" || workspaceStatus?.repositories.some((repository) => repository.status === "warming" || repository.status === "rebuilding") || false;
  const indexError = workspaceStatus?.phase === "error";
  const indexNeedsRefresh = isStale || indexError || indexRefreshError;
  const canGoBack = navHistory.index > 0;
  const canGoForward = navHistory.index < navHistory.stack.length - 1;

  const outlineSections = useMemo(
    () => (source?.sections ?? []).filter((section) => section.level <= 2).sort((a, b) => a.startLine - b.startLine),
    [source],
  );

  // Every node reachable in the active note's bounded neighborhood, keyed by
  // id, so a relationship edge's "other" endpoint can be resolved to a name/
  // path/kind for display — not just the file/note subsets getContext keeps
  // pre-filtered for other purposes.
  const contextNodeById = useMemo(() => {
    const map = new Map<string, ApiGraphNode>();
    if (context?.anchor) map.set(context.anchor.nodeId, context.anchor);
    for (const node of context?.likely_files ?? []) map.set(node.nodeId, node);
    for (const node of context?.attached_notes ?? []) map.set(node.nodeId, node);
    for (const node of context?.related_nodes ?? []) map.set(node.nodeId, node);
    return map;
  }, [context]);

  // Relationship labels, not anonymous backlinks: bucket only the active
  // note's own direct edges (not the full 2-hop neighborhood) by the
  // frontmatter relation that produced them.
  const relationshipGroups = useMemo(() => {
    const anchorId = context?.anchor?.nodeId;
    const groups = {
      implementsItems: [] as Array<{ edge: ApiGraphEdge; node: ApiGraphNode }>,
      relatedItems: [] as Array<{ edge: ApiGraphEdge; node: ApiGraphNode }>,
      ownedByItems: [] as Array<{ edge: ApiGraphEdge; node: ApiGraphNode }>,
    };
    if (!anchorId) return groups;
    for (const edge of context?.relationships ?? []) {
      if (edge.fromId !== anchorId && edge.toId !== anchorId) continue;
      const otherId = edge.fromId === anchorId ? edge.toId : edge.fromId;
      const node = contextNodeById.get(otherId);
      if (!node) continue;
      if (edge.kind === "implements") groups.implementsItems.push({ edge, node });
      else if (node.kind === "note" && (edge.kind === "wikilink" || edge.kind === "related_to" || edge.kind === "documents")) groups.relatedItems.push({ edge, node });
      else if (edge.kind === "owns") groups.ownedByItems.push({ edge, node });
    }
    return groups;
  }, [context, contextNodeById]);

  function parentDirectory(path: string): string | undefined {
    const separator = path.lastIndexOf("/");
    return separator > 0 ? path.slice(0, separator) : undefined;
  }

  function mergeNoteSummaries(incoming: NoteSummary[]): NoteSummary[] {
    const incomingPaths = new Set(incoming.map((note) => note.path));
    const missingCreated = [...createdNoteSummariesRef.current.values()]
      .filter((note) => !incomingPaths.has(note.path));
    return [...missingCreated, ...incoming];
  }

  function preserveCreatedTreeExpansion(tree: ApiVaultTree) {
    const createdParents = [...createdNotePathsRef.current]
      .map(parentDirectory)
      .filter((path): path is string => Boolean(path));
    setExpandedTreePaths((current) => {
      const next = new Set(current);
      if (next.size === 0) {
        for (const node of tree.children) {
          if (node.kind === "directory" && node.name === "notes") next.add(node.path);
        }
      }
      for (const path of createdParents) next.add(path);
      return next;
    });
  }

  function refreshVaultData() {
    listNotes(undefined, 100).then((result) => {
      const nextNotes = mergeNoteSummaries(result.notes);
      setNotes(nextNotes);
      // This is a paged catalog. A page miss is not a deletion: tabs and the
      // active document are authoritative identities independent of recents.
      setSelected((current) => current ?? nextNotes[0]?.path);
    }).catch(() => undefined);
    getVaultTree().then((tree) => {
      setVaultTree(tree);
      preserveCreatedTreeExpansion(tree);
    }).catch(() => undefined);
  }

  function refreshCreatedNoteData(path: string): Promise<void> {
    const run = async () => {
      setIsRefreshingCreatedNote(true);
      setStatus("Refreshing note list…");
      try {
        const [notesResult, treeResult] = await Promise.allSettled([listNotes(undefined, 100), getVaultTree()]);
        const failures: string[] = [];

        if (notesResult.status === "fulfilled") {
          const nextNotes = mergeNoteSummaries(notesResult.value.notes);
          setNotes(nextNotes);
          setSelected((current) => current ?? nextNotes[0]?.path);
        } else {
          failures.push(`notes list: ${notesResult.reason instanceof Error ? notesResult.reason.message : String(notesResult.reason)}`);
        }

        if (treeResult.status === "fulfilled") {
          setVaultTree(treeResult.value);
          preserveCreatedTreeExpansion(treeResult.value);
        } else {
          failures.push(`file tree: ${treeResult.reason instanceof Error ? treeResult.reason.message : String(treeResult.reason)}`);
        }

        refreshWorkspaceSignals();
        if (failures.length > 0) {
          const message = `The note was created, but the workspace could not refresh (${failures.join("; ")}).`;
          setCreationIssue((current) => current?.kind === "load" && current.path === path ? current : { kind: "refresh", path, message });
          setStatus("Note created; refresh needed");
        } else {
          setCreationIssue((current) => current?.kind === "refresh" && current.path === path ? undefined : current);
          setStatus((current) => current === "Refreshing note list…" ? "Note created" : current);
        }
      } finally {
        setIsRefreshingCreatedNote(false);
      }
    };
    const queued = createdRefreshQueueRef.current.then(run, run);
    createdRefreshQueueRef.current = queued.catch(() => undefined);
    return queued;
  }

  function refreshWorkspaceSignals() {
    getWorkspaceStatus().then((next) => {
      setWorkspaceStatus((current) => {
        const previousGitCounts = new Map((current?.repositories ?? []).map((repository) => [repository.id, repository.gitChangedFileCount]));
        return {
          ...next,
          repositories: next.repositories.map((repository) => ({
            ...repository,
            gitChangedFileCount: previousGitCounts.get(repository.id),
          })),
        };
      });
    }).catch(() => undefined);
    getHealth().then((health) => setNoteCount(health.index.noteCount)).catch(() => undefined);
  }

  async function refreshIndex() {
    if (isRefreshing || isCreatingNote) return;
    setIsRefreshing(true);
    setIndexRefreshError(false);
    setStatus("Refreshing index…");
    try {
      await rebuildIndex();
      setCreationIssue((current) => current?.kind === "create" ? undefined : current);
      refreshVaultData();
      refreshWorkspaceSignals();
      setStatus("Index refreshed");
    } catch (cause: unknown) {
      setIndexRefreshError(true);
      setStatus(cause instanceof Error ? `Index refresh failed: ${cause.message}` : `Index refresh failed: ${String(cause)}`);
    } finally {
      setIsRefreshing(false);
    }
  }

  function applySource(next: ApiNoteSource, bumpContentRevision = false) {
    setSource(next);
    replaceDocument(next);
    if (createdNotePathsRef.current.has(next.note.path)) {
      createdNoteSummariesRef.current.set(next.note.path, next.note);
      setNotes((current) => [next.note, ...current.filter((note) => note.path !== next.note.path)]);
    } else {
      setNotes((current) => current.map((note) => note.path === next.note.path ? next.note : note));
    }
    setConflict(undefined);
    setPreviewPath(undefined);
    if (bumpContentRevision) setContentRevision((revision) => revision + 1);
  }

  useEffect(() => {
    if (!isTauri) return;
    let active = true;
    invoke<string | null>("load_session", { vaultId: vaultKey }).then((raw) => {
      if (!active) return;
      const restored = parseVaultSession(raw);
      setSelected(restored.activeTabPath ?? undefined);
      setTabs(restored.tabs);
      setContextPanelOpen(restored.contextPanelOpen);
      setExpandedTreePaths(new Set(restored.expandedTreePaths));
      setPanel(restored.panel);
      setMode(restored.mode);
      setSessionReady(true);
    }).catch(() => {
      if (active) setSessionReady(true);
    });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!sessionReady) return;
    refreshVaultData();
    if (isTauri) invoke<VaultRegistry>("list_vaults").then(setVaultRegistry).catch(() => setVaultRegistry(undefined));
    refreshWorkspaceSignals();
  }, [sessionReady]);

  // Restore the persisted per-vault session's active tab into the nav
  // history stack once, so Back/Forward has a starting point after a
  // restart (Desktop V2 Multi-Vault UX Contract: tabs/outline/panel state
  // are isolated and restored per vault).
  useEffect(() => {
    if (!sessionReady || !selected) return;
    setNavHistory((current) => current.index >= 0 ? current : { stack: [selected], index: 0 });
  }, [sessionReady, selected]);

  useEffect(() => {
    if (!sessionReady) return;
    const payload: VaultSession = { tabs, activeTabPath: selected ?? null, expandedTreePaths: [...expandedTreePaths], contextPanelOpen, panel, mode };
    try {
      localStorage.setItem(sessionStorageKey, JSON.stringify(payload));
    } catch {
      // Storage can be unavailable (private browsing, quota); session
      // restore is a convenience, not a correctness requirement.
    }
    if (isTauri) {
      const serialized = JSON.stringify(payload);
      sessionSaveQueueRef.current = sessionSaveQueueRef.current
        .then(() => invoke("save_session", { vaultId: vaultKey, sessionJson: serialized }).then(() => undefined))
        .catch(() => undefined);
    }
  }, [sessionReady, tabs, selected, expandedTreePaths, contextPanelOpen, panel, mode]);

  useEffect(() => {
    if (!selected) return;
    const requested = selected;
    const isPendingCreatedNote = pendingCreatedNoteRef.current?.path === requested;
    let stale = false;
    setStatus("Loading " + selected);
    getNoteSource(selected).then((next) => {
      // selectedRef is updated synchronously during render, so it catches a
      // superseded response even when it resolves before this effect's own
      // (deferred, passive) cleanup runs — see the comment on selectedRef.
      if (stale || selectedRef.current !== requested) return;
      applySource(next);
      if (isPendingCreatedNote) {
        pendingCreatedNoteRef.current = undefined;
        creationInFlightRef.current = false;
        setIsCreatingNote(false);
        setFocusTitleRequest((current) => ({ path: requested, nonce: (current?.nonce ?? 0) + 1 }));
        setFocusBodyRequest(undefined);
        setCreationIssue((current) => current?.kind === "refresh" && current.path === requested ? current : undefined);
        setStatus("Note created");
      } else {
        setStatus("Saved");
      }
      setContext(undefined);
      setHistory(undefined);
      setSelectedRevision(undefined);
      setDiff("");
      getContext("note:" + next.note.id).then((nextContext) => {
        if (stale || selectedRef.current !== requested) return;
        setContext(nextContext);
      }).catch(() => { if (!stale && selectedRef.current === requested) setStatus("Loaded note; context is unavailable"); });
    }).catch((cause: unknown) => {
      if (stale || selectedRef.current !== requested) return;
      const message = cause instanceof Error ? cause.message : String(cause);
      if (isPendingCreatedNote) {
        creationInFlightRef.current = false;
        setIsCreatingNote(false);
        setCreationIssue({ kind: "load", path: requested, message });
        setStatus("Note created, but opening it failed");
      } else {
        setStatus(message);
      }
    });
    return () => { stale = true; };
  }, [selected, noteLoadNonce]);

  useEffect(() => {
    if (!source || panel !== "git" || codeTarget) return;
    let stale = false;
    getHistory(source.note.path).then((next) => {
      if (stale) return;
      setHistory(next);
      setSelectedRevision(next.commits[0]?.hash);
    }).catch(() => { if (!stale) setHistory(undefined); });
    return () => { stale = true; };
  }, [source, panel, codeTarget]);

  useEffect(() => {
    if (!contextPanelOpen || panel !== "diagnostics" || vaultCheck) return;
    let stale = false;
    getVaultCheck().then((next) => {
      if (!stale) setVaultCheck(next);
    }).catch(() => { if (!stale) setVaultCheck(undefined); });
    return () => { stale = true; };
  }, [contextPanelOpen, panel, vaultCheck]);

  useEffect(() => {
    if (!contextPanelOpen || panel !== "context" || !workspaceStatus?.active || workspaceGitLoaded) return;
    getWorkspaceStatus(true).then((next) => {
      setWorkspaceStatus(next);
      setWorkspaceGitLoaded(true);
    }).catch(() => undefined);
  }, [contextPanelOpen, panel, workspaceStatus?.active, workspaceGitLoaded]);

  useEffect(() => {
    return subscribeToChanges((changeSet) => {
      if (isCreatingNote) return;
      const events = changeSet.events;
      if (changeSet.resync_required) {
        refreshVaultData();
        refreshWorkspaceSignals();
        if (activeNotePath && !isDirty) getNoteSource(activeNotePath).then((next) => applySource(next, true)).catch(() => undefined);
        return;
      }
      const scopes = new Set(events.flatMap((event) => event.scopes ?? []));
      const deletedPaths = new Set(events.filter((event) => event.type === "delete").map((event) => event.path));
      if (deletedPaths.size > 0) {
        setTabs((current) => current.filter((path) => !deletedPaths.has(path)));
        if (selected && deletedPaths.has(selected) && !isDirty) {
          setSelected((current) => current && deletedPaths.has(current) ? undefined : current);
        }
      }
      // Versioned scopes keep body-only edits from refetching the whole tree
      // and catalog. Empty batches represent projection status transitions.
      if (events.length === 0 || scopes.has("catalog") || scopes.has("tree")) refreshVaultData();
      if (events.length === 0 || scopes.has("projection") || scopes.has("repository")) refreshWorkspaceSignals();
      if (!activeNotePath || !events.some((event) => event.path === activeNotePath)) return;
      if (!isDirty) {
        getNoteSource(activeNotePath).then((next) => {
          applySource(next, true);
          if (scopes.has("graph")) getContext("note:" + next.note.id).then(setContext).catch(() => undefined);
          setStatus("Reloaded external change");
        }).catch(() => setStatus("External change detected; reload failed"));
        return;
      }
      getNoteSource(activeNotePath).then((next) => {
        setConflict({ remote: next.markdown, hash: next.note.content_hash, sections: next.sections.map((section) => section.heading) });
        setStatus("Conflict requires review");
      }).catch(() => setStatus("External change detected; reload failed"));
    });
  }, [activeNotePath, isDirty, isCreatingNote]);

  useEffect(() => {
    if (panel !== "git" || codeTarget || !source || !selectedRevision) {
      setDiff("");
      return;
    }
    getDiff(source.note.path, selectedRevision).then((result) => setDiff(result.diff)).catch(() => setDiff("Diff unavailable"));
  }, [source, selectedRevision, panel, codeTarget]);

  useEffect(() => {
    setCodeTarget(undefined);
  }, [selected]);

  useEffect(() => {
    if (!codeTarget || panel !== "git") {
      setCodeHistory(undefined);
      setCodeSelectedRevision(undefined);
      return;
    }
    getRepoHistory(codeTarget.repository, codeTarget.path).then((next) => {
      setCodeHistory(next);
      setCodeSelectedRevision(next.commits[0]?.hash);
    }).catch(() => setCodeHistory(undefined));
  }, [codeTarget, panel]);

  useEffect(() => {
    if (panel !== "git" || !codeTarget || !codeSelectedRevision) {
      setCodeDiff("");
      return;
    }
    getRepoDiff(codeTarget.repository, codeTarget.path, codeSelectedRevision).then((result) => setCodeDiff(result.diff)).catch(() => setCodeDiff("Diff unavailable"));
  }, [codeTarget, codeSelectedRevision, panel]);

  function openCode(node: ApiGraphNode, destination: { repository: string; path: string }) {
    if (isCreatingNote) return;
    setCodeTarget({ repository: destination.repository, path: destination.path, name: node.name });
    setPanel("git");
    setContextPanelOpen(true);
  }

  function openGraphCode(node: ApiGraphNode) {
    if (isCreatingNote) return;
    const repository = node.metadata?.repository_id;
    if (typeof repository !== "string" || !node.path) return;
    openCode(node, { repository, path: node.path });
    navigate("notes");
  }

  function openContextItem(node: ApiGraphNode) {
    if (isCreatingNote) return;
    const destination = destinationFor(node);
    if (!destination) return;
    if (destination.kind === "note") openPath(destination.path);
    else openCode(node, destination);
  }

  function viewInGraph(nodeId: string) {
    if (isCreatingNote) return;
    navigate("graph", nodeId);
  }

  function requestJump(section: ApiSection) {
    if (mode === "source") setMode("reading");
    setJumpRequest((current) => ({ section, nonce: (current?.nonce ?? 0) + 1 }));
  }

  useEffect(() => {
    if (!query.trim()) {
      setSearchResults([]);
      return;
    }
    const timer = setTimeout(() => {
      searchNotes(query).then((result) => setSearchResults(result.hits)).catch(() => setSearchResults([]));
    }, 160);
    return () => clearTimeout(timer);
  }, [query]);

  async function save(): Promise<SaveResult> {
    if (!source || !metadataDraftRef.current || !isDirtyRef.current) return { ok: true };
    if (isSaving) return { ok: false, message: "A save is already in progress." };
    const requestedPath = source.note.path;
    const submittedRevision = localEditRevisionRef.current;
    const requestId = ++saveRequestRef.current;
    const expectedHash = source.note.content_hash;
    const submittedDraft = draftRef.current;
    const submittedMetadata = cloneMetadata(metadataDraftRef.current);
    setIsSaving(true);
    setStatus("Saving...");
    try {
      const metadata: ApiNoteMetadataPatch = {
        title: submittedMetadata.title,
        type: submittedMetadata.type,
        aliases: submittedMetadata.aliases,
        tags: submittedMetadata.tags,
        applies_to: submittedMetadata.applies_to,
        extra: submittedMetadata.extra,
      };
      const next = await updateNote(requestedPath, expectedHash, submittedDraft, metadata);
      if (selectedRef.current !== requestedPath || requestId !== saveRequestRef.current) return { ok: true };
      if (localEditRevisionRef.current === submittedRevision) {
        applySource(next);
        setStatus("Saved");
      } else {
        // The disk acknowledgement is still the new base, but a newer local
        // draft must remain in the editor. Applying the whole source here
        // would silently discard that draft.
        setSource(next);
        acknowledgeDocument(next, true);
        setNotes((current) => current.map((note) => note.path === next.note.path ? next.note : note));
        setStatus("Saved previous revision; newer edits kept");
      }
      return { ok: true };
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setStatus(message);
      return { ok: false, message };
    } finally {
      setIsSaving(false);
    }
  }

  async function exportPdf() {
    const currentMetadata = metadataDraftRef.current;
    console.info("[PDF-EXPORT] click", {
      isTauri,
      hasSource: Boolean(source),
      hasMetadata: Boolean(metadataDraft),
      titleLength: metadataDraft?.title.trim().length ?? 0,
      isExportingPdf,
    });
    if (!source || !currentMetadata || !currentMetadata.title.trim() || isExportingPdf) {
      console.warn("[PDF-EXPORT] click:guarded");
      return;
    }
    setIsExportingPdf(true);
    setStatus("Exporting PDF...");
    try {
      const result = await exportNotePdf(source.note.path, draftRef.current, currentMetadata.title);
      const nativeWindow = window as Window & { __TAURI__?: unknown };
      console.info("[PDF-EXPORT] delivery:detect", { isTauri, hasGlobalTauri: Boolean(nativeWindow.__TAURI__) });
      if (nativeWindow.__TAURI__) {
        const bytes = Array.from(new Uint8Array(await result.blob.arrayBuffer()));
        console.info("[PDF-EXPORT] delivery:native-start", { filename: result.filename, bytes: bytes.length });
        const savedPath = await invoke<string | null>("save_pdf", { filename: result.filename, bytes });
        console.info("[PDF-EXPORT] delivery:native-complete", { savedPath });
        setStatus(savedPath ? `PDF saved to ${savedPath}` : "PDF export canceled");
      } else {
        console.info("[PDF-EXPORT] delivery:browser-start", { filename: result.filename, bytes: result.blob.size });
        const url = URL.createObjectURL(result.blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = result.filename;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        URL.revokeObjectURL(url);
        console.info("[PDF-EXPORT] delivery:browser-complete", { filename: result.filename });
        setStatus("PDF exported");
      }
    } catch (cause: unknown) {
      console.error("[PDF-EXPORT] failed", cause);
      setStatus(cause instanceof Error ? `PDF export failed: ${cause.message}` : `PDF export failed: ${String(cause)}`);
    } finally {
      setIsExportingPdf(false);
    }
  }

  function confirmDiscard(message: string): boolean {
    if (!isDirty) return true;
    return window.confirm(message);
  }

  function pushNavHistory(path: string) {
    setNavHistory((current) => {
      if (current.stack[current.index] === path) return current;
      const truncated = current.stack.slice(0, current.index + 1);
      return { stack: [...truncated, path], index: truncated.length };
    });
  }

  function openPath(path: string, opts?: { skipHistory?: boolean; skipConfirm?: boolean }) {
    if (isCreatingNote) return;
    if (!opts?.skipConfirm && path !== selected && !confirmDiscard("You have unsaved changes. Discard them and switch notes?")) return;
    setSelected(path);
    setTabs((current) => (current.includes(path) ? current : [...current, path]));
    setPanel("context");
    setPreviewPath(undefined);
    if (!opts?.skipHistory) pushNavHistory(path);
    navigate("notes");
  }

  function closeTab(path: string, event?: Pick<MouseEvent, "stopPropagation">, options?: { closeWindowWhenLast?: boolean }) {
    event?.stopPropagation();
    if (isCreatingNote) return;
    if (path === selected && !confirmDiscard("You have unsaved changes. Discard them and close this tab?")) return;
    const index = tabs.indexOf(path);
    const next = tabs.filter((existing) => existing !== path);
    if (options?.closeWindowWhenLast && next.length === 0) {
      void closeMainWindow();
      return;
    }
    if (selected === path) setSelected(next[index] ?? next[index - 1]);
    setTabs(next);
  }

  useEffect(() => {
    const onWindowShortcut = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || !(event.metaKey || event.ctrlKey)) return;
      const key = event.key.toLowerCase();
      if (key === "n") {
        event.preventDefault();
        if (!isCreatingNote) void createNewNote();
        return;
      }
      if (key !== "w") return;
      event.preventDefault();
      if (isCreatingNote) return;
      if (selected) closeTab(selected, undefined, { closeWindowWhenLast: true });
      else void closeMainWindow();
    };
    window.addEventListener("keydown", onWindowShortcut);
    return () => window.removeEventListener("keydown", onWindowShortcut);
    // The handlers intentionally close over the current draft/navigation
    // state; re-registering the single global listener when that state
    // changes keeps Cmd/Ctrl+N and Cmd/Ctrl+W race-free.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, tabs, isDirty, isCreatingNote]);

  function goBack() {
    if (isCreatingNote || !canGoBack) return;
    const index = navHistory.index - 1;
    const target = navHistory.stack[index];
    if (target !== selected && !confirmDiscard("You have unsaved changes. Discard them and go back?")) return;
    setNavHistory({ ...navHistory, index });
    openPath(target, { skipHistory: true, skipConfirm: true });
  }

  function goForward() {
    if (isCreatingNote || !canGoForward) return;
    const index = navHistory.index + 1;
    const target = navHistory.stack[index];
    if (target !== selected && !confirmDiscard("You have unsaved changes. Discard them and go forward?")) return;
    setNavHistory({ ...navHistory, index });
    openPath(target, { skipHistory: true, skipConfirm: true });
  }

  async function switchVault(id: string) {
    if (isCreatingNote) return;
    if (!confirmDiscard("You have unsaved changes. Discard them and switch vaults?")) return;
    setVaultMenuStatus("Starting vault runtime…");
    try {
      await sessionSaveQueueRef.current;
      await openRegisteredVault(id);
    } catch (cause) {
      setVaultMenuStatus(String(cause));
    }
  }

  async function keepMine() {
    const currentMetadata = metadataDraftRef.current;
    if (!source || !conflict || !currentMetadata) return;
    try {
      const next = await updateNote(source.note.path, conflict.hash, draftRef.current, {
        title: currentMetadata.title,
        type: currentMetadata.type,
        aliases: currentMetadata.aliases,
        tags: currentMetadata.tags,
        applies_to: currentMetadata.applies_to,
        extra: currentMetadata.extra,
      });
      applySource(next);
      setStatus("Kept local version");
    } catch (cause: unknown) {
      setStatus(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function restoreSelected() {
    if (!source || !selectedRevision) return;
    setStatus("Restoring...");
    try {
      await restoreNote(source.note.path, selectedRevision);
      const next = await getNoteSource(source.note.path);
      applySource(next, true);
      setStatus("Restored " + selectedRevision.slice(0, 7));
    } catch (cause: unknown) {
      setStatus(cause instanceof Error ? cause.message : String(cause));
    }
  }

  function toggleTreePath(path: string) {
    if (isCreatingNote) return;
    setExpandedTreePaths((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  function openTreeNode(node: Extract<ApiVaultTreeNode, { kind: "note" | "file" }>) {
    if (isCreatingNote) return;
    if (node.kind === "note") {
      openPath(node.path);
      return;
    }
    setPreviewPath(node.path);
    setStatus("This vault file is not an indexed note");
  }

  async function addVaultFromMenu() {
    if (isCreatingNote) return;
    setVaultMenuStatus("Choose a vault folder…");
    try {
      const entry = await invoke<VaultEntry | null>("add_vault_via_dialog");
      if (entry) await openRegisteredVault(entry.id);
      else setVaultMenuStatus("");
    } catch (cause) {
      setVaultMenuStatus(String(cause));
    }
  }

  async function revealVault(id: string) {
    if (isCreatingNote) return;
    try {
      await invoke("reveal_vault", { id });
    } catch (cause) {
      setVaultMenuStatus(String(cause));
    }
  }

  function finishNoteCreation() {
    creationInFlightRef.current = false;
    setIsCreatingNote(false);
  }

  async function createNewNote() {
    if (creationInFlightRef.current || isCreatingNote) return;
    creationInFlightRef.current = true;
    setIsCreatingNote(true);
    setCreationIssue(undefined);
    setStatus("Preparing new note…");

    const saved = await save();
    if (!saved.ok) {
      finishNoteCreation();
      navigate("notes");
      setCreationIssue({ kind: "save", message: `The current note could not be saved: ${saved.message}` });
      return;
    }

    setStatus("Creating note…");
    let created: { path: string; id: string };
    try {
      created = await createNote({ title: "Untitled", type: "note" });
    } catch (cause: unknown) {
      const message = cause instanceof Error ? cause.message : String(cause);
      finishNoteCreation();
      navigate("notes");
      setCreationIssue({ kind: "create", message: `The create request may have completed, so refresh before trying again. The note could not be created: ${message}` });
      setStatus("Note creation failed; refresh before trying again");
      return;
    }

    pendingCreatedNoteRef.current = created;
    lastCreatedNoteRef.current = created;
    createdNotePathsRef.current.add(created.path);
    const now = new Date().toISOString();
    createdNoteSummariesRef.current.set(created.path, {
      id: created.id,
      path: created.path,
      title: "Untitled",
      type: "note",
      created_at: now,
      updated_at: now,
      aliases: [],
      tags: [],
      content_hash: "",
    });
    setNotes((current) => [createdNoteSummariesRef.current.get(created.path)!, ...current.filter((note) => note.path !== created.path)]);
    setStatus("Opening note…");
    setCreationIssue(undefined);
    setPreviewPath(undefined);
    setPanel("context");
    setTabs((current) => current.includes(created.path) ? current : [...current, created.path]);
    setSelected(created.path);
    pushNavHistory(created.path);
    navigate("notes");
    void refreshCreatedNoteData(created.path);
  }

  function retryOpenCreatedNote() {
    if (isCreatingNote) return;
    const created = lastCreatedNoteRef.current;
    if (!created) return;
    pendingCreatedNoteRef.current = created;
    creationInFlightRef.current = true;
    setIsCreatingNote(true);
    setCreationIssue(undefined);
    setStatus("Opening note…");
    setNoteLoadNonce((nonce) => nonce + 1);
  }

  async function retryCreatedNoteRefresh() {
    if (isCreatingNote || isRefreshingCreatedNote) return;
    const path = creationIssue?.path ?? lastCreatedNoteRef.current?.path;
    if (!path) return;
    setCreationIssue(undefined);
    await refreshCreatedNoteData(path);
  }

  function focusBodyAfterTitle() {
    if (!activeNotePath || isCreatingNote) return;
    if (mode === "reading") setMode("live");
    setFocusBodyRequest((current) => ({ path: activeNotePath, nonce: (current?.nonce ?? 0) + 1 }));
  }

  function completeTitleFocus(request: FocusRequest) {
    setFocusTitleRequest((current) => current?.path === request.path && current.nonce === request.nonce ? undefined : current);
  }

  function completeBodyFocus(request: FocusRequest) {
    setFocusBodyRequest((current) => current?.path === request.path && current.nonce === request.nonce ? undefined : current);
  }

  async function takeTheirs() {
    if (!activeNotePath) return;
    try {
      const next = await getNoteSource(activeNotePath);
      applySource(next, true);
      setStatus("Using external version");
    } catch (cause) {
      setStatus(cause instanceof Error ? cause.message : String(cause));
    }
  }

  const activeVaultId = typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("vault") : null;
  const activeVault = vaultRegistry?.vaults.find((vault) => vault.id === activeVaultId);
  const vaultName = activeVault?.name ?? vaultTree?.rootName ?? "Vault";

  return (
    <div className="flex h-dvh min-h-0 flex-col overflow-hidden bg-background">
      <SidebarProvider defaultOpen className="!min-h-0 h-full flex-1 flex-col overflow-hidden [contain:layout]">
        <SidebarAlignedToolbar>
          {({ sidebarWidth, collapsed }) => (
            <header className={`relative z-30 h-[52px] w-full shrink-0 overflow-hidden bg-background ${collapsed ? "flex items-center" : "grid"}`} style={collapsed ? undefined : { gridTemplateColumns: `${sidebarWidth} minmax(0, 1fr)` }}>
              <div className={`flex shrink-0 items-center gap-2 bg-sidebar ${collapsed ? "" : "min-w-0 border-r border-sidebar-border"} ${isTauriMac ? "pl-24 pr-3" : "px-3"}`}>
                <SidebarTrigger
                  aria-label="Toggle sidebar"
                  size="icon-lg"
                  className="size-8 rounded-md text-foreground/70 hover:bg-muted/70 hover:text-foreground [&_svg]:size-4"
                />
                <WorkspaceViewSwitcher route={route} onNavigate={navigate} disabled={isCreatingNote} />
              </div>
              <div className={`flex min-w-0 flex-1 items-center gap-2 px-3 ${route === "notes" ? "note-toolbar-surface" : ""}`}>
                <Button variant="ghost" size="icon-sm" aria-label="Back" disabled={isCreatingNote || !canGoBack} onClick={goBack}><ArrowLeftIcon /></Button>
                <Button variant="ghost" size="icon-sm" aria-label="Forward" disabled={isCreatingNote || !canGoForward} onClick={goForward}><ArrowRightIcon /></Button>
                <div className="cortex-tabs-scroll ml-3 flex min-w-0 flex-1 items-center gap-2 overflow-x-auto overscroll-x-contain" role="tablist" aria-label="Open notes">
                  {openTabs.map((tab) => (
                    <div key={tab.path} data-active-tab={selected === tab.path ? "true" : "false"} className={"group flex max-w-[220px] shrink-0 items-center text-xs transition-colors " + (selected === tab.path ? "rounded-md bg-muted/50 font-medium text-foreground" : "text-muted-foreground hover:text-foreground")}>
                      <button type="button" role="tab" aria-selected={selected === tab.path} data-testid="open-tab" disabled={isCreatingNote} onClick={() => openPath(tab.path)} className="min-w-0 flex-1 truncate px-1 py-1.5 text-left">{tab.title}</button>
                      <button type="button" aria-label={`Close ${tab.title}`} disabled={isCreatingNote} onClick={(event) => closeTab(tab.path, event)} className="rounded px-1 py-1.5 opacity-0 hover:bg-muted group-hover:opacity-100"><XIcon className="size-3" /></button>
                    </div>
                  ))}
                </div>
                {isDirty && <Button size="sm" className="shrink-0" onClick={() => void save()} disabled={!source || isCreatingNote || isSaving}>{isSaving ? "Saving…" : "Save"}</Button>}
                <Button variant="ghost" size="sm" className="shrink-0 gap-1" data-testid="export-pdf" aria-label="Export PDF" onClick={() => void exportPdf()} disabled={!source || !metadataDraft?.title.trim() || isExportingPdf || isCreatingNote}>
                  <FileDownIcon className={isExportingPdf ? "animate-pulse" : undefined} />
                  <span className="hidden sm:inline">{isExportingPdf ? "Exporting…" : "Export PDF"}</span>
                </Button>
                <Tooltip>
                  <TooltipTrigger
                    render={<Button variant="ghost" size="icon-sm" className="shrink-0" aria-label="New note" data-testid="new-note-button" disabled={isCreatingNote} onClick={() => void createNewNote()} />}
                  >
                    {isCreatingNote ? <Loader2Icon className="animate-spin" /> : <PlusIcon />}
                  </TooltipTrigger>
                  <TooltipContent>New note (⌘N / Ctrl+N)</TooltipContent>
                </Tooltip>
                {isCreatingNote && <span data-testid="note-creation-progress" className="max-w-[180px] truncate text-xs text-muted-foreground">{status}</span>}
                <span className="sr-only" aria-live="polite">{status}</span>
                {status.includes("PDF") && <span className="max-w-[220px] truncate text-xs text-muted-foreground" data-testid="export-status" title={status}>{status}</span>}
              </div>
            </header>
          )}
        </SidebarAlignedToolbar>

        <div className="flex min-h-0 w-full flex-1">
          <Sidebar collapsible="icon" className="!top-[52px] !h-[calc(100svh-52px)]">
            <SidebarHeader className="gap-2.5">
              <SidebarInput placeholder="Search" aria-label="Search notes" value={query} disabled={isCreatingNote} onChange={(event) => setQuery(event.target.value)} />
              {searchResults.length > 0 && <SidebarGroup><SidebarGroupLabel>Search results</SidebarGroupLabel><SidebarMenu>{searchResults.map((result) => <SidebarMenuItem key={result.path}><SidebarMenuButton size="lg" data-testid="search-result" onClick={() => openPath(result.path)}><FileTextIcon /><div className="flex min-w-0 flex-col items-start gap-0.5 group-data-[collapsible=icon]:hidden"><span className="truncate font-medium">{result.title}</span><span className="truncate text-[10px] text-muted-foreground">{result.snippet}</span></div></SidebarMenuButton></SidebarMenuItem>)}</SidebarMenu></SidebarGroup>}
            </SidebarHeader>
            <SidebarContent>
              <SidebarGroup>
                <SidebarGroupLabel><ClockIcon className="mr-1 size-3" />Recents</SidebarGroupLabel>
                <SidebarMenu>{recentNotes.map((note) => <SidebarMenuItem key={`recent:${note.path}`}><SidebarMenuButton data-testid="recent-row" size="sm" isActive={selected === note.path} tooltip={note.title} onClick={() => openPath(note.path)}><FileTextIcon /><span className="truncate group-data-[collapsible=icon]:hidden">{note.title}</span></SidebarMenuButton></SidebarMenuItem>)}</SidebarMenu>
              </SidebarGroup>
              <SidebarGroup>
                <SidebarGroupLabel>Everything <Badge variant="outline" className="ml-1.5 px-1 py-0 text-[9px] font-normal group-data-[collapsible=icon]:hidden">{notes.length}</Badge></SidebarGroupLabel>
                {vaultTree ? <VaultTree nodes={vaultTree.children} selectedPath={selected} expandedPaths={expandedTreePaths} onToggle={toggleTreePath} onOpen={openTreeNode} /> : <p className="px-2 text-[11px] text-muted-foreground group-data-[collapsible=icon]:hidden">Loading files…</p>}
              </SidebarGroup>
            </SidebarContent>
            <SidebarFooter className="relative p-3">
              <div className="flex items-center gap-1.5">
                <button type="button" aria-label="Switch vault" data-testid="vault-switcher" disabled={isCreatingNote} onClick={() => { setVaultMenuOpen((open) => !open); setVaultMenuStatus(""); }} className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-3 py-2 text-left text-[13px] font-medium text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground disabled:pointer-events-none disabled:opacity-50">
                  <ChevronsUpDownIcon data-testid="vault-switcher-glyph" className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate group-data-[collapsible=icon]:hidden">{vaultName}</span>
                </button>
                <ThemeToggle />
              </div>
              {vaultMenuOpen && isTauri && <div className="absolute right-2 bottom-[calc(100%+8px)] left-2 z-40 rounded-lg border bg-popover p-1.5 shadow-xl"><div className="px-2 py-1.5 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">Switch vault</div>{(vaultRegistry?.vaults ?? []).map((vault) => <div key={vault.id} className="flex items-center gap-1"><button type="button" disabled={isCreatingNote} className="min-w-0 flex-1 truncate rounded-md px-2 py-1.5 text-left text-xs hover:bg-muted disabled:opacity-50" onClick={() => void switchVault(vault.id)}>{vault.id === activeVaultId ? "✓ " : ""}{vault.name}</button><button type="button" aria-label={`Reveal ${vault.name}`} disabled={isCreatingNote} className="rounded-md px-1.5 py-1 text-[10px] text-muted-foreground hover:bg-muted disabled:opacity-50" onClick={() => void revealVault(vault.id)}>↗</button></div>)}<button type="button" disabled={isCreatingNote} className="mt-1 w-full rounded-md px-2 py-1.5 text-left text-xs text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50" onClick={() => void addVaultFromMenu()}>+ Add vault…</button>{vaultMenuStatus && <p className="px-2 py-1 text-[10px] text-muted-foreground">{vaultMenuStatus}</p>}</div>}
            </SidebarFooter>
          </Sidebar>

          <SidebarInset data-testid="workspace" className="relative min-w-0">
            {route === "graph" ? <section className="flex min-h-0 flex-1 flex-col bg-background"><Suspense fallback={<div className="grid min-h-0 flex-1 place-items-center text-sm text-muted-foreground">Loading graph tools…</div>}><GraphPane onOpenPath={openPath} onOpenCode={openGraphCode} onBackToNote={() => { if (!isCreatingNote) navigate("notes"); }} activeNoteLabel={source?.note.title} initialCenter={graphCenter} initialCenterLabel={currentTitle} /></Suspense></section> : <div className="note-workspace flex min-h-0 flex-1 flex-col" aria-busy={isCreatingNote}>
              <div data-testid="note-document-scroll" className="note-document-scroll min-h-0 flex-1 overflow-auto overscroll-contain">
                {creationIssue && <Alert data-testid="note-creation-status" variant="destructive" className="m-3"><AlertTitle>{creationIssue.kind === "save" ? "Could not create note" : creationIssue.kind === "load" ? "Note created but could not be opened" : creationIssue.kind === "refresh" ? "Note created but workspace refresh failed" : "Could not create note"}</AlertTitle><AlertDescription><p>{creationIssue.message}</p>{creationIssue.kind === "load" && <Button size="sm" variant="outline" disabled={isCreatingNote} onClick={() => void retryOpenCreatedNote()}>Open created note again</Button>}{creationIssue.kind === "refresh" && <Button size="sm" variant="outline" disabled={isRefreshingCreatedNote || isCreatingNote} onClick={() => void retryCreatedNoteRefresh()}>{isRefreshingCreatedNote ? "Refreshing…" : "Refresh"}</Button>}{creationIssue.kind === "create" && <Button size="sm" variant="outline" disabled={isRefreshing || isCreatingNote} onClick={() => void refreshIndex()}>Refresh</Button>}</AlertDescription></Alert>}
                {source && metadataDraft ? <NoteMetadata metadata={metadataDraft} mode={mode} dirty={isDirty} notePath={activeNotePath} connectedFiles={context?.likely_files?.length ?? 0} disabled={isCreatingNote} focusTitleRequest={focusTitleRequest} onTitleFocusComplete={completeTitleFocus} onTitleEnter={focusBodyAfterTitle} onChange={updateMetadata} onModeChange={setMode} onToggleInspector={() => setContextPanelOpen(true)} /> : previewPath ? <Empty className="h-full"><EmptyHeader><EmptyMedia variant="icon"><FileIcon /></EmptyMedia><EmptyTitle>File preview unavailable</EmptyTitle><EmptyDescription>{previewPath} is not an indexed Markdown note.</EmptyDescription></EmptyHeader></Empty> : <Empty className="h-full"><EmptyHeader><EmptyMedia variant="icon"><FileTextIcon /></EmptyMedia><EmptyTitle>Choose a note</EmptyTitle><EmptyDescription>The indexed Markdown workspace will appear here.</EmptyDescription><Button data-testid="create-note-empty" onClick={() => void createNewNote()} disabled={isCreatingNote}><PlusIcon />Create note</Button></EmptyHeader></Empty>}
                {source && <div className="note-editor-section flex border-t border-border/60"><Suspense fallback={<div className="grid min-h-[440px] flex-1 place-items-center text-sm text-muted-foreground">Loading editor…</div>}><Editor key={activeNotePath + ":" + (isCreatingNote ? "busy" : "ready")} value={draft} mode={mode} onChange={isCreatingNote ? () => undefined : updateDraft} linkTargets={notes.map((note) => note.title)} notePath={activeNotePath} notes={notes} onOpenNote={openPath} sections={source.sections} contentRevision={contentRevision} jumpRequest={jumpRequest} disabled={isCreatingNote} focusRequest={focusBodyRequest} onFocusComplete={completeBodyFocus} /></Suspense></div>}
              </div>
              {conflict && <Alert variant="destructive" className="m-3 shrink-0"><AlertTitle>External edit needs your decision</AlertTitle><AlertDescription><p>Conflicts: {conflict.sections.join(", ")}</p><div className="mt-2 flex gap-2"><Button size="sm" variant="outline" onClick={() => void takeTheirs()}>Take theirs</Button><Button size="sm" variant="outline" onClick={() => void keepMine()}>Keep mine</Button></div></AlertDescription></Alert>}
              <footer data-testid="workspace-status-footer" className="relative z-20 flex h-8 shrink-0 items-center gap-3 bg-background/92 px-4 text-[11px] text-muted-foreground backdrop-blur-md before:pointer-events-none before:absolute before:inset-x-0 before:-top-10 before:h-10 before:bg-gradient-to-b before:from-transparent before:via-background/65 before:to-background before:backdrop-blur-[2px] before:content-['']"><span className="relative z-10 flex items-center gap-1"><FilesIcon className="size-3" />{noteCount ?? notes.length} notes</span><span className="relative z-10 flex items-center gap-1"><DatabaseIcon className="size-3" />{workspaceStatus?.repositories.length ?? 0} repositories</span><span aria-live="polite" className={"relative z-10 ml-auto flex items-center gap-1.5" + ((indexNeedsRefresh || isIndexing || isRefreshing) ? " text-warning" : "")}>
                {indexNeedsRefresh || isRefreshing ? <button type="button" data-testid="refresh-index" aria-label={isRefreshing ? "Refreshing index" : "Refresh index"} title={isRefreshing ? "Refreshing index…" : "Refresh index"} disabled={isRefreshing} onClick={() => void refreshIndex()} className="group/refresh inline-flex size-5 items-center justify-center rounded-sm text-warning transition-colors hover:bg-warning/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-warning/40 disabled:cursor-wait"><RefreshCwIcon className={"size-3 transition-transform " + (isRefreshing ? "animate-spin" : "group-hover/refresh:rotate-45")} aria-hidden="true" /><span className="sr-only">{isRefreshing ? "Refreshing index" : "Refresh index"}</span></button> : isIndexing ? <Loader2Icon className="size-3 animate-spin" aria-hidden="true" /> : <span className="size-1.5 rounded-full bg-primary" aria-hidden="true" />}
                <span>{isRefreshing ? "Refreshing index…" : isIndexing ? (workspaceStatus?.phase === "warming" ? "Workspace warming…" : "Index rebuilding…") : indexError || indexRefreshError ? "Index error" : isStale ? "Index stale" : "Index current"}</span>
              </span></footer>
            </div>}
            <InspectorDrawer open={contextPanelOpen && !isCreatingNote} panel={panel} source={source} context={context} workspaceStatus={workspaceStatus} vaultCheck={vaultCheck} relationshipGroups={relationshipGroups} history={history} selectedRevision={selectedRevision} diff={diff} codeTarget={codeTarget} codeHistory={codeHistory} codeSelectedRevision={codeSelectedRevision} codeDiff={codeDiff} outlineSections={outlineSections} onClose={() => setContextPanelOpen(false)} onPanelChange={setPanel} onOpenContextItem={openContextItem} onViewInGraph={() => context?.anchor && viewInGraph(context.anchor.nodeId)} onRequestJump={requestJump} onSelectRevision={setSelectedRevision} onSelectCodeRevision={setCodeSelectedRevision} onBackToNote={() => setCodeTarget(undefined)} onRestore={() => void restoreSelected()} />
          </SidebarInset>
        </div>
      </SidebarProvider>
    </div>
  );
}

function App() {
  const hasSelectedVault = typeof window !== "undefined" && new URLSearchParams(window.location.search).has("vault");
  if (isTauriDev && !hasSelectedVault) return <VaultPicker />;
  return <WorkspaceApp />;
}

export default App;
