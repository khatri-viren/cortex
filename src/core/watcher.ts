import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import * as parcelWatcher from "@parcel/watcher";
import { RUNTIME_DIRECTORY } from "./vault.js";

export type WatchEvent = {
  type: "create" | "update" | "delete";
  path: string;
};

export type WatcherHandle = {
  stop: () => Promise<void>;
  flushSnapshot: () => Promise<void>;
};

function relevant(event: WatchEvent, root: string): boolean {
  const relativePath = event.path.slice(root.length).replace(/^[/\\]/, "");
  return !relativePath.startsWith(`${RUNTIME_DIRECTORY}/`) && !relativePath.startsWith(".git/") && !relativePath.startsWith("node_modules/");
}

export async function startWatcher(
  vaultRoot: string,
  onEvents: (events: WatchEvent[]) => Promise<void>,
): Promise<WatcherHandle> {
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
    pending.push(...events.filter((event) => relevant(event, vaultRoot)));
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
