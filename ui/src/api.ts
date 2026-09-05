import type { ApiContext, ApiDiff, ApiGraph, ApiHealth, ApiHistory, ApiIndexRefreshResult, ApiNoteMetadataPatch, ApiNoteSource, ApiRepoRestoreResult, ApiVaultCheck, ApiVaultTree, ApiWorkspaceStatus } from "../../src/api/contracts";
import { getRuntimeConnection } from "./runtime";

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

export type ListNotesResponse = { notes: NoteSummary[]; truncated: boolean; next_cursor?: string };
type SearchResponse = { hits: Array<{ note_id: string; title: string; path: string; snippet: string }>; truncated: boolean };
type ProjectMapResponse = ApiGraph;
type ReconcileResponse =
  | { status: "merged"; markdown: string; changedSections: string[]; remote_markdown: string; remote_hash: string }
  | { status: "conflict"; conflicts: string[]; remote_markdown: string; remote_hash: string };
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await getRuntimeConnection().request(path, { headers: { "content-type": "application/json" }, ...init });
  if (!response.ok) {
    const payload: unknown = await response.json().catch(() => ({}));
    const message = payload && typeof payload === "object" && "error" in payload
      ? String((payload as { error?: { message?: string } }).error?.message ?? response.statusText)
      : response.statusText;
    throw new Error(message);
  }
  return await response.json() as T;
}

export function listNotes(prefix?: string, limit?: number, cursor?: string): Promise<ListNotesResponse> {
  const params = new URLSearchParams();
  if (prefix) params.set("prefix", prefix);
  if (limit) params.set("limit", String(limit));
  if (cursor) params.set("cursor", cursor);
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

export function getWorkspaceStatus(includeGit = false): Promise<ApiWorkspaceStatus> {
  return request<ApiWorkspaceStatus>("/api/workspace/status" + (includeGit ? "?include_git=true" : ""));
}

export function getVaultCheck(): Promise<ApiVaultCheck> {
  return request<ApiVaultCheck>("/api/vault-check");
}

export function getHealth(): Promise<ApiHealth> {
  return request<ApiHealth>("/api/health");
}

export function rebuildIndex(): Promise<ApiIndexRefreshResult> {
  return request<ApiIndexRefreshResult>("/api/index/rebuild", { method: "POST" });
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

export async function exportNotePdf(note: string, body: string, title: string): Promise<{ blob: Blob; filename: string }> {
  const connection = getRuntimeConnection();
  const origin = connection.origin;
  console.info("[PDF-EXPORT] request:start", { note, title, bodyLength: body.length, origin });
  const response = await connection.request("/api/note/export/pdf", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ note, body, title }),
  });
  console.info("[PDF-EXPORT] request:response", { status: response.status, contentType: response.headers.get("content-type") });
  if (!response.ok) {
    const payload: unknown = await response.json().catch(() => ({}));
    const message = payload && typeof payload === "object" && "error" in payload
      ? String((payload as { error?: { message?: string } }).error?.message ?? response.statusText)
      : response.statusText;
    throw new Error(message);
  }
  const disposition = response.headers.get("content-disposition") ?? "";
  const match = disposition.match(/filename="([^"]+)"/i);
  const blob = await response.blob();
  const filename = match?.[1] ?? "untitled-note.pdf";
  console.info("[PDF-EXPORT] request:complete", { filename, bytes: blob.size, type: blob.type });
  return { blob, filename };
}

export function reconcile(note: string, baseMarkdown: string, localMarkdown: string): Promise<ReconcileResponse> {
  return request<ReconcileResponse>("/api/reconcile", {
    method: "POST",
    body: JSON.stringify({ note, base_markdown: baseMarkdown, local_markdown: localMarkdown }),
  });
}

export type ApiChangeSet = {
  sequence: number;
  generation: number;
  events: Array<{ type: string; path: string; repository?: string; scopes?: string[] }>;
  resync_required?: boolean;
};

export function subscribeToChanges(onChange: (changeSet: ApiChangeSet) => void): () => void {
  let source: EventSource | undefined;
  let stopped = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let lastSequence = 0;
  const connect = () => {
    if (stopped) return;
    const suffix = lastSequence > 0 ? `?since=${lastSequence}` : "";
    source = getRuntimeConnection().events("/events" + suffix);
    source.addEventListener("vault.change", handle);
    source.onerror = () => {
      source?.close();
      if (!stopped && !reconnectTimer) reconnectTimer = setTimeout(() => { reconnectTimer = undefined; connect(); }, 250);
    };
  };
  const handle = (event: Event) => {
    try {
      const payload = JSON.parse((event as MessageEvent<string>).data) as Partial<ApiChangeSet>;
      if (!Array.isArray(payload.events) || typeof payload.sequence !== "number" || typeof payload.generation !== "number") return;
      if (payload.sequence <= lastSequence) return;
      lastSequence = payload.sequence;
      onChange({ sequence: payload.sequence, generation: payload.generation, events: payload.events, resync_required: payload.resync_required });
    } catch {
      // A malformed event cannot safely update an open buffer.
    }
  };
  connect();
  return () => {
    stopped = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    source?.removeEventListener("vault.change", handle);
    source?.close();
  };
}
