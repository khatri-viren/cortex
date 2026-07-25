import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import type { AppliesTo, Diagnostic } from "./types.js";
import type { GraphEdge } from "./index-types.js";
import { directoryId, fileId } from "./workspace-indexer.js";
import { repositoryRelativePath, type WorkspaceConfig } from "./workspace.js";

export type NoteAttachmentInput = { noteId: string; path: string; appliesTo: AppliesTo[] };

export type WorkspaceAttachmentResult = { edges: GraphEdge[]; diagnostics: Diagnostic[] };

export function resolveWorkspaceAttachments(config: WorkspaceConfig, notes: NoteAttachmentInput[]): WorkspaceAttachmentResult {
  const edges: GraphEdge[] = [];
  const diagnostics: Diagnostic[] = [];
  for (const note of notes) {
    for (const attachment of note.appliesTo) {
      if (!attachment.repository) continue;
      const repository = config.repositories.find((candidate) => candidate.id === attachment.repository);
      if (!repository) {
        diagnostics.push({ severity: "error", code: "unknown-workspace-repository", message: `Attachment repository '${attachment.repository}' was not discovered in the workspace.`, filePath: note.path });
        continue;
      }
      let relative: string;
      try {
        relative = repositoryRelativePath(config.workspaceRoot, repository, attachment.target);
      } catch (cause) {
        diagnostics.push({ severity: "error", code: "invalid-workspace-attachment-target", message: cause instanceof Error ? cause.message : String(cause), filePath: note.path });
        continue;
      }
      const absolute = join(repository.absolutePath, relative);
      if (!existsSync(absolute)) {
        diagnostics.push({ severity: "warning", code: "unresolved-attachment-target", message: `Could not resolve attachment target '${attachment.repository}:${attachment.target}'.`, filePath: note.path });
        continue;
      }
      const targetId = statSync(absolute).isDirectory() ? directoryId(repository.id, relative) : fileId(repository.id, relative);
      edges.push({ fromId: `note:${note.noteId}`, toId: targetId, kind: attachment.relation, metadata: { repository: repository.id, target: attachment.target } });
    }
  }
  return { edges, diagnostics };
}

export function requireAppliesToRepository(appliesTo: AppliesTo[]): void {
  const missing = appliesTo.find((entry) => !entry.repository);
  if (missing) throw new Error(`Workspace mode requires an explicit 'repository' field on applies_to entries (missing for target '${missing.target}').`);
}
