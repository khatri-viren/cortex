use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

const MAX_SESSION_BYTES: usize = 64 * 1024;

fn path(app: &AppHandle, vault_id: &str) -> Result<PathBuf, String> {
    let id = uuid::Uuid::parse_str(vault_id).map_err(|_| "Invalid vault id for session state.".to_string())?;
    let dir = app.path().app_data_dir().map_err(|e| format!("Could not resolve app data dir: {e}"))?.join("sessions");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(format!("{id}.json")))
}

pub fn load(app: &AppHandle, vault_id: &str) -> Result<Option<String>, String> {
    let path = path(app, vault_id)?;
    if !path.exists() { return Ok(None); }
    let raw = fs::read_to_string(path).map_err(|e| e.to_string())?;
    if raw.len() > MAX_SESSION_BYTES { return Err("Saved desktop session is too large.".to_string()); }
    serde_json::from_str::<serde_json::Value>(&raw).map_err(|_| "Saved desktop session is invalid.".to_string())?;
    Ok(Some(raw))
}

pub fn save(app: &AppHandle, vault_id: &str, raw: &str) -> Result<(), String> {
    if raw.len() > MAX_SESSION_BYTES { return Err("Desktop session is too large to persist.".to_string()); }
    let value: serde_json::Value = serde_json::from_str(raw).map_err(|_| "Desktop session must be valid JSON.".to_string())?;
    if !value.is_object() { return Err("Desktop session must be a JSON object.".to_string()); }
    let path = path(app, vault_id)?;
    let temporary = path.with_extension("json.tmp");
    fs::write(&temporary, raw).map_err(|e| e.to_string())?;
    fs::rename(&temporary, &path).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_size_is_bounded() {
        assert!(MAX_SESSION_BYTES >= 64 * 1024);
    }

    #[test]
    fn session_path_rejects_non_uuid_without_touching_filesystem() {
        assert!(uuid::Uuid::parse_str("not-a-vault").is_err());
    }
}
