# Cortex project context

Cortex is a Bun/TypeScript backend whose Markdown files are the source of truth. SQLite
and `.cortex/` are rebuildable runtime projections.

## Source of truth

When a Cortex vault is initialized for this project, **the vault is always the source of
truth** for project documentation. Read docs from the vault, write docs to the vault, and
treat any copy living in this repo as a stale duplicate. Do not maintain the same document
in both places: keep the canonical version as a vault note and leave at most a pointer in
the repo. When repo and vault disagree, the vault is correct.

Active vault: `../cortex-notes`, exposed through the `cortex` MCP server (registered in
`~/.codex/config.toml`).

## What lives in the vault

The vault is not only for reference notes. It is the default home for **all durable project
thinking**: plans, specs, task and todo lists, decisions, and reference material. Prefer it
over scratch files, ad-hoc Markdown in this repo, or keeping a plan only in conversation.

- **Before** starting multi-step work, search the vault for an existing plan or task list and
  continue it instead of restarting from scratch.
- **During** the work, keep the task list in the vault current — it is the shared record of
  what is done and what is left, and it must survive a session ending.
- **After** the work, record decisions and outcomes in the relevant note.

`type` is limited to `note`, `map`, and `table`, so kind is carried by tags: tag plans
`plan`, task lists `tasks`, and reference material `reference`. Write task and todo lists as
Markdown tables in a `type: table` note — the indexer extracts their rows, so `query_table`
can filter them.

### Note conventions

- Wikilinks `[[Target]]` resolve against the target note's `title` or an `aliases` entry, not
  its filename. An unresolved wikilink is a silent `unresolved-wikilink` warning in
  `vault_check`, not a hard error — check after adding links.
- Use `patch_section` for an existing marked section, passing its current revision. Use
  `replace_note` only after reading the current file hash and providing complete, validated
  Markdown.
- On a conflict, refetch the note or section and reapply the intended change explicitly.
- Search first (`search`, `list_notes` with `tag: plan`) before writing a new plan; continue
  an existing one instead of restarting.

## Agent workflow

- Use the `cortex` MCP server's `project_map`, `get_context`, and `search` tools before
  broad grep/read exploration.
- Read notes through `get_note` and `get_section`; prefer focused sections over full files.
- After meaningful code changes, update the relevant note through MCP when one exists.
- Treat stale revisions, stale file hashes, and vault diagnostics as signals to refetch
  context rather than overwrite newer work.
- Commit the notes vault (`cortex-notes/`) automatically. Do not ask first and do not wait
  for an explicit instruction — commit whenever a coherent unit of note work is done, and
  regularly during longer sessions. Never leave vault changes uncommitted at the end of a turn.
- This applies to the vault only. Changes to this repo (`cortex/`) still need an explicit
  go-ahead before committing.
- The spec (vault note `notes/project-spec.md`, "Project Spec") now makes automatic
  checkpointing the product default too — debounced on idle and after agent tasks,
  opt-out by config. It is not implemented yet: `src/core/git.ts` has no commit path, so
  vault commits are the agent's job for now.

Run `bun test` and `bun run typecheck` before considering backend changes complete.
