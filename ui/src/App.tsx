import { useEffect, useMemo, useState } from "react";
import {
  FileTextIcon,
  HistoryIcon,
  NetworkIcon,
  NotebookTextIcon,
  PanelRightIcon,
  RotateCcwIcon,
} from "lucide-react";
import type { ApiContext, ApiHistory, ApiNoteSource } from "../../src/api/contracts";
import { Editor } from "./Editor";
import { GraphPane } from "./GraphPane";
import {
  getContext,
  getDiff,
  getHistory,
  getNoteSource,
  listNotes,
  reconcile,
  replaceNote,
  restoreNote,
  searchNotes,
  subscribeToChanges,
  type NoteSummary,
} from "./api";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInput,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarSeparator,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ThemeToggle } from "@/components/theme-toggle";

type Mode = "source" | "reading";
type Panel = "context" | "git";
type Route = "notes" | "graph";

function routeFromHash(hash: string): Route {
  return hash.replace(/^#\/?/, "") === "graph" ? "graph" : "notes";
}

function useRoute(): [Route, (next: Route) => void] {
  const [route, setRoute] = useState<Route>(() => routeFromHash(window.location.hash));

  useEffect(() => {
    const onHashChange = () => setRoute(routeFromHash(window.location.hash));
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  return [route, (next: Route) => { window.location.hash = next === "graph" ? "#/graph" : "#/notes"; }];
}

function ContextSidebarTrigger() {
  const { toggleSidebar } = useSidebar();
  return (
    <Button variant="ghost" size="icon-sm" onClick={toggleSidebar}>
      <PanelRightIcon />
      <span className="sr-only">Toggle context panel</span>
    </Button>
  );
}

const isTauri = typeof window !== "undefined" && "__TAURI__" in window;

function App() {
  const [route, navigate] = useRoute();
  const [notes, setNotes] = useState<NoteSummary[]>([]);
  const [selected, setSelected] = useState<string>();
  const [source, setSource] = useState<ApiNoteSource>();
  const [draft, setDraft] = useState("");
  const [base, setBase] = useState("");
  const [mode, setMode] = useState<Mode>("reading");
  const [panel, setPanel] = useState<Panel>("context");
  const [query, setQuery] = useState("");
  const [searchResults, setSearchResults] = useState<Array<{ title: string; path: string; snippet: string }>>([]);
  const [status, setStatus] = useState("Ready");
  const [conflict, setConflict] = useState<{ remote: string; hash: string; sections: string[] }>();
  const [context, setContext] = useState<ApiContext>();
  const [history, setHistory] = useState<ApiHistory>();
  const [selectedRevision, setSelectedRevision] = useState<string>();
  const [diff, setDiff] = useState("");

  const isDirty = draft !== base;
  const currentTitle = source?.note.title ?? "Select a note";
  const activeNotePath = source?.note.path;

  const visibleNotes = useMemo(() => {
    if (!query) return notes;
    const lowered = query.toLocaleLowerCase();
    return notes.filter((note) => note.title.toLocaleLowerCase().includes(lowered) || note.path.toLocaleLowerCase().includes(lowered));
  }, [notes, query]);

  useEffect(() => {
    listNotes(undefined, 100).then((result) => {
      setNotes(result.notes);
      if (result.notes[0]) setSelected(result.notes[0].path);
    }).catch((cause: unknown) => setStatus(cause instanceof Error ? cause.message : String(cause)));
  }, []);

  useEffect(() => {
    if (!selected) return;
    setStatus("Loading " + selected);
    getNoteSource(selected).then((next) => {
      setSource(next);
      setDraft(next.markdown);
      setBase(next.markdown);
      setConflict(undefined);
      setStatus("Saved");
      setContext(undefined);
      setHistory(undefined);
      setSelectedRevision(undefined);
      setDiff("");
      Promise.all([getContext("note:" + next.note.id), getHistory(next.note.path)]).then(([nextContext, nextHistory]) => {
        setContext(nextContext);
        setHistory(nextHistory);
        setSelectedRevision(nextHistory.commits[0]?.hash);
      }).catch(() => setStatus("Loaded note; context is unavailable"));
    }).catch((cause: unknown) => setStatus(cause instanceof Error ? cause.message : String(cause)));
  }, [selected]);

  useEffect(() => {
    return subscribeToChanges((events) => {
      if (!activeNotePath || !events.some((event) => event.path === activeNotePath)) return;
      if (!isDirty) {
        getNoteSource(activeNotePath).then((next) => {
          setSource(next);
          setDraft(next.markdown);
          setBase(next.markdown);
          setStatus("Reloaded external change");
        }).catch(() => setStatus("External change detected; reload failed"));
        return;
      }
      if (!source) return;
      reconcile(source.note.path, base, draft).then((result) => {
        if (result.status === "merged") {
          setDraft(result.markdown);
          setBase(result.remote_markdown);
          setSource((current) => current ? { ...current, note: { ...current.note, content_hash: result.remote_hash }, markdown: result.remote_markdown } : current);
          setStatus("Merged external changes; review and save");
        } else {
          setConflict({ remote: result.remote_markdown, hash: result.remote_hash, sections: result.conflicts });
          setStatus("Conflict requires review");
        }
      }).catch(() => setStatus("External change detected; reconciliation failed"));
    });
  }, [activeNotePath, base, draft, isDirty, source]);

  useEffect(() => {
    if (!source || !selectedRevision) {
      setDiff("");
      return;
    }
    getDiff(source.note.path, selectedRevision).then((result) => setDiff(result.diff)).catch(() => setDiff("Diff unavailable"));
  }, [source, selectedRevision]);

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

  async function save() {
    if (!source || !isDirty) return;
    setStatus("Saving...");
    try {
      await replaceNote(source.note.path, source.note.content_hash, draft);
      const next = await getNoteSource(source.note.path);
      setSource(next);
      setDraft(next.markdown);
      setBase(next.markdown);
      setStatus("Saved");
      setConflict(undefined);
    } catch (cause) {
      setStatus(cause instanceof Error ? cause.message : String(cause));
    }
  }

  function openPath(path: string) {
    setSelected(path);
    setPanel("context");
    navigate("notes");
  }

  function switchVault() {
    if (isDirty) {
      const discard = window.confirm("You have unsaved changes. Discard them and switch vaults?");
      if (!discard) return;
    }
    // Navigating back to the app's own origin returns to the Tauri shell's
    // vault picker; the sidecar for this vault is disposed there before the
    // next one starts (see "Desktop V2 Multi-Vault UX Contract", D2-09).
    window.location.href = "tauri://localhost/";
  }

  async function keepMine() {
    if (!source || !conflict) return;
    try {
      await replaceNote(source.note.path, conflict.hash, draft);
      const next = await getNoteSource(source.note.path);
      setSource(next);
      setDraft(next.markdown);
      setBase(next.markdown);
      setConflict(undefined);
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
      setSource(next);
      setDraft(next.markdown);
      setBase(next.markdown);
      setStatus("Restored " + selectedRevision.slice(0, 7));
    } catch (cause: unknown) {
      setStatus(cause instanceof Error ? cause.message : String(cause));
    }
  }

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <header className="flex h-[52px] shrink-0 items-center gap-4 border-b bg-card px-4">
        <div className="flex min-w-0 items-center gap-2">
          <span className="grid size-7 shrink-0 place-items-center rounded-md bg-primary text-sm font-bold text-primary-foreground">C</span>
          <div className="hidden leading-tight sm:block">
            <strong className="block text-sm font-semibold">Cortex</strong>
            <span className="block text-[10px] tracking-wide text-muted-foreground uppercase">Project notes</span>
          </div>
        </div>
        <nav className="flex items-center gap-1">
          <Button variant={route === "notes" ? "secondary" : "ghost"} size="sm" onClick={() => navigate("notes")}>
            <NotebookTextIcon />
            Notes
          </Button>
          <Button variant={route === "graph" ? "secondary" : "ghost"} size="sm" onClick={() => navigate("graph")}>
            <NetworkIcon />
            Graph
          </Button>
        </nav>
        <div className="ml-auto flex items-center gap-3">
          <Badge variant="outline" className="max-w-[200px] gap-1.5 text-muted-foreground">
            <span className={"size-1.5 rounded-full " + (isDirty ? "bg-foreground/60" : "bg-primary")} />
            <span className="truncate">{status}</span>
          </Badge>
          {route === "notes" && (
            <Button size="sm" onClick={() => void save()} disabled={!isDirty || !source}>
              Save
            </Button>
          )}
          {isTauri && (
            <Button variant="ghost" size="sm" onClick={switchVault}>
              Switch vault
            </Button>
          )}
          <ThemeToggle />
        </div>
      </header>

      {route === "graph" && (
        <section className="flex min-h-0 flex-1 flex-col bg-background">
          <GraphPane onOpenPath={openPath} />
        </section>
      )}

      {route === "notes" && (
        <SidebarProvider className="min-h-0 flex-1 [contain:layout]">
          <Sidebar collapsible="icon">
            <SidebarHeader className="gap-2.5">
              <SidebarMenu>
                <SidebarMenuItem>
                  <SidebarMenuButton size="lg" className="pointer-events-none">
                    <NotebookTextIcon />
                    <span className="font-medium group-data-[collapsible=icon]:hidden">All notes</span>
                    <Badge variant="secondary" className="ml-auto group-data-[collapsible=icon]:hidden">{notes.length}</Badge>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              </SidebarMenu>
              <SidebarInput
                placeholder="Search notes"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                className="group-data-[collapsible=icon]:hidden"
              />
            </SidebarHeader>
            <SidebarContent>
              {searchResults.length > 0 && (
                <SidebarGroup>
                  <SidebarGroupLabel>Search results</SidebarGroupLabel>
                  <SidebarMenu>
                    {searchResults.map((result) => (
                      <SidebarMenuItem key={result.path}>
                        <SidebarMenuButton size="lg" data-testid="search-result" onClick={() => openPath(result.path)}>
                          <FileTextIcon />
                          <div className="flex min-w-0 flex-col items-start gap-0.5 group-data-[collapsible=icon]:hidden">
                            <span className="truncate font-medium">{result.title}</span>
                            <span className="truncate text-[10px] text-muted-foreground">{result.snippet}</span>
                          </div>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    ))}
                  </SidebarMenu>
                </SidebarGroup>
              )}
              <SidebarGroup>
                <SidebarGroupLabel>Notes</SidebarGroupLabel>
                <SidebarMenu>
                  {visibleNotes.map((note) => (
                    <SidebarMenuItem key={note.path}>
                      <SidebarMenuButton
                        size="lg"
                        data-testid="note-row"
                        isActive={selected === note.path}
                        tooltip={note.title}
                        onClick={() => openPath(note.path)}
                      >
                        <FileTextIcon />
                        <div className="flex min-w-0 flex-col items-start gap-0.5 group-data-[collapsible=icon]:hidden">
                          <span className="truncate font-medium">{note.title}</span>
                          <span className="truncate text-[10px] text-muted-foreground">{note.path}</span>
                        </div>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  ))}
                </SidebarMenu>
              </SidebarGroup>
            </SidebarContent>
          </Sidebar>

          <SidebarInset data-testid="workspace" className="min-w-0">
            <SidebarProvider className="min-h-0 flex-1" defaultOpen>
              <div className="flex min-h-0 flex-1">
                <div className="flex min-w-0 flex-1 flex-col bg-background">
                  <div className="flex min-h-[64px] items-center justify-between gap-4 border-b px-5 py-3">
                    <div className="flex min-w-0 items-center gap-3">
                      <SidebarTrigger />
                      <div className="min-w-0">
                        <span className="block text-[10px] font-semibold tracking-wide text-primary uppercase">{source?.note.type ?? "note"}</span>
                        <h1 className="truncate text-base leading-tight font-semibold">{currentTitle}</h1>
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <Tabs value={mode} onValueChange={(value) => setMode(value as Mode)}>
                        <TabsList>
                          <TabsTrigger value="source">Source</TabsTrigger>
                          <TabsTrigger value="reading">Reading</TabsTrigger>
                        </TabsList>
                      </Tabs>
                      <ContextSidebarTrigger />
                    </div>
                  </div>
                  <div className="min-h-0 flex-1">
                    {source ? (
                      <Editor value={draft} mode={mode} onChange={setDraft} linkTargets={notes.map((note) => note.title)} notePath={activeNotePath} notes={notes} onOpenNote={openPath} />
                    ) : (
                      <Empty className="h-full">
                        <EmptyHeader>
                          <EmptyMedia variant="icon">
                            <FileTextIcon />
                          </EmptyMedia>
                          <EmptyTitle>Choose a note</EmptyTitle>
                          <EmptyDescription>The indexed Markdown workspace will appear here.</EmptyDescription>
                        </EmptyHeader>
                      </Empty>
                    )}
                  </div>
                  {conflict && (
                    <Alert variant="destructive" className="m-3 shrink-0">
                      <AlertTitle>External edit needs your decision</AlertTitle>
                      <AlertDescription>
                        <p>Conflicts: {conflict.sections.join(", ")}</p>
                        <div className="mt-2 flex gap-2">
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => { setDraft(conflict.remote); setBase(conflict.remote); setConflict(undefined); setStatus("Using external version"); }}
                          >
                            Take theirs
                          </Button>
                          <Button size="sm" variant="outline" onClick={() => void keepMine()}>
                            Keep mine
                          </Button>
                        </div>
                      </AlertDescription>
                    </Alert>
                  )}
                </div>

                <Sidebar side="right" collapsible="offcanvas">
                  <SidebarHeader>
                    <Tabs value={panel} onValueChange={(value) => setPanel(value as Panel)}>
                      <TabsList className="w-full">
                        <TabsTrigger value="context" className="flex-1">Context</TabsTrigger>
                        <TabsTrigger value="git" className="flex-1">Git</TabsTrigger>
                      </TabsList>
                    </Tabs>
                  </SidebarHeader>
                  <SidebarContent>
                    {panel === "context" && (
                      <>
                        <SidebarGroup>
                          <SidebarGroupLabel>Path</SidebarGroupLabel>
                          <code className="block px-2 pb-1 font-mono text-[11px] break-words text-foreground">{source?.note.path ?? "No note selected"}</code>
                        </SidebarGroup>
                        <SidebarSeparator />
                        <SidebarGroup>
                          <SidebarGroupLabel>Sections</SidebarGroupLabel>
                          <div className="px-2 pb-1">
                            <strong className="text-2xl">{source?.sections.length ?? 0}</strong>
                            <p className="text-[11px] leading-normal text-muted-foreground">Marked sections available for focused agent patches.</p>
                          </div>
                        </SidebarGroup>
                        <SidebarSeparator />
                        <SidebarGroup>
                          <SidebarGroupLabel>Diagnostics</SidebarGroupLabel>
                          <div className="grid gap-1.5 px-2 pb-1">
                            {source?.diagnostics.length ? (
                              source.diagnostics.map((item, index) => (
                                <Alert key={item.code + index} variant="destructive">
                                  <AlertDescription>{item.severity}: {item.message}</AlertDescription>
                                </Alert>
                              ))
                            ) : (
                              <p className="text-[11px] leading-normal text-muted-foreground">No note diagnostics.</p>
                            )}
                          </div>
                        </SidebarGroup>
                        <SidebarSeparator />
                        <SidebarGroup>
                          <SidebarGroupLabel>Related notes</SidebarGroupLabel>
                          {context?.attached_notes?.length ? (
                            <SidebarMenu>
                              {context.attached_notes.map((node) => (
                                <SidebarMenuItem key={node.nodeId}>
                                  <SidebarMenuButton disabled={!node.path} onClick={() => node.path && openPath(node.path)}>
                                    <span className="truncate">{node.name}</span>
                                  </SidebarMenuButton>
                                </SidebarMenuItem>
                              ))}
                            </SidebarMenu>
                          ) : (
                            <p className="px-2 text-[11px] leading-normal text-muted-foreground">No attached notes in the bounded neighborhood.</p>
                          )}
                        </SidebarGroup>
                      </>
                    )}
                    {panel === "git" && (
                      !source ? (
                        <Empty className="h-full">
                          <EmptyHeader>
                            <EmptyMedia variant="icon">
                              <HistoryIcon />
                            </EmptyMedia>
                            <EmptyDescription>Select a note to inspect its Git history and diff.</EmptyDescription>
                          </EmptyHeader>
                        </Empty>
                      ) : (
                        <>
                          <SidebarGroup>
                            <div className="flex items-center justify-between">
                              <SidebarGroupLabel className="px-0">History</SidebarGroupLabel>
                              <Button size="icon-sm" variant="ghost" disabled={!selectedRevision} onClick={() => void restoreSelected()}>
                                <RotateCcwIcon />
                                <span className="sr-only">Restore</span>
                              </Button>
                            </div>
                            <SidebarMenu>
                              {history?.commits.length ? (
                                history.commits.map((commit) => (
                                  <SidebarMenuItem key={commit.hash}>
                                    <SidebarMenuButton
                                      size="lg"
                                      isActive={selectedRevision === commit.hash}
                                      onClick={() => setSelectedRevision(commit.hash)}
                                    >
                                      <div className="flex min-w-0 flex-col items-start gap-0.5">
                                        <span className="truncate font-medium">{commit.subject}</span>
                                        <span className="truncate text-[10px] text-muted-foreground">{commit.hash.slice(0, 8)} · {new Date(commit.date).toLocaleDateString()}</span>
                                      </div>
                                    </SidebarMenuButton>
                                  </SidebarMenuItem>
                                ))
                              ) : (
                                <p className="px-2 text-[10px] text-muted-foreground">No committed history for this note.</p>
                              )}
                            </SidebarMenu>
                          </SidebarGroup>
                          <SidebarSeparator />
                          <SidebarGroup>
                            <SidebarGroupLabel>Diff</SidebarGroupLabel>
                            <ScrollArea className="mx-2 mb-2 max-h-[280px] rounded-md border bg-muted/40">
                              <pre className="p-2.5 font-mono text-[10px] leading-relaxed break-words whitespace-pre-wrap text-foreground">{diff || "Select a revision"}</pre>
                            </ScrollArea>
                          </SidebarGroup>
                        </>
                      )
                    )}
                  </SidebarContent>
                </Sidebar>
              </div>
            </SidebarProvider>
          </SidebarInset>
        </SidebarProvider>
      )}
    </div>
  );
}

export default App;
