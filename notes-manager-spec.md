# Agent-Native Markdown Notes Manager — Development Spec

> A local-first, performance-first, version-controlled notes system.
> Markdown files are the source of truth. Humans edit and read through an
> Obsidian-like surface; agents (Claude Code and others) read and write the
> same files through MCP, guided by skills and hooks.

**Status:** design locked, pre-implementation
**Owner:** Viren
**Last updated:** 2026-07-22

---

## 1. Vision

A notes manager that doubles as a living memory/guide for coding agents. Today the
loop is: agent writes docs into a folder → human copies to Notion for readable UI →
agent edits → recopy. The docs that exist never get read by the agent, so it
re-explores the codebase on every task, burning time and tokens.

This system removes the copy step, keeps everything as plain markdown under version
control, gives humans a fast Obsidian-style editor/reader, and — most importantly —
makes agents actually consult and update a high-level map so they stop re-exploring.

The central bet: **the hard problem is freshness, not storage or rendering.** Stale
notes get distrusted and ignored, which defeats the purpose. So the index is always
*derived* from the files (never a separate source of truth), and the agent's
read-before / update-after discipline is enforced deterministically via hooks, not
left to the model to remember.

---

## 2. Goals

- Markdown files on disk are the single source of truth; everything else is a
  rebuildable projection over them.
- Minimize agent round-trips: structured, token-efficient queries instead of
  grep + read-whole-file exploration.
- Fast, beautiful reading and editing for humans (Obsidian-like).
- Crosslinking, backlinks, and queryable tables — without giving up plain-MD base data.
- A queryable project map showing what lives where, what it does, and which notes explain it.
- Native Claude Code integration via MCP + skills + hooks + plugin.
- Guaranteed freshness: index always current, agent discipline enforced by hooks.
- Lean and performance-first above all else.

## 3. Non-Goals (explicit)

These are deliberately excluded to protect leanness. Revisit only against a concrete need.

- **No cloud / hosted web app** in v1. Local-first only. (Localhost-web for iteration
  was considered and dropped; going straight to local.)
- **No real-time multi-user collaboration.** Single user.
- **No CRDT** (no Yjs) until concurrent same-file editing is a proven, frequent need.
- **No block-tree editor** (no BlockSuite / Notion model). Markdown is the document,
  not a lossy export of blocks.
- **No Electron.** Native shell is Tauri if/when a desktop wrapper is wanted.
- **No lifting AFFiNE code.** Take ideas (local-first stance, block model as a mental
  model), not its coupled 60+-package editor, Yjs layer, or OctoBase engine.

---

## 4. Design Principles

1. **The fastest system does the least.** Every excluded feature (collab, whiteboard,
   plugins-for-humans, block model) is weight avoided.
2. **MD is truth; SQLite is a cache.** Delete the DB, regenerate from files, lose nothing.
   This is also the freshness guarantee.
3. **Two hot paths, optimize only these:**
   - Agent query latency + token cost.
   - Human open / render / edit latency.
4. **Single-user local-first.** No network, no auth, no sync in v1.
5. **Determinism over hope.** Freshness and agent discipline are wired with hooks, not
   suggested in prose the model can skip.

---

## 5. Architecture

```
        ┌───────────────┐                         ┌───────────────┐
        │ CodeMirror 6  │ ── read / write ──┐  ┌── │  MCP server   │  (agent side:
        │ reading·live· │                   │  │   │ read · write  │   Claude Code)
        │   source      │                   ▼  ▼   └───────┬───────┘
        └───────────────┘             ┌───────────────┐    │
              (human)                 │ Markdown files │    │ fast queries
                                      │ source of truth│    │ (slices, graph)
                                      └───────┬────────┘    │
                                              │             │
                                              ▼             │
                                      ┌───────────────┐     │
                                      │Watcher+indexer│     │
                                      │ incremental   │     │
                                      └───────┬───────┘     │
                                              ▼             │
                                      ┌───────────────┐     │
                                      │ SQLite index  │◄────┘
                                      │FTS·graph·tables│
                                      └───────────────┘
```

**Two writers, one source of truth.** The human (via CM6) and the agent (via MCP)
both write the same `.md` files. The files feed an incremental indexer into SQLite,
which serves fast queries back to the MCP server (and backlink/search to the editor).

---

## 6. Components

### 6.1 Storage — source of truth
- Plain `.md` files in a folder that is itself a git repo.
- Git is the local versioning layer for markdown, frontmatter, and note assets.
- The SQLite index is disposable and is never committed to the vault repository.
- Create meaningful checkpoints manually by default; optional automatic checkpoints
  may run after an agent task, but never on every editor save.
- YAML frontmatter for metadata (id, title, aliases, tags, type, timestamps, and
  optional `applies_to` repository targets).
- `id` is an immutable UUID generated by the backend at note creation. `created_at` is
  immutable; `updated_at` is backend-managed on accepted app/MCP writes. Files edited
  directly on disk use filesystem mtime for freshness until the backend normalizes them.
- `.gitignore` excludes the SQLite index, logs, locks, and other rebuildable runtime data.
- Wikilinks `[[Note Title]]` for crosslinks (Obsidian-compatible).
- "Database" notes (tables/structured data) are still markdown; the indexer extracts
  their rows into queryable SQLite tables.

### 6.2 Indexer
- Fast markdown parser, run incrementally on file-change events.
- **Default (Bun/TypeScript):** `remark`/unified or `markdown-it` for parsing, with
  the indexer running in the same Bun backend process.
- **Performance ceiling option (Rust):** `comrak` or `pulldown-cmark` for parsing,
  `tree-sitter-markdown` for structural queries; expose via CLI or NAPI.
- Decision: start in Bun/TypeScript for speed of implementation and shared language
  with the UI. Only add Rust for parsing if indexing a large vault visibly lags.
- Extracts: note metadata, heading/section structure, links (edges), table rows, full text.
- Section writes use explicit Markdown markers such as
  `<!-- cortex:section id="sec-..." -->`. The indexer never silently injects markers;
  note creation and an explicit migration command may add them. `get_note` returns
  section IDs, and `patch_section` requires one. Heading-path fallback is read-only
  when unique and rejected when ambiguous.
- Also derives a project graph from the repository: project, directory, file, module,
  test, and configuration nodes with `contains`, `imports`, and `tested_by` edges.
- Start with filesystem and manifest/import relationships. Add symbol-level parsing
  later where a language parser is available; runtime behavior is out of scope for v1.
- Note IDs are stable UUIDs. Code nodes use canonical repository-relative addresses;
  Git rename detection attempts to rebind path targets, and ambiguous or undetected
  moves remain visible as unresolved targets for repair.

### 6.3 SQLite index (rebuildable projection)
- Full-text search via **FTS5**.
- Link graph as an **edge table**; traverse backlinks / neighbors / graph with recursive CTEs.
- Store project and note nodes in the same graph projection, with typed edges such as
  `documents`, `owns`, `implements`, `depends_on`, and `related_to`.
- Notes attach to repository entities through optional frontmatter targets, for example
  `src/search/index.ts` or `src/search/index.ts#SearchIndex`.
- When a note title changes, retain the previous title in `aliases` or update its
  wikilinks through an explicit rename operation so title-based links do not break silently.
- The graph is derived from files and notes; it is never an independently edited database.
- Deleted or renamed targets are retained as unresolved link/attachment records rather
  than disappearing silently. A `vault_check` diagnostic reports unresolved wikilinks,
  attachments, duplicate section IDs, and malformed frontmatter.
- Table-notes extracted into real rows for querying.
- Optional later: **sqlite-vec** for semantic search.
- Always derivable from files → never the source of truth → cannot rot.

### 6.4 MCP server (agent interface)
- Primary agent surface. Returns **structured slices, not file dumps** — this is the
  entire token win vs. Claude Code reading/grepping files directly.
- Phase 2 ships a per-vault stdio server implemented with the stable v1 TypeScript MCP
  SDK. Localhost HTTP remains deferred until the UI needs a shared endpoint.
- Tool surface (input → output shapes in §8). Responses are bounded and return stable
  structured error codes rather than arbitrary exceptions.

### 6.5 Editor (human interface)
- **CodeMirror 6** — the same foundation Obsidian uses.
- Obsidian-style live preview: raw markdown stays the source of truth; decorations are
  view-only; save/copy/round-trip are byte-for-byte identical to plain markdown.
- Three modes from one component: **reading** (readOnly), **live** (syntax on active
  line only), **source** (raw).
- Live preview is deceptively hard (cursor-jump bugs). **Fork an existing extraction**
  rather than hand-rolling decorations:
  - `atomic-editor` (`@atomic-editor/editor`, React, hardened, has readOnly reading mode) — first to evaluate.
  - `codemirror-live-markdown` (modular, framework-agnostic).
  - `codemirror-rich-obsidian`.
- Before Phase 3, run a timeboxed spike against all three candidates using a stress
  document with long sections, nested lists, tables, wikilinks, and unsaved edits.
  If none is forkable without cursor-jump or serialization problems, ship CM6 source
  and read-only modes first and defer live preview behind a separate milestone.
- Wikilink autocomplete + backlinks powered by the SQLite index.
- **Do NOT** use ProseMirror / TipTap / Lexical — those serialize markdown in/out (the
  Notion path, reintroduces lossy projection); CM6 is also virtualized for long docs.

### 6.6 Reader
- Collapse into the CM6 `readOnly` reading mode initially — one surface, no separate renderer.
- Add a dedicated MD→HTML render path later **only if** CM6 reading polish (KaTeX,
  Mermaid, heavy CSS) is insufficient.

### 6.7 Backend process
- A single local **Bun** process that owns the files, the SQLite index, and the
  watcher, and exposes **two faces of the same core**:
  - MCP stdio for agents in Phase 2; localhost can be added later when the UI needs a
    shared endpoint.
  - A local API for the CM6 UI.
- Use Bun-native primitives where they keep the system lean:
  - `bun:sqlite` for the rebuildable SQLite index.
  - `Bun.serve` for the local UI/API surface if HTTP is needed.
  - TypeScript as the backend language, run directly by Bun.
- Keeping one shared core behind two interfaces is what keeps the human and agent sides
  consistent.
- Existing-note agent writes support section-scoped `patch_section` and optimistic full
  Markdown replacement through `replace_note`. Full replacement requires the expected
  file hash, preserves `id` and `created_at`, permits ordinary metadata edits, and lets
  the backend manage `updated_at`. `create_note` may write a new file.

### 6.8 Desktop shell (deferred)
- **Tauri** (Rust core + OS native webview) when a packaged desktop app is wanted.
- Biggest leanness win over AFFiNE: no bundled Chromium.

### 6.9 Git versioning
- Treat the vault's Git repository as the durable history for source files.
- The UI should provide note-level history, diffs, and restore from a selected commit.
- Restoring a note writes the markdown file and triggers the normal watcher/reindex path.
- External checkout, restore, or branch changes are treated as external file changes.
- Keep v1 on a single branch; do not add merge or collaboration workflows yet.
- Use Git rename information as a best-effort aid for rebinding path-based code targets;
  unresolved targets remain diagnosable rather than being silently retargeted.

---

## 7. Concurrency — two-writer reconciliation

Obsidian assumes the human is the only writer. Here an agent co-writes the same files,
so disk-change handling matters more. **No CRDT required for single-user.**

- **Write-back loop:** editor/agent save → watcher fires → incremental reindex.
  Debounce writes; keep reindex incremental so it's invisible.
- **Ignore own writes:** editor checks mtime/hash so its own save doesn't trigger a
  jarring buffer reload.
- **External change to an open file:**
  - No unsaved local edits → hot-reload the buffer.
  - Human and agent changed different section IDs → merge automatically and reindex.
  - The same section changed → show a conflict banner with `keep mine`, `take theirs`,
    and `view diff`; never silently discard either version.
- `patch_section` includes the section's expected content hash/revision, so stale agent
  writes are rejected as conflicts instead of overwriting newer human edits.
- `replace_note` includes the expected full-file SHA-256 hash and applies the same
  optimistic conflict rule. Backend writes are atomic and synchronously trigger an
  incremental reindex; watcher delivery remains the recovery path for external edits.
- **CRDT (Yjs on the text buffer)** only if human + agent routinely edit the *same file
  at the same moment* — rare in this workflow; don't pay for it upfront.

---

## 8. MCP tool surface (Phase 2)

Return bounded slices, keep responses in the hundreds of tokens where practical, and
cap server-side limits. Phase 2 uses a per-vault stdio process; stdout is reserved for
MCP protocol traffic and logs go to stderr.

| Tool | Input | Output |
|---|---|---|
| `get_note` | note id/path | frontmatter + section outline (not full body) |
| `get_section` | note id + section ID/heading | just that section's text + revision |
| `patch_section` | note id + section ID + expected revision + new content | success, conflict, or new mtime |
| `replace_note` | note id/path + expected file hash + complete Markdown | success, conflict, or new mtime |
| `search` | query, limit | FTS5 hits with note + snippet |
| `project_map` | path or node id, depth, limit | relevant files, modules, notes, and relationships |
| `graph_query` | node id/path, direction (in/out/neighbors), depth | linked code and note nodes with edge types |
| `get_context` | node id/path, task hint, limit | compact purpose, dependencies, attached notes, and likely files |
| `query_table` | table-note id + filter | matching rows |
| `list_notes` | optional prefix/tag filter | note ids + titles |
| `create_note` | title, frontmatter, body, optional vault-relative path | new note id/path |
| `get_history` | note id/path, limit | commits affecting the note |
| `get_diff` | note id/path, commit or revision | markdown diff |
| `restore_note` | note id/path, commit or revision | restored path + new mtime |
| `vault_check` | optional scope | unresolved links/targets, duplicate anchors, malformed metadata |

`create_note` defaults to a slugged path under `notes/`; an explicit relative `.md` path
is allowed when it remains inside the vault and outside runtime or Git metadata. All
write tools validate frontmatter, use atomic same-directory replacement, serialize
writes per vault, and synchronously reindex the changed path.

`replace_note` requires the existing UUID and `created_at` to remain unchanged. Title,
type, aliases, tags, and `applies_to` may change; `updated_at` is rewritten by the
backend. Stale section revisions or file hashes return a conflict without modifying
the source file.

---

## 9. Claude Code integration (deferred after Phase 2)

Division of labor (when this integration milestone is implemented): CLAUDE.md = always-on context; skills = on-demand
knowledge/workflows; MCP = external connections; hooks = automation/guarantees;
plugins = packaging.

- Phase 2 deliberately stops at the MCP server and its protocol tests. It does not add
  Claude configuration, skills, hooks, or plugin packaging. Those become a follow-up
  Phase 2b/3 integration milestone.
- **MCP registration** — when integration begins, register the per-vault server with
  `claude mcp add notes -- <command>`. Use HTTP only when a shared localhost endpoint
  is needed.
- **CLAUDE.md** — short, always-loaded pointer + hard rules: "notes system exposed via
  `notes` MCP; query it before exploring; update the relevant note after meaningful
  changes." Keep procedures OUT of here (context budget).
- **Skill** (`.claude/skills/notes/SKILL.md`) — the detailed protocol: which note to
  read, read-before/update-after steps, wikilink + frontmatter conventions, create-vs-append.
  Loaded on demand; portable across Claude apps + API.
- **Hooks** — the guarantee layer (fixes "the agent never reads the docs"):
  - `SessionStart` → inject a configurable 500–800 token high-level map/state summary;
    if it exceeds the budget, inject a compact index of project areas and direct the
    agent to `project_map`/`get_context` for detail.
  - `PostToolUse` on Write/Edit → run incremental reindexer (keeps SQLite fresh).
  - `UserPromptSubmit` → inject notes relevant to the prompt.
- The notes skill should instruct agents to prefer section-scoped writes and use
  `replace_note` only with a fresh file hash and complete validated Markdown.
- **Plugin** — bundle MCP + skill + hooks into one installable, namespaced unit so it
  drops into any repo and can be distributed.

Reminder: exact hook event names, config schema, and `claude mcp add` flags move fast —
verify against code.claude.com/docs at build time.

---

## 10. Tech stack (proposed)

- **Source of truth:** markdown files + YAML frontmatter, in a git repo.
- **Backend:** single local Bun process, written in TypeScript.
- **Local API:** `Bun.serve` if the CM6 UI needs HTTP; Phase 2 MCP is per-vault stdio.
- **Parser/indexer:** TypeScript (`remark`/unified or `markdown-it`) first; optional Rust
  parser (`comrak`/`pulldown-cmark` + `tree-sitter-markdown`) only if profiling proves
  the need.
- **Index:** SQLite + FTS5 via `bun:sqlite` (+ sqlite-vec later).
- **Editor/reader:** CodeMirror 6 (fork `atomic-editor` or similar).
- **Agent interface:** MCP server (stdio/localhost).
- **Desktop shell (deferred):** Tauri.

---

## 11. Development roadmap

Build the engine and agent value first (no UI needed to capture the main win), then the
human surface, then packaging.

### Phase 0 — Skeleton
- Repo, Bun backend process skeleton, Git-backed vault/file model, frontmatter + wikilink conventions.
- Define stable repository-relative node IDs and note-to-code attachment conventions.
- Define immutable note UUIDs, section marker format, managed timestamp ownership, and
  unresolved-target diagnostics.
- Add an explicit migration command for existing notes without UUIDs, aliases, or section
  markers; migrations must be reviewable file changes, never silent index-time mutations.
- `bun run` scripts for dev, indexing, MCP server startup, and tests.
- **Done when:** a hand-written `.md` with frontmatter + `[[links]]` parses without error.

### Phase 1 — The engine
- Indexer + SQLite schema (notes, sections, links edge table, FTS5, table extraction).
- Project graph extraction for directories, files, manifests/imports, tests, and note attachments.
- File watcher → incremental reindex.
- Git repository detection, status/history/diff integration, and restore-triggered reindex.
- `vault_check` diagnostics for unresolved links/attachments, duplicate section IDs, and
  malformed frontmatter.
- **Done when:** editing a file on disk updates the index within ms; backlinks and FTS
  queries return correct results; rename/delete cases are diagnosable; deleting +
  rebuilding the DB reproduces identical state.

### Phase 2 — Agent value (headless)
- MCP server implementing the §8 tool surface (slices, not dumps) as a per-vault Bun
  stdio process.
- Optimistic section and full-note writes with atomic replacement, conflict detection,
  validation, and synchronous incremental reindexing.
- Project-map and task-context queries that return focused graph neighborhoods instead of
  whole-repository dumps.
- MCP Git history, diff, and explicit restore tools; automatic checkpointing remains opt-in.
- Add a reproducible `bench/` evaluation with 3–5 fixed tasks against the current Cortex
  repository.
  Compare baseline grep/read exploration against MCP exploration using tool-call count,
  returned-token count, and wall-clock time.
- **Done when:** the MCP protocol exposes all Phase 2 tools, external changes are
  reindexed, stale writes are rejected, Git restore reindexes, and the benchmark records
  a repeatable reduction in exploration calls and returned tokens without unacceptable
  latency. Claude-specific wiring is not a Phase 2 acceptance criterion.

### Phase 2b — Claude Code integration (deferred)
- Register the MCP server with Claude Code.
- Add `CLAUDE.md`, the notes skill, SessionStart/UserPromptSubmit/PostToolUse hooks, and
  optional plugin packaging.
- Measure injected-context budgets and verify the read-before/update-after workflow in
  a real Claude Code session.

### Phase 3 — Human surface
- Phase 3 entry gate: complete the live-preview candidate spike from §6.5 and choose a
  fork, or explicitly defer live preview while shipping source/read-only modes.
- CM6 editor (forked live-preview), three modes, wikilink autocomplete + backlinks from index.
- Reader = CM6 readOnly.
- Task-focused graph view with notes displayed as annotations on project nodes.
- Two-writer reconciliation (§7).
- **Done when:** the selected editor mode is stable on real long/link-heavy notes without
  cursor jumps; if live preview is deferred, source/read-only editing remains reliable;
  an agent patch to an open file reconciles cleanly.

### Phase 4 — Packaging
- Wrap the web UI in Tauri; optionally embed SQLite in-process to drop the localhost hop.
- **Done when:** installable desktop app over the same backend, no UI rewrite.

### Phase 5 — Polish / optional
- Plugin bundling for distribution; sqlite-vec semantic search; dedicated HTML reader if needed.

---

## 12. Open questions / decisions to revisit

- Parser: start with Bun/TypeScript; revisit Rust only if indexing is measurably slow
  on the target vault size.
- Reader: use CM6 read-only mode initially; add a dedicated HTML renderer only if
  reading polish, KaTeX, Mermaid, or accessibility needs exceed it.
- Concurrency: do not add CRDTs unless same-file conflicts become routine, such as
  several conflicts per week.
- MCP transport: Phase 2 is a per-vault stdio process. Add localhost HTTP only when the
  UI needs a shared endpoint.
- Frontmatter: begin with immutable backend-managed `id` and `created_at`, backend-managed
  `updated_at`, plus `title`, `aliases`, `type`, `tags`, and optional `applies_to` targets.
  Initial types are `note`, `map`, and `table`; links remain wikilinks rather than a
  duplicated relations field. Add optional `applies_to` targets for attaching notes to
  repository paths or symbols without making the graph a second source of truth.
- Section anchors: use explicit `cortex:section` markers and require section IDs for
  writes; ambiguous heading fallback must never write automatically.
- Identity and orphan handling: note UUIDs survive renames; path-based code targets are
  rebound using Git rename data when possible, while unresolved links and attachments are
  reported by `vault_check`.
- Two-writer rule: non-overlapping section edits merge automatically; overlapping edits
  require an explicit keep/take/diff choice, with stale revisions rejected.
- Agent writes: `patch_section` is section-scoped; `replace_note` is an optimistic full
  Markdown replacement guarded by a file hash. Both are atomic and reindex after success.
- Live-preview risk: timebox a candidate spike before Phase 3 and ship source/read-only
  modes if no candidate passes.
- Evaluation: keep a checked-in 3–5 task benchmark comparing grep/read exploration with
  MCP queries across tool calls, returned tokens, and wall-clock time.
- Claude context injection: defer the 500–800 token SessionStart budget and index-of-
  indices fallback until Phase 2b integration.
- Project graph: v1 covers repository structure, imports/manifests, tests, and curated
  note attachments. Symbol-level and runtime graphs are later enhancements.
- Versioning: Git is the vault's local history. Manual checkpoints are the default;
  optional post-agent-task checkpoints are allowed, but never commit every save.
  SQLite and other rebuildable runtime data stay untracked.

---

## 13. References

- CodeMirror 6 (editor foundation Obsidian uses): https://codemirror.net
- atomic-editor (Obsidian-style live preview, React): https://github.com/kenforthewin/atomic-editor
- codemirror-live-markdown: https://github.com/blueberrycongee/codemirror-live-markdown
- codemirror-rich-obsidian: https://github.com/Type-32/codemirror-rich-obsidian
- SQLite FTS5: https://www.sqlite.org/fts5.html
- sqlite-vec: https://github.com/asg017/sqlite-vec
- Tauri: https://tauri.app
- comrak: https://github.com/kivikakk/comrak · pulldown-cmark: https://github.com/raphlinus/pulldown-cmark
- Claude Code docs: https://code.claude.com/docs
- Prior art / inspiration (do not adopt wholesale):
  - Basic Memory (markdown + graph + MCP): https://docs.basicmemory.com
  - codebase-memory-mcp (code graph, hook-driven freshness): https://github.com/DeusData/codebase-memory-mcp
  - AFFiNE / BlockSuite (anti-pattern for this project — too heavy, block-tree model):
    https://github.com/toeverything/AFFiNE
