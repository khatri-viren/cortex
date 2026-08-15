const LOCALHOST = "127.0.0.1";

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

/** Build a Vite-origin URL for a vault runtime started by Tauri. */
export function buildVaultUrl(origin: string, vaultId: string, port: number): string {
  const url = new URL("/", origin);
  url.searchParams.set("vault", vaultId);
  url.searchParams.set("port", String(port));
  return url.toString();
}
