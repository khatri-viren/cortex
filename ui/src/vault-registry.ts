import { buildVaultUrl } from "./runtime";

export type TauriInvoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
export type VaultEntry = {
  id: string;
  name: string;
  path: string;
};
export type VaultRegistry = {
  activeVaultId: string | null;
  vaults: VaultEntry[];
};
export type OpenedVault = { port: number; vaultId: string };

type TauriWindow = Window & { __TAURI__?: { core?: { invoke?: TauriInvoke } } };

export function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const nativeInvoke = (window as TauriWindow).__TAURI__?.core?.invoke;
  if (!nativeInvoke) return Promise.reject(new Error("Cortex native commands are unavailable."));
  return nativeInvoke<T>(command, args);
}

export async function closeMainWindow(): Promise<void> {
  if (typeof window === "undefined") return;
  const nativeInvoke = (window as TauriWindow).__TAURI__?.core?.invoke;
  if (nativeInvoke) {
    await nativeInvoke("close_main_window");
    return;
  }
  window.close();
}

export async function openRegisteredVault(id: string): Promise<void> {
  const opened = await invoke<OpenedVault>("open_vault", { id });
  window.location.href = buildVaultUrl(window.location.origin, opened.vaultId, opened.port);
}
