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

/** Return the sidecar origin selected by the active vault's query string. */
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

/**
 * Keep the UI on its current origin and use `port` only as the API transport.
 * This is important for packaged Tauri windows: navigating to the sidecar's
 * dynamic localhost origin would turn the page into an untrusted remote
 * origin and block native commands through Tauri's ACL.
 */
export function buildVaultUrl(origin: string, vaultId: string, port: number): string {
  const url = new URL("/", origin);
  url.searchParams.set("vault", vaultId);
  url.searchParams.set("port", String(port));
  return url.toString();
}
