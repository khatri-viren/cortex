mod preferences;
mod sidecar;
mod vault_registry;

use serde::Serialize;
use std::path::Path;
use std::process::Child;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;
use tauri::menu::{MenuBuilder, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, RunEvent, State, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

use preferences::AppPreferences;
use sidecar::{RuntimeRegistry, SidecarHandle};
use vault_registry::{VaultRegistry, VaultRegistryEntry};

struct AppState {
    registry: Mutex<VaultRegistry>,
    runtimes: Mutex<RuntimeRegistry>,
    preferences: Mutex<AppPreferences>,
    shutdown_started: AtomicBool,
    open_generation: AtomicU64,
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

#[cfg(test)]
mod pdf_export_tests {
    use super::sanitize_pdf_filename;

    #[test]
    fn pdf_filename_is_a_safe_basename_with_pdf_extension() {
        assert_eq!(sanitize_pdf_filename("../My: Note"), "My-Note.pdf");
        assert_eq!(sanitize_pdf_filename("already.pdf"), "already.pdf");
        assert_eq!(sanitize_pdf_filename(""), "untitled-note.pdf");
    }
}

fn sanitize_pdf_filename(input: &str) -> String {
    let basename = Path::new(input)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(input);
    let mut result = String::new();
    let mut previous_was_separator = false;

    for character in basename.chars() {
        let allowed = character.is_alphanumeric() || matches!(character, '.' | '-' | '_');
        if allowed {
            result.push(character);
            previous_was_separator = character == '-';
        } else if !previous_was_separator {
            result.push('-');
            previous_was_separator = true;
        }
    }

    let result = result.trim_matches(['.', '-', '_']).to_string();
    let mut result = if result.is_empty() {
        "untitled-note".to_string()
    } else {
        result
    };
    if !result.to_ascii_lowercase().ends_with(".pdf") {
        result.push_str(".pdf");
    }
    result
}

#[tauri::command]
async fn save_pdf(
    app: AppHandle,
    filename: String,
    bytes: Vec<u8>,
) -> Result<Option<String>, String> {
    log::info!("[PDF-EXPORT] native:invoke filename={} bytes={}", filename, bytes.len());
    let filename = sanitize_pdf_filename(&filename);
    let app_for_dialog = app.clone();
    let selected_path = tauri::async_runtime::spawn_blocking(move || {
        app_for_dialog
            .dialog()
            .file()
            .set_file_name(filename)
            .add_filter("PDF document", &["pdf"])
            .blocking_save_file()
    })
    .await
    .map_err(|error| {
        log::error!("[PDF-EXPORT] native:dialog-join-failed error={error}");
        format!("Failed to open the PDF save dialog: {error}")
    })?;

    let Some(selected_path) = selected_path else {
        log::info!("[PDF-EXPORT] native:cancelled");
        return Ok(None);
    };
    let path = selected_path
        .into_path()
        .map_err(|error| {
            log::error!("[PDF-EXPORT] native:invalid-destination error={error}");
            format!("Invalid PDF destination: {error}")
        })?;
    log::info!("[PDF-EXPORT] native:selected path={}", path.display());
    std::fs::write(&path, bytes).map_err(|error| {
        log::error!("[PDF-EXPORT] native:write-failed path={} error={error}", path.display());
        format!("Could not save PDF: {error}")
    })?;
    log::info!("[PDF-EXPORT] native:complete path={}", path.display());
    Ok(Some(path.to_string_lossy().into_owned()))
}

/// Dispose whatever sidecar is currently running, regardless of which vault
/// it belongs to. Called before starting a new one so at most one vault
/// runtime is ever live in this window at a time (V2 baseline: one active
/// vault per window).
fn dispose_current_sidecar(state: &AppState, window_label: &str) {
    let mut runtimes = state.runtimes.lock().expect("runtime lock poisoned");
    runtimes.dispose_window(&sidecar::window_runtime_key(window_label));
}

fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[tauri::command]
fn get_preferences(state: State<'_, AppState>) -> Result<AppPreferences, String> {
    state
        .preferences
        .lock()
        .map(|preferences| preferences.clone())
        .map_err(|_| "preferences lock poisoned".to_string())
}

#[tauri::command]
fn set_preferences(
    app: AppHandle,
    state: State<'_, AppState>,
    preferences: AppPreferences,
) -> Result<AppPreferences, String> {
    if preferences.schema_version != preferences::PREFERENCES_SCHEMA_VERSION {
        return Err("Unsupported Cortex preferences schema version".to_string());
    }
    preferences::save(&app, &preferences)?;
    if let Some(tray) = app.tray_by_id("cortex-tray") {
        tray.set_visible(preferences.show_tray_icon)
            .map_err(|e| format!("Could not update tray visibility: {e}"))?;
    }
    *state
        .preferences
        .lock()
        .map_err(|_| "preferences lock poisoned".to_string())? = preferences.clone();
    Ok(preferences)
}

#[tauri::command]
fn close_main_window(window: WebviewWindow, state: State<'_, AppState>) -> Result<(), String> {
    dispose_current_sidecar(&state, window.label());
    window
        .close()
        .map_err(|error| format!("Failed to close the main window: {error}"))
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
    state
        .runtimes
        .lock()
        .map_err(|_| "runtime lock poisoned".to_string())?
        .dispose_vault(&id);
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
    window: WebviewWindow,
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

    if state.shutdown_started.load(Ordering::Acquire) {
        return Err("Cortex is shutting down.".to_string());
    }
    let open_generation = state.open_generation.fetch_add(1, Ordering::AcqRel) + 1;

    // Switching vaults: dispose whatever is currently running first so the
    // previous vault's watchers, DB handles, and in-memory graph state can
    // never leak into the new one (D2-09).
    let window_label = sidecar::window_runtime_key(window.label());
    dispose_current_sidecar(&state, &window_label);

    let vault_path = entry.path.clone();
    let resource_dir = if cfg!(debug_assertions) {
        None
    } else {
        Some(
            app.path()
                .resource_dir()
                .map_err(|e| format!("Failed to resolve the packaged resource directory: {e}"))?,
        )
    };
    let spawn_result = tauri::async_runtime::spawn_blocking(
        move || -> Result<(Child, u16, serde_json::Value), String> {
            let port = sidecar::find_free_port()?;
            let mut child = sidecar::spawn(&vault_path, port, resource_dir.as_deref())?;
            match sidecar::wait_for_health(
                &mut child,
                port,
                Duration::from_secs(sidecar::DEFAULT_STARTUP_TIMEOUT_SECS),
            ) {
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

    let mut handle = Some(SidecarHandle {
        child,
        port,
        vault_id: vault_id.clone(),
    });
    let inserted = {
        let mut runtimes = match state.runtimes.lock() {
            Ok(runtimes) => runtimes,
            Err(_) => {
                if let Some(mut handle) = handle.take() {
                    sidecar::dispose(&mut handle);
                }
                return Err("runtime lock poisoned".to_string());
            }
        };
        if state.shutdown_started.load(Ordering::Acquire)
            || state.open_generation.load(Ordering::Acquire) != open_generation
        {
            false
        } else {
            runtimes.insert(&window_label, match handle.take() {
                Some(handle) => handle,
                None => unreachable!("sidecar handle was already consumed"),
            });
            true
        }
    };
    if !inserted {
        // The app may have begun shutting down, or another open request may
        // have superseded this one while the sidecar was starting. Since this
        // child was not inserted into the registry, dispose it here instead
        // of allowing it to become an orphan.
        if let Some(mut handle) = handle {
            sidecar::dispose(&mut handle);
        }
        return Err(if state.shutdown_started.load(Ordering::Acquire) {
            "Cortex is shutting down.".to_string()
        } else {
            "Vault open was superseded by a newer request.".to_string()
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
            let preferences = preferences::load(&app.handle())
                .map_err(|e| format!("Failed to load Cortex preferences: {e}"))?;
            app.manage(AppState {
                registry: Mutex::new(registry),
                runtimes: Mutex::new(RuntimeRegistry::default()),
                preferences: Mutex::new(preferences.clone()),
                shutdown_started: AtomicBool::new(false),
                open_generation: AtomicU64::new(0),
            });

            if preferences.show_tray_icon {
                let show = MenuItem::with_id(app, "show", "Show Cortex", true, None::<&str>)?;
                let quit = MenuItem::with_id(app, "quit", "Quit Cortex", true, None::<&str>)?;
                let menu = MenuBuilder::new(app).items(&[&show, &quit]).build()?;
                let mut tray = TrayIconBuilder::with_id("cortex-tray")
                    .menu(&menu)
                    .tooltip("Cortex")
                    .show_menu_on_left_click(true)
                    .on_menu_event(|app, event| match event.id.as_ref() {
                        "show" => show_main_window(app),
                        "quit" => app.exit(0),
                        _ => {}
                    });
                if let Some(icon) = app.default_window_icon().cloned() {
                    tray = tray.icon(icon).icon_as_template(true);
                }
                tray.build(app)?;
            }

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
            get_preferences,
            set_preferences,
            close_main_window,
            save_pdf,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // Clean shutdown: make sure the sidecar process never outlives
            // the window it was started for.
            if let RunEvent::ExitRequested { .. } | RunEvent::Exit = event {
                if let Some(state) = app_handle.try_state::<AppState>() {
                    state.shutdown_started.store(true, Ordering::Release);
                    if let Ok(mut runtimes) = state.runtimes.lock() {
                        runtimes.dispose_all();
                    }
                }
            }
        });
}
