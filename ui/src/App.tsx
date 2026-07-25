import { useEffect, useMemo, useState } from "react";
import type { ApiContext, ApiHistory, ApiNoteSource } from "../../src/api/contracts";
import { Editor } from "./Editor";
import { GraphPane } from "./GraphPane";
import { getContext, getDiff, getHistory, getNoteSource, listNotes, reconcile, replaceNote, restoreNote, searchNotes, subscribeToChanges, type NoteSummary } from "./api";

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

function App() {
  const [route, navigate] = useRoute();
  const [notes, setNotes] = useState<NoteSummary[]>([]);
  const [selected, setSelected] = useState<string>();
  const [source, setSource] = useState<ApiNoteSource>();
  const [draft, setDraft] = useState("");
  const [base, setBase] = useState("");
  const [mode, setMode] = useState<Mode>("source");
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
    listNotes().then((result) => {
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
    <main className="flex min-h-screen flex-col">
      <header className="flex h-[58px] items-center gap-5 border-b border-line bg-surface px-[18px] max-[700px]:px-3">
        <div className="flex min-w-[190px] items-center gap-2.5 max-[700px]:min-w-0">
          <span className="grid size-7 place-items-center rounded-[7px] bg-brand font-extrabold text-white">C</span>
          <div className="max-[700px]:hidden">
            <strong className="block text-sm font-bold tracking-[0.02em]">Cortex</strong>
            <span className="block text-[10px] tracking-[0.12em] text-muted uppercase">project notes</span>
          </div>
        </div>
        <nav className="flex gap-0.5">
          <button className={"cursor-pointer border-b-2 px-3 pt-[18px] pb-4 text-xs hover:text-ink " + (route === "notes" ? "border-b-brand font-bold text-ink" : "border-b-transparent text-muted")} onClick={() => navigate("notes")}>Notes</button>
          <button className={"cursor-pointer border-b-2 px-3 pt-[18px] pb-4 text-xs hover:text-ink " + (route === "graph" ? "border-b-brand font-bold text-ink" : "border-b-transparent text-muted")} onClick={() => navigate("graph")}>Graph</button>
        </nav>
        <div className="ml-auto flex items-center gap-2 text-xs text-muted max-[700px]:max-w-[140px] max-[700px]:truncate"><span className={"size-[7px] rounded-full " + (isDirty ? "bg-accent" : "bg-brand")} />{status}</div>
        {route === "notes" && <button className="cursor-pointer rounded border border-brand bg-brand px-[13px] py-[7px] text-xs text-white disabled:cursor-default disabled:opacity-45" onClick={() => void save()} disabled={!isDirty || !source}>Save</button>}
      </header>

      {route === "graph" && <section className="flex h-[calc(100vh-58px)] min-h-0 flex-col bg-surface"><GraphPane onOpenPath={openPath} /></section>}

      {route === "notes" && <section data-testid="workspace" className="grid min-h-[calc(100vh-58px)] grid-cols-[240px_minmax(0,1fr)_320px] max-[1100px]:grid-cols-[210px_minmax(0,1fr)] max-[700px]:flex max-[700px]:flex-col">
        <aside className="min-w-0 border-r border-line bg-surface px-3 py-[18px] max-[700px]:max-h-[270px] max-[700px]:overflow-auto max-[700px]:border-r-0 max-[700px]:border-b">
          <div className="flex justify-between px-1.5 pb-3 text-[11px] font-extrabold tracking-[0.12em] text-muted uppercase"><span>Notes</span><span className="text-brand">{notes.length}</span></div>
          <label className="mb-3.5 block"><span className="mx-1.5 mb-[5px] block text-[11px] text-muted">Search</span><input className="w-full rounded border border-line bg-paper px-[9px] py-2 text-xs text-ink outline-none focus:border-brand focus:ring-2 focus:ring-brand-soft" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Title or path" /></label>
          {searchResults.length > 0 && (
            <div className="mb-2 grid gap-0.5 border-b border-line pb-2.5">
              {searchResults.map((result) => <button key={result.path} data-testid="search-result" className="cursor-pointer rounded px-2 py-[9px] text-left hover:bg-surface-muted" onClick={() => openPath(result.path)}><strong className="block truncate text-xs font-[650]">{result.title}</strong><small className="mt-[3px] block truncate text-[10px] text-muted">{result.snippet}</small></button>)}
            </div>
          )}
          <div className="grid gap-0.5">
            {visibleNotes.map((note) => <button key={note.path} data-testid="note-row" className={"cursor-pointer rounded px-2 py-[9px] text-left " + (selected === note.path ? "bg-brand-soft" : "hover:bg-surface-muted")} onClick={() => openPath(note.path)}><span className="block truncate text-xs font-[650]">{note.title}</span><small className="mt-[3px] block truncate text-[10px] text-muted">{note.path}</small></button>)}
          </div>
        </aside>

        <section className="flex min-w-0 flex-col bg-surface">
          <div className="flex min-h-[82px] items-center justify-between gap-4 border-b border-line px-6 py-4 max-[700px]:px-4 max-[700px]:py-3.5">
            <div><span className="block text-[10px] font-extrabold tracking-[0.12em] text-brand uppercase">{source?.note.type ?? "note"}</span><h1 className="mt-1 text-[19px] leading-tight font-bold">{currentTitle}</h1></div>
            <div className="flex gap-0.5">
              <button className={"cursor-pointer border-b-2 px-[9px] py-2 text-[11px] hover:text-ink " + (mode === "source" ? "border-b-brand font-bold text-ink" : "border-b-transparent text-muted")} onClick={() => setMode("source")}>Source</button>
              <button className={"cursor-pointer border-b-2 px-[9px] py-2 text-[11px] hover:text-ink " + (mode === "reading" ? "border-b-brand font-bold text-ink" : "border-b-transparent text-muted")} onClick={() => setMode("reading")}>Reading</button>
            </div>
          </div>
          <div className="min-h-0 flex-1">{source ? <Editor value={draft} mode={mode} onChange={setDraft} linkTargets={notes.map((note) => note.title)} /> : <div className="grid h-full min-h-[300px] content-center place-items-center gap-1.5 p-6 text-center text-muted"><strong className="text-ink">Choose a note</strong><span className="text-xs">The indexed Markdown workspace will appear here.</span></div>}</div>
          {conflict && <div className="flex items-center justify-between gap-4 border-t border-accent-line bg-accent-soft px-[18px] py-3 text-accent-ink max-[700px]:flex-col max-[700px]:items-start"><div><strong className="block">External edit needs your decision</strong><span className="mt-1 block text-[11px]">Conflicts: {conflict.sections.join(", ")}</span></div><div className="flex gap-[7px]"><button className="cursor-pointer rounded border border-[#a76a1e] px-[13px] py-[7px] text-xs text-[#7b4e12]" onClick={() => { setDraft(conflict.remote); setBase(conflict.remote); setConflict(undefined); setStatus("Using external version"); }}>Take theirs</button><button className="cursor-pointer rounded border border-[#a76a1e] px-[13px] py-[7px] text-xs text-[#7b4e12]" onClick={() => { void keepMine(); }}>Keep mine</button></div></div>}
        </section>

        <aside className="flex min-h-0 min-w-0 flex-col border-l border-line bg-surface max-[1100px]:col-span-full max-[1100px]:min-h-[260px] max-[1100px]:border-t max-[1100px]:border-l-0">
          <div className="flex gap-0.5 border-b border-line px-3 pt-3">
            <button className={"cursor-pointer border-b-2 px-[9px] py-2 text-[11px] hover:text-ink " + (panel === "context" ? "border-b-brand font-bold text-ink" : "border-b-transparent text-muted")} onClick={() => setPanel("context")}>Context</button>
            <button className={"cursor-pointer border-b-2 px-[9px] py-2 text-[11px] hover:text-ink " + (panel === "git" ? "border-b-brand font-bold text-ink" : "border-b-transparent text-muted")} onClick={() => setPanel("git")}>Git</button>
          </div>
          {panel === "context" && <div className="grid gap-px overflow-auto"><section className="grid gap-[7px] border-b border-line p-4"><span className="block text-[10px] font-extrabold tracking-[0.12em] text-brand uppercase">Path</span><code className="font-mono text-[11px] break-words text-ink">{source?.note.path ?? "No note selected"}</code></section><section className="grid gap-[7px] border-b border-line p-4"><span className="block text-[10px] font-extrabold tracking-[0.12em] text-brand uppercase">Sections</span><strong className="text-2xl">{source?.sections.length ?? 0}</strong><small className="text-[11px] leading-normal text-muted">Marked sections available for focused agent patches.</small></section><section className="grid gap-[7px] border-b border-line p-4"><span className="block text-[10px] font-extrabold tracking-[0.12em] text-brand uppercase">Diagnostics</span>{source?.diagnostics.length ? source.diagnostics.map((item, index) => <p className="m-0 text-[11px] leading-[1.45] text-danger" key={item.code + index}>{item.severity}: {item.message}</p>) : <small className="text-[11px] leading-normal text-muted">No note diagnostics.</small>}</section><section className="grid gap-[7px] border-b border-line p-4"><span className="block text-[10px] font-extrabold tracking-[0.12em] text-brand uppercase">Related Notes</span>{context?.attached_notes?.length ? context.attached_notes.map((node) => <button className="cursor-pointer border-b border-line py-[7px] text-left text-xs text-brand" key={node.nodeId} onClick={() => node.path && openPath(node.path)}>{node.name}</button>) : <small className="text-[11px] leading-normal text-muted">No attached notes in the bounded neighborhood.</small>}</section></div>}
          {panel === "git" && <div className="min-h-0 overflow-auto">{!source ? <div className="grid h-full min-h-[300px] content-center place-items-center gap-1.5 p-6 text-center text-muted">Select a note to inspect its Git history and diff.</div> : <><div className="flex items-center justify-between border-b border-line p-4"><span className="block text-[10px] font-extrabold tracking-[0.12em] text-brand uppercase">History</span><button className="cursor-pointer rounded border border-line bg-surface px-[9px] py-1.5 text-[11px] text-ink disabled:cursor-default disabled:opacity-45" disabled={!selectedRevision} onClick={() => void restoreSelected()}>Restore</button></div><div className="grid gap-px border-b border-line">{history?.commits.length ? history.commits.map((commit) => <button key={commit.hash} className={"grid cursor-pointer gap-1 border-l-[3px] px-3.5 py-2.5 text-left " + (selectedRevision === commit.hash ? "border-l-brand bg-surface-muted" : "border-l-transparent bg-surface hover:border-l-brand hover:bg-surface-muted")} onClick={() => setSelectedRevision(commit.hash)}><strong className="truncate text-[11px]">{commit.subject}</strong><small className="text-[10px] text-muted">{commit.hash.slice(0, 8)} · {new Date(commit.date).toLocaleDateString()}</small></button>) : <small className="block p-4 text-[10px] text-muted">No committed history for this note.</small>}</div><div className="p-4"><span className="block text-[10px] font-extrabold tracking-[0.12em] text-brand uppercase">Diff</span><pre className="mt-2.5 max-h-[280px] overflow-auto border border-line bg-[#f8faf9] p-2.5 font-mono text-[10px] leading-relaxed break-words whitespace-pre-wrap text-ink">{diff || "Select a revision"}</pre></div></>}</div>}
        </aside>
      </section>}
    </main>
  );
}

export default App;
