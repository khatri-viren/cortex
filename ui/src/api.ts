import type { ApiContext, ApiDiff, ApiGraph, ApiHistory, ApiNoteMetadataPatch, ApiNoteSource, ApiRepoRestoreResult, ApiVaultCheck, ApiVaultTree, ApiWorkspaceStatus } from "../../src/api/contracts";
import { getApiOrigin } from "./runtime";

export type NoteSummary = {
  id: string;
  path: string;
  title: string;
  type: "note" | "map" | "table";
  created_at: string;
  updated_at: string;
  aliases: string[];
  tags: string[];
  content_hash: string;
};

type ListNotesResponse = { notes: NoteSummary[]; truncated: boolean };
type SearchResponse = { hits: Array<{ note_id: string; title: string; path: string; snippet: string }>; truncated: boolean };
type ProjectMapResponse = ApiGraph;
type ReconcileResponse =
  | { status: "merged"; markdown: string; changedSections: string[]; remote_markdown: string; remote_hash: string }
  | { status: "conflict"; conflicts: string[]; remote_markdown: string; remote_hash: string };
type HealthResponse = {
  status: string;
  phase: number;
  index: {
    noteCount: number;
    sectionCount: number;
    linkCount: number;
    tableRowCount: number;
    graphNodeCount: number;
    graphEdgeCount: number;
    diagnosticCount: number;
  };
};

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const origin = typeof window === "undefined" ? "" : getApiOrigin(window.location.search);
  const response = await fetch(origin + path, { headers: { "content-type": "application/json" }, ...init });
  if (!response.ok) {
    const payload: unknown = await response.json().catch(() => ({}));
    const message = payload && typeof payload === "object" && "error" in payload
      ? String((payload as { error?: { message?: string } }).error?.message ?? response.statusText)
      : response.statusText;
    throw new Error(message);
  }
  return await response.json() as T;
}

export function listNotes(prefix?: string, limit?: number): Promise<ListNotesResponse> {
  const params = new URLSearchParams();
  if (prefix) params.set("prefix", prefix);
  if (limit) params.set("limit", String(limit));
  const query = params.toString();
  return request<ListNotesResponse>("/api/notes" + (query ? "?" + query : ""));
}

export function getVaultTree(): Promise<ApiVaultTree> {
  return request<ApiVaultTree>("/api/vault/tree");
}

export function searchNotes(query: string): Promise<SearchResponse> {
  return request<SearchResponse>("/api/search?query=" + encodeURIComponent(query) + "&limit=20");
}

export function createNote(input: { title: string; type?: "note" | "map" | "table"; path?: string }): Promise<{ path: string; id: string }> {
  return request<{ path: string; id: string }>("/api/notes", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function getNoteSource(selector: string): Promise<ApiNoteSource> {
  return request<ApiNoteSource>("/api/note?selector=" + encodeURIComponent(selector) + "&source=true");
}

export function getProjectMap(node?: string): Promise<ProjectMapResponse> {
  return request<ProjectMapResponse>("/api/project-map?depth=1&limit=40" + (node ? "&node=" + encodeURIComponent(node) : ""));
}

export function getContext(node: string): Promise<ApiContext> {
  return request<ApiContext>("/api/context?node=" + encodeURIComponent(node) + "&limit=40");
}

export function getWorkspaceStatus(): Promise<ApiWorkspaceStatus> {
  return request<ApiWorkspaceStatus>("/api/workspace/status");
}

export function getVaultCheck(): Promise<ApiVaultCheck> {
  return request<ApiVaultCheck>("/api/vault-check");
}

export function getHealth(): Promise<HealthResponse> {
  return request<HealthResponse>("/api/health");
}

export function getRepoHistory(repository: string, path: string): Promise<ApiHistory> {
  return request<ApiHistory>("/api/workspace/repo-history?repository=" + encodeURIComponent(repository) + "&path=" + encodeURIComponent(path) + "&limit=20");
}

export function getRepoDiff(repository: string, path: string, revision?: string): Promise<ApiDiff> {
  const query = "?repository=" + encodeURIComponent(repository) + "&path=" + encodeURIComponent(path) + (revision ? "&revision=" + encodeURIComponent(revision) : "");
  return request<ApiDiff>("/api/workspace/repo-diff" + query);
}

export function restoreRepoPath(repository: string, path: string, revision: string): Promise<ApiRepoRestoreResult> {
  return request<ApiRepoRestoreResult>("/api/workspace/repo-restore", {
    method: "POST",
    body: JSON.stringify({ repository, path, revision, confirm: true }),
  });
}

export function getHistory(selector: string): Promise<ApiHistory> {
  return request<ApiHistory>("/api/history?selector=" + encodeURIComponent(selector) + "&limit=20");
}

export function getDiff(selector: string, revision?: string): Promise<ApiDiff> {
  const query = "?selector=" + encodeURIComponent(selector) + (revision ? "&revision=" + encodeURIComponent(revision) : "");
  return request<ApiDiff>("/api/diff" + query);
}

export function restoreNote(note: string, revision: string): Promise<unknown> {
  return request("/api/restore", {
    method: "POST",
    body: JSON.stringify({ note, revision }),
  });
}

export function replaceNote(note: string, expectedFileHash: string, markdown: string): Promise<ApiNoteSource> {
  return request("/api/note", {
    method: "PUT",
    body: JSON.stringify({ note, expected_file_hash: expectedFileHash, markdown }),
  });
}

export function updateNote(
  note: string,
  expectedFileHash: string,
  body: string,
  metadata: ApiNoteMetadataPatch,
): Promise<ApiNoteSource> {
  return request<ApiNoteSource>("/api/note", {
    method: "PUT",
    body: JSON.stringify({ note, expected_file_hash: expectedFileHash, body, metadata }),
  });
}

export function reconcile(note: string, baseMarkdown: string, localMarkdown: string): Promise<ReconcileResponse> {
  return request<ReconcileResponse>("/api/reconcile", {
    method: "POST",
    body: JSON.stringify({ note, base_markdown: baseMarkdown, local_markdown: localMarkdown }),
  });
}

export function subscribeToChanges(onChange: (events: Array<{ type: string; path: string; repository?: string }>) => void): () => void {
  const origin = typeof window === "undefined" ? "" : getApiOrigin(window.location.search);
  const source = new EventSource(origin + "/events");
  const handle = (event: MessageEvent<string>) => {
    try {
      const payload = JSON.parse(event.data) as { events?: Array<{ type: string; path: string; repository?: string }> };
      onChange(payload.events ?? []);
    } catch {
      // A malformed event cannot safely update an open buffer.
    }
  };
  source.addEventListener("vault.change", handle);
  return () => {
    source.removeEventListener("vault.change", handle);
    source.close();
  };
}
