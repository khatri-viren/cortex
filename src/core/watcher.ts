import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { RUNTIME_DIRECTORY } from "./vault.js";

type ParcelWatcher = typeof import("@parcel/watcher");

export type WatchEvent = {
  type: "create" | "update" | "delete";
  path: string;
};

export type WatcherHandle = {
  stop: () => Promise<void>;
  flushSnapshot: () => Promise<void>;
};

export type WatcherOptions = {
  /** Return true for a root-relative path that should be ignored and pruned. */
  ignorePath?: (relativePath: string) => boolean;
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

async function startPollingWatcher(
  vaultRoot: string,
  onEvents: (events: WatchEvent[]) => Promise<void>,
  options?: WatcherOptions,
): Promise<WatcherHandle> {
  const snapshotPath = join(vaultRoot, RUNTIME_DIRECTORY, "watcher.snapshot");
  mkdirSync(join(vaultRoot, RUNTIME_DIRECTORY), { recursive: true });
  let previous = fileSnapshot(vaultRoot, options);
  let pending: WatchEvent[] = [];
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const flush = async () => {
    if (pending.length === 0 || stopped) return;
    const events = pending;
    pending = [];
    await onEvents(events);
  };

  const queue = (events: WatchEvent[]) => {
    pending.push(...events.filter((event) => relevant(event, vaultRoot, options)));
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void flush(), 100);
  };

  const interval = setInterval(() => {
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
    if (events.length > 0) queue(events);
  }, 250);

  return {
    async stop() {
      clearInterval(interval);
      if (timer) clearTimeout(timer);
      await flush();
      stopped = true;
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
  if (process.env.CORTEX_PACKAGED === "1") {
    return startPollingWatcher(vaultRoot, onEvents, options);
  }

  const parcelWatcher: ParcelWatcher = await import("@parcel/watcher");
  const snapshotPath = join(vaultRoot, RUNTIME_DIRECTORY, "watcher.snapshot");
  mkdirSync(join(vaultRoot, RUNTIME_DIRECTORY), { recursive: true });
  let pending: WatchEvent[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const flush = async () => {
    if (pending.length === 0 || stopped) return;
    const events = pending;
    pending = [];
    await onEvents(events);
  };

  const queue = (events: WatchEvent[]) => {
    pending.push(...events.filter((event) => relevant(event, vaultRoot, options)));
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void flush(), 100);
  };

  if (existsSync(snapshotPath)) {
    const historical = await parcelWatcher.getEventsSince(vaultRoot, snapshotPath);
    queue(historical as WatchEvent[]);
  }

  const subscription = await parcelWatcher.subscribe(vaultRoot, (error, events) => {
    if (error) {
      console.error(`Filesystem watcher error: ${error.message}`);
      return;
    }
    queue(events as WatchEvent[]);
  });

  return {
    async stop() {
      if (timer) clearTimeout(timer);
      await flush();
      stopped = true;
      await subscription.unsubscribe();
    },
    async flushSnapshot() {
      await parcelWatcher.writeSnapshot(vaultRoot, snapshotPath);
    },
  };
}
