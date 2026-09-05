use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

pub const PREFERENCES_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AppPreferences {
    pub schema_version: u32,
    pub open_last_vault: bool,
    pub show_tray_icon: bool,
    pub minimize_to_tray: bool,
}

impl Default for AppPreferences {
    fn default() -> Self {
        Self {
            schema_version: PREFERENCES_SCHEMA_VERSION,
            open_last_vault: true,
            show_tray_icon: true,
            minimize_to_tray: false,
        }
    }
}

fn preferences_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Could not resolve app data dir: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("preferences.json"))
}

pub fn load_from(path: &Path) -> Result<AppPreferences, String> {
    if !path.exists() {
        return Ok(AppPreferences::default());
    }
    let raw = fs::read_to_string(path).map_err(|e| e.to_string())?;
    let preferences: AppPreferences =
        serde_json::from_str(&raw).map_err(|e| format!("Corrupt Cortex preferences: {e}"))?;
    if preferences.schema_version != PREFERENCES_SCHEMA_VERSION {
        return Err(format!(
            "Unsupported Cortex preferences schema version {}",
            preferences.schema_version
        ));
    }
    Ok(preferences)
}

pub fn save_to(path: &Path, preferences: &AppPreferences) -> Result<(), String> {
    let raw = serde_json::to_string_pretty(preferences).map_err(|e| e.to_string())?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let tmp_path = path.with_extension("json.tmp");
    fs::write(&tmp_path, raw).map_err(|e| e.to_string())?;
    fs::rename(&tmp_path, path).map_err(|e| e.to_string())
}

pub fn load(app: &AppHandle) -> Result<AppPreferences, String> {
    load_from(&preferences_path(app)?)
}

pub fn save(app: &AppHandle, preferences: &AppPreferences) -> Result<(), String> {
    save_to(&preferences_path(app)?, preferences)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_preferences_use_safe_defaults() {
        let dir =
            std::env::temp_dir().join(format!("cortex-preferences-test-{}", uuid::Uuid::new_v4()));
        let preferences =
            load_from(&dir.join("preferences.json")).expect("missing preferences should default");
        assert_eq!(preferences, AppPreferences::default());
    }

    #[test]
    fn preferences_roundtrip_atomically() {
        let dir =
            std::env::temp_dir().join(format!("cortex-preferences-test-{}", uuid::Uuid::new_v4()));
        let path = dir.join("preferences.json");
        let preferences = AppPreferences {
            open_last_vault: false,
            show_tray_icon: false,
            minimize_to_tray: true,
            ..AppPreferences::default()
        };

        save_to(&path, &preferences).expect("preferences should save");
        assert_eq!(
            load_from(&path).expect("preferences should load"),
            preferences
        );
        assert!(!path.with_extension("json.tmp").exists());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn corrupt_or_unknown_preferences_fail_closed() {
        let dir =
            std::env::temp_dir().join(format!("cortex-preferences-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("preferences.json");
        fs::write(&path, b"{ not valid json").unwrap();
        assert!(load_from(&path).is_err());
        fs::write(&path, br#"{"schemaVersion":99,"openLastVault":true,"showTrayIcon":true,"minimizeToTray":false}"#).unwrap();
        assert!(load_from(&path).is_err());
        fs::remove_dir_all(&dir).ok();
    }
}
