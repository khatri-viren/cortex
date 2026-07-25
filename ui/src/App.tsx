import { useEffect, useMemo, useState } from "react";
import type { ApiContext, ApiHistory, ApiNoteSource } from "../../src/api/contracts";
import { Editor } from "./Editor";
import { GraphPane } from "./GraphPane";
import { getContext, getDiff, getHistory, getNoteSource, listNotes, reconcile, replaceNote, restoreNote, searchNotes, subscribeToChanges, type NoteSummary } from "./api";

type Mode = "source" | "reading";
type Panel = "context" | "graph" | "git";

function App() {
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
    <main className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">C</span>
          <div><strong>Cortex</strong><span>project notes</span></div>
        </div>
        <div className="topbar-status"><span className={isDirty ? "status-dot dirty" : "status-dot"} />{status}</div>
        <button className="primary-button" onClick={() => void save()} disabled={!isDirty || !source}>Save</button>
      </header>

      <section className="workspace">
        <aside className="sidebar">
          <div className="sidebar-heading"><span>Notes</span><span className="count">{notes.length}</span></div>
          <label className="search-box"><span>Search</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Title or path" /></label>
          {searchResults.length > 0 && (
            <div className="search-results">
              {searchResults.map((result) => <button key={result.path} className="search-result" onClick={() => openPath(result.path)}><strong>{result.title}</strong><small>{result.snippet}</small></button>)}
            </div>
          )}
          <div className="note-list">
            {visibleNotes.map((note) => <button key={note.path} className={"note-row " + (selected === note.path ? "selected" : "")} onClick={() => openPath(note.path)}><span>{note.title}</span><small>{note.path}</small></button>)}
          </div>
        </aside>

        <section className="editor-column">
          <div className="editor-toolbar">
            <div><span className="eyebrow">{source?.note.type ?? "note"}</span><h1>{currentTitle}</h1></div>
            <div className="mode-switch"><button className={mode === "source" ? "active" : ""} onClick={() => setMode("source")}>Source</button><button className={mode === "reading" ? "active" : ""} onClick={() => setMode("reading")}>Reading</button></div>
          </div>
          <div className="editor-frame">{source ? <Editor value={draft} mode={mode} onChange={setDraft} linkTargets={notes.map((note) => note.title)} /> : <div className="empty-state"><strong>Choose a note</strong><span>The indexed Markdown workspace will appear here.</span></div>}</div>
          {conflict && <div className="conflict-banner"><div><strong>External edit needs your decision</strong><span>Conflicts: {conflict.sections.join(", ")}</span></div><div className="conflict-actions"><button onClick={() => { setDraft(conflict.remote); setBase(conflict.remote); setConflict(undefined); setStatus("Using external version"); }}>Take theirs</button><button onClick={() => { void keepMine(); }}>Keep mine</button></div></div>}
        </section>

        <aside className="context-panel">
          <div className="panel-tabs"><button className={panel === "context" ? "active" : ""} onClick={() => setPanel("context")}>Context</button><button className={panel === "graph" ? "active" : ""} onClick={() => setPanel("graph")}>Graph</button><button className={panel === "git" ? "active" : ""} onClick={() => setPanel("git")}>Git</button></div>
          {panel === "context" && <div className="context-content"><section><span className="eyebrow">Path</span><code>{source?.note.path ?? "No note selected"}</code></section><section><span className="eyebrow">Sections</span><strong>{source?.sections.length ?? 0}</strong><small>Marked sections available for focused agent patches.</small></section><section><span className="eyebrow">Diagnostics</span>{source?.diagnostics.length ? source.diagnostics.map((item, index) => <p className="diagnostic" key={item.code + index}>{item.severity}: {item.message}</p>) : <small>No note diagnostics.</small>}</section><section><span className="eyebrow">Related Notes</span>{context?.attached_notes?.length ? context.attached_notes.map((node) => <button className="related-note" key={node.nodeId} onClick={() => node.path && openPath(node.path)}>{node.name}</button>) : <small>No attached notes in the bounded neighborhood.</small>}</section></div>}
          {panel === "graph" && <GraphPane onOpenPath={openPath} />}
          {panel === "git" && <div className="git-panel">{!source ? <div className="panel-message">Select a note to inspect its Git history and diff.</div> : <><div className="git-heading"><span className="eyebrow">History</span><button className="quiet-button" disabled={!selectedRevision} onClick={() => void restoreSelected()}>Restore</button></div><div className="commit-list">{history?.commits.length ? history.commits.map((commit) => <button key={commit.hash} className={selectedRevision === commit.hash ? "commit-row selected" : "commit-row"} onClick={() => setSelectedRevision(commit.hash)}><strong>{commit.subject}</strong><small>{commit.hash.slice(0, 8)} · {new Date(commit.date).toLocaleDateString()}</small></button>) : <small className="panel-padding">No committed history for this note.</small>}</div><div className="diff-panel"><span className="eyebrow">Diff</span><pre>{diff || "Select a revision"}</pre></div></>}</div>}
        </aside>
      </section>
    </main>
  );
}

export default App;
