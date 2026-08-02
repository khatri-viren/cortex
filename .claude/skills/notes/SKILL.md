---
name: notes
description: Use Cortex's graph, notes, plans, and task lists to reduce repository re-exploration and keep project knowledge current. Covers reading context before exploring, and writing plans, todos, decisions, and reference material into the vault.
---

# Cortex vault workflow

The vault holds all durable project thinking, not just reference notes: plans, specs, task
and todo lists, decisions, and references. Reach for it before a scratch file, before ad-hoc
Markdown in the code repo, and before leaving a plan only in the conversation.

## Before exploring

1. Use `project_map` or `get_context` for the relevant path or node.
2. Use `search` or `list_notes` to find supporting notes.
3. Use `get_note` for the outline, then `get_section` for only the needed section.
4. Read source files after the graph identifies likely locations.

## While changing code

- Prefer the graph's repository relationships over rebuilding them with broad grep.
- Treat note UUIDs, `id`, and `created_at` as immutable.
- Keep note links and `applies_to` targets valid when changing note metadata.

## Wikilinks

- `[[Target]]` resolves against the target note's `title` or an `aliases` entry — **not**
  its filename — with one exception: a target matching the note's own filename stem
  (e.g. `[[phase-1-indexing-engine]]` for `notes/phase-1-indexing-engine.md`) always
  resolves too, even without a matching alias.
- Prefer linking with the exact title (`[[Engine Notes]]`), since that's what's shown to
  readers. If you write a filename-style slug instead, it still resolves via the fallback
  above — but only for that note's *own* filename, so a slug that doesn't match the
  target's actual filename or title/aliases will not resolve.
- A wikilink that doesn't resolve is a silent, warning-level `unresolved-wikilink`
  diagnostic, not a hard error — check `vault_check` after adding links, don't assume a
  link worked just because nothing complained while writing it.

## Updating notes

- Use `patch_section` for an existing marked section and pass its current revision.
- Use `replace_note` only after reading the current file hash and providing complete
  validated Markdown.
- On a conflict, refetch the note or section and reapply the intended change explicitly.
- Create a new note when the information has no appropriate existing home.
- Update a relevant note after meaningful architectural or workflow changes, not after
  every trivial edit.

## Note kinds

`type` accepts only `note`, `map`, and `table`, so the *kind* of document is carried by tags.
Do not invent a `type` value — frontmatter validation rejects it.

| Kind | `type` | Tag | Notes |
|---|---|---|---|
| Reference / knowledge | `note` | `reference` | Default for explanations and findings |
| Plan | `note` | `plan` | One note per plan; keep the goal and the steps together |
| Task / todo list | `table` | `tasks` | Use a Markdown table; rows become queryable |
| Decision record | `note` | `decision` | State the decision, the why, and what it rules out |
| Project or area map | `map` | — | Graph-level overview |

## Plans

- Search first: `search` for the topic and `list_notes` with `tag: plan` before writing a new
  plan. Continuing an existing plan beats restarting one.
- Keep the plan's goal, constraints, and open questions in their own sections so single
  sections can be revised with `patch_section` as the work progresses.
- Attach the plan to what it changes with `applies_to`, using `documents` for an explanation
  and `implements` when the plan drives a specific path.
- Record the outcome in the plan when the work lands. A plan that never got closed out is
  indistinguishable from one still in progress.

## Task and todo lists

- Write them as Markdown tables. The indexer extracts rows from tables in **any** note
  regardless of its type, so `query_table` can filter them — a bulleted list is not queryable.
  Use `type: table` to label a note that is primarily tabular; extraction does not require it.
- Give every table a `status` column so open and done work can be separated by query.
- Update status through `patch_section` on the table's section, passing the current revision.
  Never rewrite the whole note to tick one item off.
- Task state belongs in the vault, not only in the conversation: it has to survive a session
  ending, a compaction, or a different agent picking the work up.

## References

- Capture external links, dashboards, and tickets as `reference`-tagged notes rather than
  pasting URLs into unrelated notes.
- Record what the resource is for, not just its address.

Do not edit `.cortex/` files directly. They are rebuildable index and watcher state.
