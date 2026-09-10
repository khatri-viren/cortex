import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { workspaceDirectoryNodeId as directoryId, workspaceFileNodeId as fileId } from "./identity.js";
import type { AppliesTo, Diagnostic } from "./types.js";
import type { GraphEdge } from "./index-types.js";
import { isWorkspaceIgnored, repositoryRelativePath, type WorkspaceConfig, workspaceIgnorePatterns, workspaceRepositoryMatches } from "./workspace.js";

export type NoteAttachmentInput = { noteId: string; path: string; appliesTo: AppliesTo[] };

export type WorkspaceAttachmentResult = { edges: GraphEdge[]; diagnostics: Diagnostic[] };

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function noteSortKey(note: NoteAttachmentInput): string {
  return `${note.path}\u0000${note.noteId}`;
}

function attachmentSortKey(attachment: AppliesTo): string {
  return `${attachment.repository ?? ""}\u0000${attachment.target}\u0000${attachment.relation}`;
}

function edgeSortKey(edge: GraphEdge): string {
  return `${edge.fromId}\u0000${edge.toId}\u0000${edge.kind}\u0000${JSON.stringify(edge.metadata ?? {})}`;
}

function diagnosticSortKey(diagnostic: Diagnostic): string {
  return `${diagnostic.filePath ?? ""}\u0000${diagnostic.line ?? 0}\u0000${diagnostic.column ?? 0}\u0000${diagnostic.code}\u0000${diagnostic.message}`;
}

export function resolveWorkspaceAttachments(config: WorkspaceConfig, notes: NoteAttachmentInput[]): WorkspaceAttachmentResult {
  const edges: GraphEdge[] = [];
  const edgeKeys = new Set<string>();
  const diagnostics: Diagnostic[] = [];
  const patterns = workspaceIgnorePatterns(config.manifest);
  for (const note of [...notes].sort((left, right) => compareText(noteSortKey(left), noteSortKey(right)))) {
    for (const attachment of [...note.appliesTo].sort((left, right) => compareText(attachmentSortKey(left), attachmentSortKey(right)))) {
      if (!attachment.repository) {
        diagnostics.push({ severity: "error", code: "missing-workspace-repository", message: `Attachment target '${attachment.target}' requires a repository. Available repositories: ${config.repositories.map((candidate) => candidate.id).join(", ") || "none"}.`, filePath: note.path });
        continue;
      }
      const matches = workspaceRepositoryMatches(config.repositories, attachment.repository);
      if (matches.length === 0) {
        diagnostics.push({ severity: "error", code: "unknown-workspace-repository", message: `Attachment repository '${attachment.repository}' was not discovered in the workspace. Available repositories: ${config.repositories.map((candidate) => candidate.id).join(", ") || "none"}.`, filePath: note.path });
        continue;
      }
      if (matches.length > 1) {
        diagnostics.push({ severity: "error", code: "ambiguous-workspace-repository", message: `Attachment repository '${attachment.repository}' matches multiple repositories: ${matches.map((candidate) => candidate.id).join(", ")}.`, filePath: note.path });
        continue;
      }
      const repository = matches[0]!;
      if (attachment.target.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(attachment.target)) {
        diagnostics.push({ severity: "error", code: "invalid-workspace-attachment-target", message: `Absolute attachment target '${attachment.target}' is not accepted; use a repository-relative target such as '.'.`, filePath: note.path });
        continue;
      }
      let relative: string;
      try {
        relative = repositoryRelativePath(config.workspaceRoot, repository, attachment.target);
        if (relative !== "." && isWorkspaceIgnored(relative, patterns)) throw new Error(`Workspace target '${attachment.target}' is not indexable.`);
      } catch (cause) {
        diagnostics.push({ severity: "error", code: "invalid-workspace-attachment-target", message: cause instanceof Error ? cause.message : String(cause), filePath: note.path });
        continue;
      }
      const absolute = relative === "." ? repository.absolutePath : join(repository.absolutePath, relative);
      let targetStats: ReturnType<typeof statSync>;
      try {
        if (!existsSync(absolute)) throw new Error("missing");
        targetStats = statSync(absolute);
      } catch {
        diagnostics.push({ severity: "warning", code: "unresolved-attachment-target", message: `Could not resolve attachment target '${attachment.repository}:${attachment.target}'.`, filePath: note.path });
        continue;
      }
      const targetId = relative === "."
        ? `repo:${repository.id}`
        : targetStats.isDirectory() ? directoryId(repository.id, relative) : fileId(repository.id, relative);
      const edge = { fromId: `note:${note.noteId}`, toId: targetId, kind: attachment.relation, metadata: { repository: repository.id, target: attachment.target } } satisfies GraphEdge;
      const key = edgeSortKey(edge);
      if (!edgeKeys.has(key)) {
        edgeKeys.add(key);
        edges.push(edge);
      }
    }
  }
  return {
    edges: edges.sort((left, right) => compareText(edgeSortKey(left), edgeSortKey(right))),
    diagnostics: diagnostics.sort((left, right) => compareText(diagnosticSortKey(left), diagnosticSortKey(right))),
  };
}

export function requireAppliesToRepository(appliesTo: AppliesTo[]): void {
  const missing = appliesTo.find((entry) => !entry.repository);
  if (missing) throw new Error(`Workspace mode requires an explicit 'repository' field on applies_to entries (missing for target '${missing.target}').`);
}
