mod sidecar;
mod vault_registry;

use serde::Serialize;
use std::process::Child;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Manager, RunEvent, State};
use tauri_plugin_dialog::DialogExt;

use sidecar::SidecarHandle;
use vault_registry::{VaultRegistry, VaultRegistryEntry};

struct AppState {
    registry: Mutex<VaultRegistry>,
    sidecar: Mutex<Option<SidecarHandle>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OpenedVault {
    port: u16,
    vault_id: String,
}

fn find_entry(registry: &VaultRegistry, id: &str) -> Result<VaultRegistryEntry, String> {
    registry
        .vaults
        .iter()
        .find(|v| v.id == id)
        .cloned()
        .ok_or_else(|| format!("No registered vault with id {id}"))
}

/// Dispose whatever sidecar is currently running, regardless of which vault
/// it belongs to. Called before starting a new one so at most one vault
/// runtime is ever live in this window at a time (V2 baseline: one active
/// vault per window).
fn dispose_current_sidecar(state: &AppState) {
    let mut guard = state.sidecar.lock().expect("sidecar lock poisoned");
    if let Some(mut handle) = guard.take() {
        sidecar::dispose(&mut handle);
    }
}

#[tauri::command]
fn list_vaults(state: State<'_, AppState>) -> Result<VaultRegistry, String> {
    let guard = state
        .registry
        .lock()
        .map_err(|_| "registry lock poisoned".to_string())?;
    Ok(guard.clone())
}

#[tauri::command]
async fn add_vault_via_dialog(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Option<VaultRegistryEntry>, String> {
    let app_for_dialog = app.clone();
    let folder = tauri::async_runtime::spawn_blocking(move || {
        app_for_dialog.dialog().file().blocking_pick_folder()
    })
    .await
    .map_err(|e| e.to_string())?;

    let Some(folder) = folder else {
        return Ok(None);
    };
    let path = folder
        .into_path()
        .map_err(|e| format!("Invalid folder selection: {e}"))?;
    let path_str = path.to_string_lossy().to_string();

    let mut registry = state
        .registry
        .lock()
        .map_err(|_| "registry lock poisoned".to_string())?;
    if let Some(existing) = registry.vaults.iter().find(|v| v.path == path_str) {
        return Ok(Some(existing.clone()));
    }

    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| path_str.clone());

    let entry = VaultRegistryEntry {
        id: uuid::Uuid::new_v4().to_string(),
        path: path_str,
        name,
        added_at: chrono::Utc::now().to_rfc3339(),
        last_opened_at: None,
        last_opened_note_id: None,
        note_count_cache: None,
        repository_count_cache: None,
        index_health_cache: None,
    };
    registry.vaults.push(entry.clone());
    vault_registry::save(&app, &registry)?;
    Ok(Some(entry))
}

#[tauri::command]
fn remove_vault(app: AppHandle, state: State<'_, AppState>, id: String) -> Result<(), String> {
    let mut registry = state
        .registry
        .lock()
        .map_err(|_| "registry lock poisoned".to_string())?;
    registry.vaults.retain(|v| v.id != id);
    let was_active = registry.active_vault_id.as_deref() == Some(id.as_str());
    if was_active {
        registry.active_vault_id = None;
    }
    vault_registry::save(&app, &registry)?;
    drop(registry);
    if was_active {
        dispose_current_sidecar(&state);
    }
    Ok(())
}

#[tauri::command]
fn reveal_vault(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let registry = state
        .registry
        .lock()
        .map_err(|_| "registry lock poisoned".to_string())?;
    let entry = find_entry(&registry, &id)?;
    drop(registry);
    // macOS only for the V2 target (see "Desktop V2 Decisions", item 5).
    std::process::Command::new("open")
        .arg(&entry.path)
        .status()
        .map_err(|e| format!("Failed to reveal vault in Finder: {e}"))?;
    Ok(())
}

#[tauri::command]
async fn open_vault(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<OpenedVault, String> {
    let entry = {
        let registry = state
            .registry
            .lock()
            .map_err(|_| "registry lock poisoned".to_string())?;
        find_entry(&registry, &id)?
    };

    // Switching vaults: dispose whatever is currently running first so the
    // previous vault's watchers, DB handles, and in-memory graph state can
    // never leak into the new one (D2-09).
    dispose_current_sidecar(&state);

    let vault_path = entry.path.clone();
    let spawn_result = tauri::async_runtime::spawn_blocking(
        move || -> Result<(Child, u16, serde_json::Value), String> {
            let port = sidecar::find_free_port()?;
            let child = sidecar::spawn(&vault_path, port)?;
            match sidecar::wait_for_health(port, Duration::from_secs(20)) {
                Ok(health) => Ok((child, port, health)),
                Err(e) => {
                    let mut handle = SidecarHandle {
                        child,
                        port,
                        vault_id: String::new(),
                    };
                    sidecar::dispose(&mut handle);
                    Err(e)
                }
            }
        },
    )
    .await
    .map_err(|e| e.to_string())?;

    let (child, port, health) = spawn_result?;
    let vault_id = entry.id.clone();

    {
        let mut sidecar_guard = state
            .sidecar
            .lock()
            .map_err(|_| "sidecar lock poisoned".to_string())?;
        *sidecar_guard = Some(SidecarHandle {
            child,
            port,
            vault_id: vault_id.clone(),
        });
    }
    log::info!("Vault {vault_id} healthy on port {port}");

    {
        let mut registry = state
            .registry
            .lock()
            .map_err(|_| "registry lock poisoned".to_string())?;
        registry.active_vault_id = Some(vault_id.clone());
        if let Some(e) = registry.vaults.iter_mut().find(|v| v.id == vault_id) {
            e.last_opened_at = Some(chrono::Utc::now().to_rfc3339());
            if let Some(counts) = health.get("index") {
                e.note_count_cache = counts.get("noteCount").and_then(|v| v.as_u64());
                e.index_health_cache = Some("current".to_string());
            }
        }
        vault_registry::save(&app, &registry)?;
    }

    Ok(OpenedVault { port, vault_id })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            let registry = vault_registry::load(&app.handle())
                .map_err(|e| format!("Failed to load vault registry: {e}"))?;
            app.manage(AppState {
                registry: Mutex::new(registry),
                sidecar: Mutex::new(None),
            });

            // A window-driven quit (Cmd+Q, red button) already reaches
            // RunEvent::Exit below and disposes the sidecar. But Force Quit
            // (Activity Monitor), `kill`, and logout/shutdown all deliver a
            // raw SIGTERM/SIGINT to this process directly, bypassing the
            // window event loop entirely — without this handler that orphans
            // the bun sidecar. Route those signals through the same
            // AppHandle::exit path so both roads dispose identically.
            let signal_app_handle = app.handle().clone();
            ctrlc::set_handler(move || {
                signal_app_handle.exit(0);
            })
            .expect("failed to install SIGTERM/SIGINT handler");

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_vaults,
            add_vault_via_dialog,
            remove_vault,
            reveal_vault,
            open_vault,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // Clean shutdown: make sure the sidecar process never outlives
            // the window it was started for.
            if let RunEvent::ExitRequested { .. } | RunEvent::Exit = event {
                if let Some(state) = app_handle.try_state::<AppState>() {
                    dispose_current_sidecar(&state);
                }
            }
        });
}
