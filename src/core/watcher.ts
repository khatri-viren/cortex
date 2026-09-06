import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { RUNTIME_DIRECTORY } from "./vault.js";

type ParcelWatcher = typeof import("@parcel/watcher");

const DEFAULT_EVENT_FLUSH_DELAY_MS = 100;
export const DEFAULT_PACKAGED_POLL_INTERVAL_MS = 15_000;

export type WatchEvent = {
  type: "create" | "update" | "delete";
  path: string;
};

export type WatcherHandle = {
  mode: "native" | "polling";
  stop: () => Promise<void>;
  flushSnapshot: () => Promise<void>;
};

export type WatcherOptions = {
  /** Return true for a root-relative path that should be ignored and pruned. */
  ignorePath?: (relativePath: string) => boolean;
  /** Override the packaged polling interval for controlled callers and tests. */
  pollIntervalMs?: number;
  /** Stagger expensive fallback scans when several repository watchers start together. */
  pollStartDelayMs?: number;
  /** Internal recovery/test seam for exercising the polling adapter. */
  forcePolling?: boolean;
};

function ignored(relativePath: string, options?: WatcherOptions): boolean {
  return relativePath === RUNTIME_DIRECTORY || relativePath.startsWith(`${RUNTIME_DIRECTORY}/`) ||
    relativePath === ".git" || relativePath.startsWith(".git/") ||
    relativePath === "node_modules" || relativePath.startsWith("node_modules/") ||
    Boolean(options?.ignorePath?.(relativePath));
}

function relevant(event: WatchEvent, root: string, options?: WatcherOptions): boolean {
  const relativePath = relative(root, event.path).replaceAll("\\", "/");
  return !ignored(relativePath, options);
}

function fileSnapshot(root: string, options?: WatcherOptions): Map<string, string> {
  const snapshot = new Map<string, string>();
  const visit = (directory: string) => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const absolutePath = join(directory, entry.name);
      const relativePath = relative(root, absolutePath).replaceAll("\\", "/");
      if (ignored(relativePath, options)) continue;
      if (entry.isDirectory()) {
        visit(absolutePath);
        continue;
      }
      try {
        const stat = statSync(absolutePath);
        snapshot.set(relativePath, `${stat.mtimeMs}:${stat.size}`);
      } catch {
        // A file can disappear between readdir and stat; the next poll will
        // produce the authoritative state.
      }
    }
  };
  visit(root);
  return snapshot;
}

function createEventQueue(
  root: string,
  onEvents: (events: WatchEvent[]) => Promise<void>,
  options?: WatcherOptions,
): { queue: (events: WatchEvent[]) => void; stop: () => Promise<void> } {
  const pending = new Map<string, WatchEvent>();
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let flushing: Promise<void> | undefined;

  const flush = async (): Promise<void> => {
    if (flushing) return flushing;
    if (pending.size === 0) return;

    const current = (async () => {
      // Drain one batch at a time. A slow consumer must not be run in parallel
      // with the next poll, and repeated updates to one path only need the
      // newest event.
      while (pending.size > 0) {
        const events = [...pending.values()];
        pending.clear();
        await onEvents(events);
      }
    })();
    flushing = current;
    try {
      await current;
    } finally {
      if (flushing === current) flushing = undefined;
    }
  };

  const queue = (events: WatchEvent[]) => {
    if (stopped) return;
    for (const event of events) {
      if (relevant(event, root, options)) pending.set(event.path, event);
    }
    if (pending.size === 0) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      void flush().catch((error) => {
        console.error(`Filesystem watcher callback failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    }, DEFAULT_EVENT_FLUSH_DELAY_MS);
  };

  const stop = async () => {
    stopped = true;
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    await flush();
  };

  return { queue, stop };
}

async function startPollingWatcher(
  vaultRoot: string,
  onEvents: (events: WatchEvent[]) => Promise<void>,
  options?: WatcherOptions,
): Promise<WatcherHandle> {
  const snapshotPath = join(vaultRoot, RUNTIME_DIRECTORY, "watcher.snapshot");
  mkdirSync(join(vaultRoot, RUNTIME_DIRECTORY), { recursive: true });
  let previous = fileSnapshot(vaultRoot, options);
  const eventQueue = createEventQueue(vaultRoot, onEvents, options);

  const poll = () => {
    const current = fileSnapshot(vaultRoot, options);
    const events: WatchEvent[] = [];
    for (const [path, signature] of current) {
      const previousSignature = previous.get(path);
      if (!previousSignature) events.push({ type: "create", path: join(vaultRoot, path) });
      else if (previousSignature !== signature) events.push({ type: "update", path: join(vaultRoot, path) });
    }
    for (const path of previous.keys()) {
      if (!current.has(path)) events.push({ type: "delete", path: join(vaultRoot, path) });
    }
    previous = current;
    if (events.length > 0) eventQueue.queue(events);
  };
  let interval: ReturnType<typeof setInterval> | undefined;
  const startTimer = setTimeout(() => {
    interval = setInterval(poll, options?.pollIntervalMs ?? DEFAULT_PACKAGED_POLL_INTERVAL_MS);
  }, options?.pollStartDelayMs ?? 0);

  return {
    mode: "polling",
    async stop() {
      clearTimeout(startTimer);
      if (interval) clearInterval(interval);
      await eventQueue.stop();
    },
    async flushSnapshot() {
      writeFileSync(snapshotPath, JSON.stringify({ mode: "polling", files: [...previous] }));
    },
  };
}

export async function startWatcher(
  vaultRoot: string,
  onEvents: (events: WatchEvent[]) => Promise<void>,
  options?: WatcherOptions,
): Promise<WatcherHandle> {
  if (options?.forcePolling) return startPollingWatcher(vaultRoot, onEvents, options);
  let parcelWatcher: ParcelWatcher;
  try {
    parcelWatcher = await import("@parcel/watcher");
  } catch (error) {
    if (process.env.CORTEX_PACKAGED === "1") {
      console.error(`Native filesystem watcher unavailable; using bounded polling fallback: ${error instanceof Error ? error.message : String(error)}`);
      return startPollingWatcher(vaultRoot, onEvents, options);
    }
    throw error;
  }
  const snapshotPath = join(vaultRoot, RUNTIME_DIRECTORY, "watcher.snapshot");
  mkdirSync(join(vaultRoot, RUNTIME_DIRECTORY), { recursive: true });
  const eventQueue = createEventQueue(vaultRoot, onEvents, options);

  if (existsSync(snapshotPath)) {
    const historical = await parcelWatcher.getEventsSince(vaultRoot, snapshotPath);
    eventQueue.queue(historical as WatchEvent[]);
  }

  let subscription: Awaited<ReturnType<ParcelWatcher["subscribe"]>>;
  try {
    subscription = await parcelWatcher.subscribe(vaultRoot, (error, events) => {
      if (error) {
        console.error(`Filesystem watcher error: ${error.message}`);
        return;
      }
      eventQueue.queue(events as WatchEvent[]);
    });
  } catch (error) {
    await eventQueue.stop();
    // Packaged distributions prefer native notifications but retain polling
    // as an explicit recovery adapter when the native backend is unavailable.
    if (process.env.CORTEX_PACKAGED === "1") return startPollingWatcher(vaultRoot, onEvents, options);
    throw error;
  }

  return {
    mode: "native",
    async stop() {
      await eventQueue.stop();
      await subscription.unsubscribe();
    },
    async flushSnapshot() {
      await parcelWatcher.writeSnapshot(vaultRoot, snapshotPath);
    },
  };
}
