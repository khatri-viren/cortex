use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultRegistryEntry {
    pub id: String,
    pub path: String,
    pub name: String,
    pub added_at: String,
    pub last_opened_at: Option<String>,
    pub last_opened_note_id: Option<String>,
    // Advisory only — refreshed from the vault's own runtime after a
    // successful open, never trusted at launch. See "Desktop V2 Multi-Vault
    // UX Contract" (D2-04) for why these aren't authoritative.
    pub note_count_cache: Option<u64>,
    pub repository_count_cache: Option<u64>,
    pub index_health_cache: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultRegistry {
    pub schema_version: u32,
    pub active_vault_id: Option<String>,
    pub vaults: Vec<VaultRegistryEntry>,
}

impl Default for VaultRegistry {
    fn default() -> Self {
        Self {
            schema_version: 1,
            active_vault_id: None,
            vaults: Vec::new(),
        }
    }
}

fn registry_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Could not resolve app data dir: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("vault-registry.json"))
}

/// Pure, AppHandle-free load/save so the registry's actual logic (defaulting
/// on missing file, corrupt-JSON handling, atomic write) is unit-testable
/// without needing a live Tauri app context.
pub fn load_from(path: &Path) -> Result<VaultRegistry, String> {
    if !path.exists() {
        return Ok(VaultRegistry::default());
    }
    let raw = fs::read_to_string(path).map_err(|e| e.to_string())?;
    serde_json::from_str(&raw).map_err(|e| format!("Corrupt vault registry: {e}"))
}

pub fn save_to(path: &Path, registry: &VaultRegistry) -> Result<(), String> {
    let raw = serde_json::to_string_pretty(registry).map_err(|e| e.to_string())?;
    // Write to a temp file then rename, so a crash mid-write never leaves a
    // truncated/corrupt registry behind (this file is the only cross-vault
    // state that isn't rebuildable from a vault's own Markdown/.cortex).
    let tmp_path = path.with_extension("json.tmp");
    fs::write(&tmp_path, raw).map_err(|e| e.to_string())?;
    fs::rename(&tmp_path, path).map_err(|e| e.to_string())
}

pub fn load(app: &AppHandle) -> Result<VaultRegistry, String> {
    load_from(&registry_path(app)?)
}

pub fn save(app: &AppHandle, registry: &VaultRegistry) -> Result<(), String> {
    save_to(&registry_path(app)?, registry)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_entry(id: &str) -> VaultRegistryEntry {
        VaultRegistryEntry {
            id: id.to_string(),
            path: format!("/tmp/vault-{id}"),
            name: format!("Vault {id}"),
            added_at: "2026-08-13T00:00:00Z".to_string(),
            last_opened_at: None,
            last_opened_note_id: None,
            note_count_cache: None,
            repository_count_cache: None,
            index_health_cache: None,
        }
    }

    #[test]
    fn load_from_missing_file_returns_default() {
        let dir = std::env::temp_dir().join(format!("cortex-registry-test-{}", uuid::Uuid::new_v4()));
        let path = dir.join("vault-registry.json");
        let registry = load_from(&path).expect("missing file should default, not error");
        assert_eq!(registry.schema_version, 1);
        assert!(registry.vaults.is_empty());
        assert!(registry.active_vault_id.is_none());
    }

    #[test]
    fn save_then_load_roundtrips() {
        let dir = std::env::temp_dir().join(format!("cortex-registry-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("vault-registry.json");

        let mut registry = VaultRegistry::default();
        registry.vaults.push(sample_entry("a"));
        registry.vaults.push(sample_entry("b"));
        registry.active_vault_id = Some("a".to_string());

        save_to(&path, &registry).expect("save should succeed");
        let loaded = load_from(&path).expect("load should succeed");

        assert_eq!(loaded.vaults.len(), 2);
        assert_eq!(loaded.active_vault_id.as_deref(), Some("a"));
        assert_eq!(loaded.vaults[0].name, "Vault a");

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn save_leaves_no_tmp_file_behind() {
        let dir = std::env::temp_dir().join(format!("cortex-registry-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("vault-registry.json");

        save_to(&path, &VaultRegistry::default()).unwrap();

        assert!(path.exists());
        assert!(!path.with_extension("json.tmp").exists());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn load_from_corrupt_json_errors_instead_of_panicking() {
        let dir = std::env::temp_dir().join(format!("cortex-registry-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("vault-registry.json");
        fs::write(&path, b"{ not valid json").unwrap();

        let result = load_from(&path);
        assert!(result.is_err());
        fs::remove_dir_all(&dir).ok();
    }
}
