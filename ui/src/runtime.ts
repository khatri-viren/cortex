const LOCALHOST = "127.0.0.1";

export type RuntimeConnection = {
  origin: string;
  request: (path: string, init?: RequestInit) => Promise<Response>;
  events: (path: string) => EventSource;
};

function validPort(value: string | null): number | undefined {
  if (!value || !/^\d+$/.test(value)) return undefined;
  const port = Number(value);
  return port >= 1 && port <= 65_535 ? port : undefined;
}

/**
 * Return the sidecar origin selected by the Tauri dev vault picker.
 *
 * Production vault pages intentionally omit `port` and continue using
 * relative API URLs, because they are served by the sidecar itself. Browser
 * development also omits it and therefore keeps using the Vite `/api`
 * proxy.
 */
export function getApiOrigin(search: string): string {
  const port = validPort(new URLSearchParams(search).get("port"));
  return port ? `http://${LOCALHOST}:${port}` : "";
}

let cachedConnection: { search: string; value: RuntimeConnection } | undefined;

/**
 * Resolve one stable transport contract for the active desktop vault. Page
 * navigation changes the query string when a vault changes, so a new page
 * gets a new connection; every request within that page shares this origin.
 */
export function getRuntimeConnection(search = typeof window === "undefined" ? "" : window.location.search): RuntimeConnection {
  if (cachedConnection?.search === search) return cachedConnection.value;
  const origin = getApiOrigin(search);
  const value: RuntimeConnection = {
    origin,
    request: (path, init) => fetch(origin + path, init),
    events: (path) => new EventSource(origin + path),
  };
  cachedConnection = { search, value };
  return value;
}

/** Build a Vite-origin URL for a vault runtime started by Tauri. */
export function buildVaultUrl(origin: string, vaultId: string, port: number): string {
  // The Vite development shell is the stable app origin. A packaged app is
  // initially served by the picker sidecar, so switching vaults must target
  // the newly healthy sidecar instead of reloading the stopped origin.
  const current = new URL(origin);
  const targetOrigin = current.port === "5175" ? current.origin : `http://${LOCALHOST}:${port}`;
  const url = new URL("/", targetOrigin);
  url.searchParams.set("vault", vaultId);
  url.searchParams.set("port", String(port));
  return url.toString();
}
