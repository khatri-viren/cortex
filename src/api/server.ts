import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { reconcileMarkdown } from "../core/reconcile.js";
import { ServiceError } from "../core/errors.js";
import { VaultRuntime } from "../core/runtime.js";
import { exportFilename } from "../core/pdf-export.js";
import { logger } from "../logger.js";
import type { VaultChangeSet } from "../core/runtime-types.js";
import type { ApiNoteUpdateInput } from "./contracts.js";

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
};
const ALLOWED_CORS_ORIGINS = new Set([
  "http://127.0.0.1:5175",
  "http://localhost:5175",
  "tauri://localhost",
  "http://tauri.localhost",
  "https://tauri.localhost",
]);

type JsonObject = Record<string, unknown>;

function stableId(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function responseHeaders(request: Request, overrides: Record<string, string> = {}): Record<string, string> {
  const origin = request.headers.get("origin");
  return {
    ...JSON_HEADERS,
    ...(origin && ALLOWED_CORS_ORIGINS.has(origin) ? { "access-control-allow-origin": origin, vary: "Origin" } : {}),
    ...overrides,
  };
}

function json(request: Request, payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: responseHeaders(request) });
}

function errorResponse(request: Request, cause: unknown): Response {
  if (cause instanceof ServiceError) {
    const status = cause.code === "NOT_FOUND" ? 404 : cause.code === "CONFLICT" || cause.code === "GIT_DIRTY" ? 409 : cause.code === "VAULT_INVALID" ? 422 : cause.code === "EXPORT_RENDERER_UNAVAILABLE" ? 503 : cause.code === "EXPORT_TOO_LARGE" ? 413 : cause.code === "EXPORT_QUEUE_FULL" ? 429 : cause.code === "EXPORT_DEADLINE_EXCEEDED" ? 408 : cause.code === "EXPORT_CANCELLED" ? 499 : 400;
    return json(request, { error: { code: cause.code, message: cause.message, details: cause.details } }, status);
  }
  return json(request, { error: { code: "INTERNAL_ERROR", message: cause instanceof Error ? cause.message : String(cause) } }, 500);
}

function numberParam(url: URL, name: string): number | undefined {
  const value = url.searchParams.get(name);
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

async function body(request: Request): Promise<JsonObject> {
  const parsed: unknown = await request.json();
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new ServiceError("INVALID_INPUT", "Request body must be a JSON object.");
  return parsed as JsonObject;
}

function requiredString(input: JsonObject, key: string): string {
  const value = input[key];
  if (typeof value !== "string" || value.length === 0) throw new ServiceError("INVALID_INPUT", "Field '" + key + "' is required.");
  return value;
}

function staticResponse(uiDist: string, pathname: string): Response | undefined {
  const decoded = decodeURIComponent(pathname === "/" ? "/index.html" : pathname);
  const root = resolve(uiDist);
  const candidate = resolve(root, "." + decoded);
  const relativePath = relative(root, candidate);
  if (relativePath.startsWith("../") || relativePath === "..") return new Response("Not found", { status: 404 });
  const path = existsSync(candidate) && statSync(candidate).isFile() ? candidate : join(root, "index.html");
  if (!existsSync(path)) return undefined;
  return new Response(readFileSync(path), { headers: { "content-type": contentType(path) } });
}

function contentType(path: string): string {
  if (path.endsWith(".html")) return "text/html; charset=utf-8";
  if (path.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (path.endsWith(".css")) return "text/css; charset=utf-8";
  if (path.endsWith(".svg")) return "image/svg+xml";
  if (path.endsWith(".png")) return "image/png";
  if (path.endsWith(".ico")) return "image/x-icon";
  if (path.endsWith(".woff2")) return "font/woff2";
  if (path.endsWith(".json")) return "application/json; charset=utf-8";
  return "application/octet-stream";
}

function eventStream(request: Request, runtime: VaultRuntime, since?: number): Response {
  const encoder = new TextEncoder();
  let unsubscribe: () => void = () => undefined;
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | undefined;
  let closed = false;
  const queue: Uint8Array[] = [];
  const maxQueue = 128;
  const encode = (changeSet: VaultChangeSet): Uint8Array => encoder.encode("event: vault.change\ndata: " + JSON.stringify(changeSet) + "\n\n");
  const flush = () => {
    if (!controllerRef) return;
    while (queue.length > 0 && (controllerRef.desiredSize === null || controllerRef.desiredSize > 0)) controllerRef.enqueue(queue.shift()!);
  };
  const enqueue = (changeSet: VaultChangeSet) => {
    if (closed) return;
    if (queue.length >= maxQueue) {
      queue.length = 0;
      queue.push(encode({ sequence: changeSet.sequence, generation: changeSet.generation, events: [], resync_required: true }));
    } else {
      queue.push(encode(changeSet));
    }
    flush();
  };
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef = controller;
      controller.enqueue(encoder.encode("retry: 1000\n\n"));
      if (since !== undefined) {
        const replay = runtime.changesSince(since);
        if (replay.resyncRequired) enqueue({ sequence: replay.sequence, generation: replay.generation, events: [], resync_required: true });
        else for (const changeSet of replay.changes) enqueue(changeSet);
      }
      unsubscribe = runtime.subscribe((changeSet: VaultChangeSet) => enqueue(changeSet));
      flush();
    },
    pull() {
      flush();
    },
    cancel() {
      closed = true;
      queue.length = 0;
      unsubscribe();
    },
  });
  return new Response(stream, {
    headers: {
      ...responseHeaders(request, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        connection: "keep-alive",
      }),
    },
  });
}

export function createApiServer(runtime: VaultRuntime, port: number, uiDist?: string): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    hostname: "127.0.0.1",
    port,
    idleTimeout: 0,
    async fetch(request) {
      const url = new URL(request.url);
      try {
        if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: responseHeaders(request, { "access-control-allow-methods": "GET,POST,PATCH,PUT,OPTIONS", "access-control-allow-headers": "content-type" }) });
        if (url.pathname === "/events" && request.method === "GET") return eventStream(request, runtime, numberParam(url, "since"));
        if (url.pathname === "/api/changes" && request.method === "GET") return json(request, runtime.changesSince(numberParam(url, "since") ?? 0));
        if (url.pathname === "/api/health" && request.method === "GET") return json(request, runtime.health());
        if (url.pathname === "/api/index/rebuild" && request.method === "POST") return json(request, await runtime.rebuildIndex());
        if (url.pathname === "/api/notes" && request.method === "GET") return json(request, runtime.listNotes(url.searchParams.get("prefix") ?? undefined, url.searchParams.get("tag") ?? undefined, numberParam(url, "limit"), url.searchParams.get("cursor") ?? undefined));
        if (url.pathname === "/api/notes/suggest" && request.method === "GET") return json(request, runtime.suggestNoteLinks(url.searchParams.get("query") ?? "", numberParam(url, "limit")));
        if (url.pathname === "/api/vault/tree" && request.method === "GET") return json(request, runtime.vaultTree());
        if (url.pathname === "/api/note" && request.method === "GET") {
          const selector = url.searchParams.get("selector");
          if (!selector) throw new ServiceError("INVALID_INPUT", "Query parameter 'selector' is required.");
          return json(request, url.searchParams.get("source") === "true" ? runtime.getSource(selector) : runtime.getNote(selector));
        }
        if (url.pathname === "/api/note/export/pdf" && request.method === "POST") {
          const contentLength = Number(request.headers.get("content-length") ?? "0");
          if (Number.isFinite(contentLength) && contentLength > 8 * 1024 * 1024 + 64 * 1024) throw new ServiceError("EXPORT_TOO_LARGE", "PDF export request is too large.");
          const input = await body(request);
          const note = requiredString(input, "note");
          const markdownBody = input.body === undefined ? undefined : typeof input.body === "string" ? input.body : (() => { throw new ServiceError("INVALID_INPUT", "Field 'body' must be a string."); })();
          const title = input.title === undefined ? undefined : typeof input.title === "string" ? input.title : (() => { throw new ServiceError("INVALID_INPUT", "Field 'title' must be a string."); })();
          logger.info({ noteHash: stableId(note), titleLength: title?.length ?? null, bodyLength: markdownBody?.length ?? null }, "[PDF-EXPORT] server:start");
          try {
            const started = performance.now();
            const artifact = await runtime.exportPdfArtifact(note, markdownBody, title, { signal: request.signal });
            const filename = title?.trim() || runtime.getNote(note).note.title;
            artifact.timings.deliveryMs = performance.now() - started;
            logger.info({ noteHash: stableId(note), renderer: artifact.renderer, bytes: artifact.pdf.length, ...artifact.timings }, "[PDF-EXPORT] server:complete");
            return new Response(new Uint8Array(artifact.pdf), { headers: responseHeaders(request, { "content-type": "application/pdf", "content-length": String(artifact.pdf.length), "x-cortex-pdf-sha256": artifact.checksum, "x-cortex-pdf-renderer": artifact.renderer, "content-disposition": `attachment; filename="${exportFilename(filename)}"`, "cache-control": "no-store" }) });
          } catch (cause) {
            logger.error({ noteHash: stableId(note), errorCode: cause instanceof ServiceError ? cause.code : "INTERNAL_ERROR", cancelled: cause instanceof ServiceError && cause.code === "EXPORT_CANCELLED", err: cause }, "[PDF-EXPORT] server:failed");
            throw cause;
          }
        }
        if (url.pathname === "/api/section" && request.method === "GET") {
          const selector = url.searchParams.get("selector");
          if (!selector) throw new ServiceError("INVALID_INPUT", "Query parameter 'selector' is required.");
          return json(request, runtime.getSection(selector, url.searchParams.get("section_id") ?? undefined, url.searchParams.get("heading") ?? undefined, numberParam(url, "limit"), url.searchParams.get("cursor") ?? undefined));
        }
        if (url.pathname === "/api/search" && request.method === "GET") return json(request, runtime.search(url.searchParams.get("query") ?? "", numberParam(url, "limit"), url.searchParams.get("titles_only") === "true"));
        if (url.pathname === "/api/project-map" && request.method === "GET") return json(request, runtime.projectMap(url.searchParams.get("node") ?? "project:root", numberParam(url, "depth"), numberParam(url, "limit")));
        if (url.pathname === "/api/graph" && request.method === "GET") {
          const node = url.searchParams.get("node");
          if (!node) throw new ServiceError("INVALID_INPUT", "Query parameter 'node' is required.");
          return json(request, runtime.graphQuery(node, (url.searchParams.get("direction") as "in" | "out" | "neighbors") ?? "neighbors", numberParam(url, "depth"), numberParam(url, "limit")));
        }
        if (url.pathname === "/api/context" && request.method === "GET") {
          const node = url.searchParams.get("node");
          if (!node) throw new ServiceError("INVALID_INPUT", "Query parameter 'node' is required.");
          return json(request, runtime.getContext(node, url.searchParams.get("task_hint") ?? undefined, numberParam(url, "limit")));
        }
        if (url.pathname === "/api/history" && request.method === "GET") {
          const selector = url.searchParams.get("selector");
          if (!selector) throw new ServiceError("INVALID_INPUT", "Query parameter 'selector' is required.");
          return json(request, runtime.history(selector, numberParam(url, "limit")));
        }
        if (url.pathname === "/api/diff" && request.method === "GET") {
          const selector = url.searchParams.get("selector");
          if (!selector) throw new ServiceError("INVALID_INPUT", "Query parameter 'selector' is required.");
          return json(request, runtime.diff(selector, url.searchParams.get("revision") ?? undefined));
        }
        if (url.pathname === "/api/vault-check" && request.method === "GET") return json(request, runtime.vaultCheck());
        if (url.pathname === "/api/workspace/status" && request.method === "GET") return json(request, runtime.workspaceStatus(url.searchParams.get("include_git") === "true"));
        if (url.pathname === "/api/workspace/repo-history" && request.method === "GET") {
          const repository = url.searchParams.get("repository");
          const path = url.searchParams.get("path");
          if (!repository || !path) throw new ServiceError("INVALID_INPUT", "Query parameters 'repository' and 'path' are required.");
          return json(request, runtime.getRepoHistory(repository, path, numberParam(url, "limit")));
        }
        if (url.pathname === "/api/workspace/repo-diff" && request.method === "GET") {
          const repository = url.searchParams.get("repository");
          const path = url.searchParams.get("path");
          if (!repository || !path) throw new ServiceError("INVALID_INPUT", "Query parameters 'repository' and 'path' are required.");
          return json(request, runtime.getRepoDiff(repository, path, url.searchParams.get("revision") ?? undefined));
        }
        if (url.pathname === "/api/workspace/repo-restore" && request.method === "POST") {
          const input = await body(request);
          return json(request, await runtime.restoreRepoPath(requiredString(input, "repository"), requiredString(input, "path"), requiredString(input, "revision"), input.confirm === true));
        }
        if (url.pathname === "/api/notes" && request.method === "POST") return json(request, await runtime.createNote(await body(request) as never), 201);
        if (url.pathname === "/api/section" && request.method === "PATCH") {
          const input = await body(request);
          return json(request, await runtime.patchSection(requiredString(input, "note"), requiredString(input, "section_id"), requiredString(input, "expected_revision"), requiredString(input, "new_content")));
        }
        if (url.pathname === "/api/note" && request.method === "PUT") {
          const input = await body(request);
          const update = input as Partial<ApiNoteUpdateInput>;
          const note = requiredString(input, "note");
          const expectedHash = requiredString(input, "expected_file_hash");
          const markdown = typeof update.markdown === "string" ? update.markdown : undefined;
          const bodyText = typeof update.body === "string" ? update.body : undefined;
          const metadata = update.metadata && typeof update.metadata === "object" ? update.metadata : undefined;
          await runtime.updateNote(note, expectedHash, { markdown, body: bodyText, metadata });
          return json(request, runtime.getSource(note));
        }
        if (url.pathname === "/api/restore" && request.method === "POST") {
          const input = await body(request);
          return json(request, await runtime.restore(requiredString(input, "note"), requiredString(input, "revision")));
        }
        if (url.pathname === "/api/reconcile" && request.method === "POST") {
          const input = await body(request);
          const source = runtime.getSource(requiredString(input, "note"));
          const result = reconcileMarkdown(requiredString(input, "base_markdown"), requiredString(input, "local_markdown"), source.markdown);
          return json(request, { ...result, remote_markdown: source.markdown, remote_hash: source.note.content_hash });
        }
        if (uiDist && !url.pathname.startsWith("/api/")) {
          const response = staticResponse(uiDist, url.pathname);
          if (response) return response;
        }
        return new Response("Not found", { status: 404 });
      } catch (cause) {
        return errorResponse(request, cause);
      }
    },
  });
}
