import { existsSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { reconcileMarkdown } from "../core/reconcile.js";
import { ServiceError, VaultRuntime, type VaultChangeEvent } from "../mcp/service.js";

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "access-control-allow-origin": "http://127.0.0.1:5175",
};

type JsonObject = Record<string, unknown>;

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: JSON_HEADERS });
}

function errorResponse(cause: unknown): Response {
  if (cause instanceof ServiceError) {
    const status = cause.code === "NOT_FOUND" ? 404 : cause.code === "CONFLICT" || cause.code === "GIT_DIRTY" ? 409 : cause.code === "VAULT_INVALID" ? 422 : 400;
    return json({ error: { code: cause.code, message: cause.message, details: cause.details } }, status);
  }
  return json({ error: { code: "INTERNAL_ERROR", message: cause instanceof Error ? cause.message : String(cause) } }, 500);
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
  return "application/octet-stream";
}

function eventStream(runtime: VaultRuntime): Response {
  const encoder = new TextEncoder();
  let unsubscribe: () => void = () => undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode("retry: 1000\n\n"));
      unsubscribe = runtime.subscribe((events: VaultChangeEvent[]) => {
        try {
          controller.enqueue(encoder.encode("event: vault.change\ndata: " + JSON.stringify({ events }) + "\n\n"));
        } catch {
          unsubscribe();
        }
      });
    },
    cancel() {
      unsubscribe();
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "access-control-allow-origin": "http://127.0.0.1:5175",
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
        if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: { ...JSON_HEADERS, "access-control-allow-methods": "GET,POST,PATCH,PUT,OPTIONS", "access-control-allow-headers": "content-type" } });
        if (url.pathname === "/events" && request.method === "GET") return eventStream(runtime);
        if (url.pathname === "/api/health" && request.method === "GET") return json({ status: "ok", phase: 3, index: runtime.indexer.store.counts() });
        if (url.pathname === "/api/notes" && request.method === "GET") return json(runtime.listNotes(url.searchParams.get("prefix") ?? undefined, url.searchParams.get("tag") ?? undefined, numberParam(url, "limit")));
        if (url.pathname === "/api/note" && request.method === "GET") {
          const selector = url.searchParams.get("selector");
          if (!selector) throw new ServiceError("INVALID_INPUT", "Query parameter 'selector' is required.");
          return json(url.searchParams.get("source") === "true" ? runtime.getSource(selector) : runtime.getNote(selector));
        }
        if (url.pathname === "/api/section" && request.method === "GET") {
          const selector = url.searchParams.get("selector");
          if (!selector) throw new ServiceError("INVALID_INPUT", "Query parameter 'selector' is required.");
          return json(runtime.getSection(selector, url.searchParams.get("section_id") ?? undefined, url.searchParams.get("heading") ?? undefined));
        }
        if (url.pathname === "/api/search" && request.method === "GET") return json(runtime.search(url.searchParams.get("query") ?? "", numberParam(url, "limit")));
        if (url.pathname === "/api/project-map" && request.method === "GET") return json(runtime.projectMap(url.searchParams.get("node") ?? "project:root", numberParam(url, "depth"), numberParam(url, "limit")));
        if (url.pathname === "/api/graph" && request.method === "GET") {
          const node = url.searchParams.get("node");
          if (!node) throw new ServiceError("INVALID_INPUT", "Query parameter 'node' is required.");
          return json(runtime.graphQuery(node, (url.searchParams.get("direction") as "in" | "out" | "neighbors") ?? "neighbors", numberParam(url, "depth"), numberParam(url, "limit")));
        }
        if (url.pathname === "/api/context" && request.method === "GET") {
          const node = url.searchParams.get("node");
          if (!node) throw new ServiceError("INVALID_INPUT", "Query parameter 'node' is required.");
          return json(runtime.getContext(node, url.searchParams.get("task_hint") ?? undefined, numberParam(url, "limit")));
        }
        if (url.pathname === "/api/history" && request.method === "GET") {
          const selector = url.searchParams.get("selector");
          if (!selector) throw new ServiceError("INVALID_INPUT", "Query parameter 'selector' is required.");
          return json(runtime.history(selector, numberParam(url, "limit")));
        }
        if (url.pathname === "/api/diff" && request.method === "GET") {
          const selector = url.searchParams.get("selector");
          if (!selector) throw new ServiceError("INVALID_INPUT", "Query parameter 'selector' is required.");
          return json(runtime.diff(selector, url.searchParams.get("revision") ?? undefined));
        }
        if (url.pathname === "/api/vault-check" && request.method === "GET") return json(runtime.vaultCheck());
        if (url.pathname === "/api/workspace/status" && request.method === "GET") return json(runtime.workspaceStatus());
        if (url.pathname === "/api/workspace/repo-history" && request.method === "GET") {
          const repository = url.searchParams.get("repository");
          const path = url.searchParams.get("path");
          if (!repository || !path) throw new ServiceError("INVALID_INPUT", "Query parameters 'repository' and 'path' are required.");
          return json(runtime.getRepoHistory(repository, path, numberParam(url, "limit")));
        }
        if (url.pathname === "/api/workspace/repo-diff" && request.method === "GET") {
          const repository = url.searchParams.get("repository");
          const path = url.searchParams.get("path");
          if (!repository || !path) throw new ServiceError("INVALID_INPUT", "Query parameters 'repository' and 'path' are required.");
          return json(runtime.getRepoDiff(repository, path, url.searchParams.get("revision") ?? undefined));
        }
        if (url.pathname === "/api/workspace/repo-restore" && request.method === "POST") {
          const input = await body(request);
          return json(await runtime.restoreRepoPath(requiredString(input, "repository"), requiredString(input, "path"), requiredString(input, "revision"), input.confirm === true));
        }
        if (url.pathname === "/api/notes" && request.method === "POST") return json(await runtime.createNote(await body(request) as never), 201);
        if (url.pathname === "/api/section" && request.method === "PATCH") {
          const input = await body(request);
          return json(await runtime.patchSection(requiredString(input, "note"), requiredString(input, "section_id"), requiredString(input, "expected_revision"), requiredString(input, "new_content")));
        }
        if (url.pathname === "/api/note" && request.method === "PUT") {
          const input = await body(request);
          return json(await runtime.replaceNote(requiredString(input, "note"), requiredString(input, "expected_file_hash"), requiredString(input, "markdown")));
        }
        if (url.pathname === "/api/restore" && request.method === "POST") {
          const input = await body(request);
          return json(await runtime.restore(requiredString(input, "note"), requiredString(input, "revision")));
        }
        if (url.pathname === "/api/reconcile" && request.method === "POST") {
          const input = await body(request);
          const source = runtime.getSource(requiredString(input, "note"));
          const result = reconcileMarkdown(requiredString(input, "base_markdown"), requiredString(input, "local_markdown"), source.markdown);
          return json({ ...result, remote_markdown: source.markdown, remote_hash: source.note.content_hash });
        }
        if (uiDist && !url.pathname.startsWith("/api/")) {
          const response = staticResponse(uiDist, url.pathname);
          if (response) return response;
        }
        return new Response("Not found", { status: 404 });
      } catch (cause) {
        return errorResponse(cause);
      }
    },
  });
}
