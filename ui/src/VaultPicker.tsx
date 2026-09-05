import { useEffect, useRef, useState } from "react";
import { invoke, type VaultEntry, type VaultRegistry } from "./vault-registry";
import { buildVaultUrl } from "./runtime";

type Preferences = {
  schemaVersion: number;
  openLastVault: boolean;
  showTrayIcon: boolean;
  minimizeToTray: boolean;
};

export function VaultPicker() {
  const [registry, setRegistry] = useState<VaultRegistry>();
  const [preferences, setPreferences] = useState<Preferences>();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("Loading vaults…");
  const [preferencesOpen, setPreferencesOpen] = useState(false);
  const [openLastVault, setOpenLastVault] = useState(true);
  const [showTrayIcon, setShowTrayIcon] = useState(true);
  const bootstrapped = useRef(false);

  async function openVault(id: string) {
    setBusy(true);
    setStatus("Starting vault runtime…");
    try {
      const opened = await invoke<{ port: number; vaultId: string }>("open_vault", { id });
      window.location.href = buildVaultUrl(window.location.origin, opened.vaultId, opened.port);
    } catch (cause) {
      setStatus(String(cause));
      setBusy(false);
    }
  }

  async function load() {
    try {
      const [nextRegistry, nextPreferences] = await Promise.all([
        invoke<VaultRegistry>("list_vaults"),
        invoke<Preferences>("get_preferences"),
      ]);
      setRegistry(nextRegistry);
      setPreferences(nextPreferences);
      setOpenLastVault(nextPreferences.openLastVault);
      setShowTrayIcon(nextPreferences.showTrayIcon);
      if (nextPreferences.openLastVault && nextRegistry.activeVaultId && nextRegistry.vaults.some((vault) => vault.id === nextRegistry.activeVaultId)) {
        await openVault(nextRegistry.activeVaultId);
      } else {
        setStatus("");
      }
    } catch (cause) {
      setStatus(`Could not load Cortex preferences: ${String(cause)}`);
    }
  }

  useEffect(() => {
    if (bootstrapped.current) return;
    bootstrapped.current = true;
    void load();
  }, []);

  async function addVault() {
    setBusy(true);
    setStatus("");
    try {
      const entry = await invoke<VaultEntry | null>("add_vault_via_dialog");
      if (entry) await openVault(entry.id);
      else setBusy(false);
    } catch (cause) {
      setStatus(String(cause));
      setBusy(false);
    }
  }

  async function removeVault(id: string) {
    setBusy(true);
    try {
      await invoke("remove_vault", { id });
      setRegistry((current) => current && { ...current, vaults: current.vaults.filter((vault) => vault.id !== id) });
      setStatus("");
    } catch (cause) {
      setStatus(String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function revealVault(id: string) {
    try {
      await invoke("reveal_vault", { id });
    } catch (cause) {
      setStatus(String(cause));
    }
  }

  async function savePreferences() {
    if (!preferences) return;
    setBusy(true);
    try {
      const saved = await invoke<Preferences>("set_preferences", {
        preferences: { ...preferences, openLastVault, showTrayIcon },
      });
      setPreferences(saved);
      setPreferencesOpen(false);
      setStatus("Preferences saved");
    } catch (cause) {
      setStatus(String(cause));
    } finally {
      setBusy(false);
    }
  }

  const vaults = registry?.vaults ?? [];
  return (
    <main className="cortex-dev-picker">
      <section className="cortex-dev-picker-card" aria-busy={busy}>
        <h1>Cortex</h1>
        <p className="cortex-dev-picker-hint">Choose a vault to open, or add a new one.</p>
        {vaults.length === 0 ? (
          <p className="cortex-dev-picker-empty">No vaults registered yet.</p>
        ) : (
          <ul className="cortex-dev-picker-list">
            {vaults.map((vault) => (
              <li key={vault.id} className="cortex-dev-picker-row">
                <button className="cortex-dev-picker-open" disabled={busy} onClick={() => void openVault(vault.id)}>
                  <span className="cortex-dev-picker-name">{vault.name}</span>
                  <span className="cortex-dev-picker-path">{vault.path}</span>
                </button>
                <span className="cortex-dev-picker-actions">
                  <button disabled={busy} onClick={() => void revealVault(vault.id)}>Reveal</button>
                  <button disabled={busy} onClick={() => void removeVault(vault.id)}>Remove</button>
                </span>
              </li>
            ))}
          </ul>
        )}
        <div className="cortex-dev-picker-toolbar">
          <button className="cortex-dev-picker-primary" disabled={busy} onClick={() => void addVault()}>Add vault…</button>
          <button disabled={busy} onClick={() => setPreferencesOpen((current) => !current)}>Preferences</button>
        </div>
        {preferencesOpen && preferences && (
          <section className="cortex-dev-picker-preferences" aria-label="Preferences">
            <strong>Preferences</strong>
            <label><input type="checkbox" checked={openLastVault} onChange={(event) => setOpenLastVault(event.target.checked)} /> Open the last active vault on startup.</label>
            <label><input type="checkbox" checked={showTrayIcon} onChange={(event) => setShowTrayIcon(event.target.checked)} /> Show Cortex in the menu bar.</label>
            <div className="cortex-dev-picker-preference-actions">
              <button onClick={() => setPreferencesOpen(false)}>Cancel</button>
              <button className="cortex-dev-picker-primary" disabled={busy} onClick={() => void savePreferences()}>Save</button>
            </div>
          </section>
        )}
        <div className="cortex-dev-picker-status" role="status">{status}</div>
      </section>
    </main>
  );
}
