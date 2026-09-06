use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

pub const SIDECAR_BASENAME: &str = "cortex-sidecar";
pub const DEFAULT_WINDOW_LABEL: &str = "main";
/// A cold workspace index can legitimately take longer than the old 20s
/// ceiling, especially while the machine is under load. The health handshake
/// still bounds a genuinely broken sidecar, but gives large vaults enough
/// time to finish their first projection.
pub const DEFAULT_STARTUP_TIMEOUT_SECS: u64 = 120;

/// Runtime ownership is keyed by Tauri window label. V2 still opens one
/// active vault per window, but keeping the map here prevents a future
/// window from sharing or accidentally disposing another window's sidecar.
pub struct RuntimeRegistry {
    runtimes: HashMap<String, SidecarHandle>,
}

impl Default for RuntimeRegistry {
    fn default() -> Self {
        Self {
            runtimes: HashMap::new(),
        }
    }
}

impl RuntimeRegistry {
    pub fn insert(&mut self, window_label: &str, handle: SidecarHandle) {
        if let Some(mut previous) = self.runtimes.insert(window_label.to_string(), handle) {
            // Replacement is itself a lifecycle seam: callers should not have
            // to remember a second cleanup path when a new generation wins.
            dispose(&mut previous);
        }
    }

    pub fn dispose_window(&mut self, window_label: &str) {
        if let Some(mut handle) = self.runtimes.remove(window_label) {
            dispose(&mut handle);
        }
    }

    pub fn dispose_vault(&mut self, vault_id: &str) {
        let labels = self
            .runtimes
            .iter()
            .filter(|(_, handle)| handle.vault_id == vault_id)
            .map(|(label, _)| label.clone())
            .collect::<Vec<_>>();
        for label in labels {
            self.dispose_window(&label);
        }
    }

    pub fn dispose_all(&mut self) {
        let labels = self.runtimes.keys().cloned().collect::<Vec<_>>();
        for label in labels {
            self.dispose_window(&label);
        }
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.runtimes.len()
    }
}

pub fn window_runtime_key(label: &str) -> String {
    if label.trim().is_empty() {
        DEFAULT_WINDOW_LABEL.to_string()
    } else {
        label.to_string()
    }
}

pub fn packaged_sidecar_path(resource_dir: &Path) -> PathBuf {
    resource_dir
        .parent()
        .unwrap_or(resource_dir)
        .join("MacOS")
        .join(SIDECAR_BASENAME)
}

pub fn packaged_ui_dist(resource_dir: &Path) -> PathBuf {
    resource_dir.join("dist")
}

pub fn packaged_chromium_path(resource_dir: &Path) -> PathBuf {
    if cfg!(target_os = "macos") {
        let candidates = [
            resource_dir.join("chromium/Chromium.app/Contents/MacOS/Google Chrome for Testing"),
            resource_dir.join("chromium/Chromium.app/Contents/MacOS/Chromium"),
        ];
        return candidates
            .iter()
            .find(|candidate| candidate.is_file())
            .cloned()
            .unwrap_or_else(|| candidates[0].clone());
    }
    resource_dir.join("chromium").join(if cfg!(windows) { "chrome.exe" } else { "chrome" })
}

pub fn packaged_node_modules_path(resource_dir: &Path) -> PathBuf {
    resource_dir.join("node_modules")
}

pub fn resolve_packaged_sidecar(resource_dir: &Path) -> Result<PathBuf, String> {
    let path = packaged_sidecar_path(resource_dir);
    if path.is_file() {
        return Ok(path);
    }
    Err(format!(
        "Cortex production sidecar is missing at {}. Rebuild the app with the desktop sidecar step.",
        path.display()
    ))
}

pub struct SidecarHandle {
    pub child: Child,
    pub port: u16,
    pub vault_id: String,
}

fn drain_child_output<R: Read + Send + 'static>(reader: R, stream: &'static str) {
    std::thread::spawn(move || {
        for line in BufReader::new(reader).lines().map_while(Result::ok) {
            log::info!("sidecar {stream}: {line}");
        }
    });
}

fn attach_output_drainers(child: &mut Child) {
    if let Some(stdout) = child.stdout.take() {
        drain_child_output(stdout, "stdout");
    }
    if let Some(stderr) = child.stderr.take() {
        drain_child_output(stderr, "stderr");
    }
}

impl Drop for SidecarHandle {
    /// Safety net: if a handle is ever dropped without going through
    /// `dispose` (a panic mid-switch, an early return we forgot to guard),
    /// still make sure the child process doesn't outlive it as an orphan.
    fn drop(&mut self) {
        if let Ok(None) = self.child.try_wait() {
            log::warn!(
                "SidecarHandle for vault {} (port {}) dropped without explicit dispose; force-killing",
                self.vault_id,
                self.port
            );
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }
}

/// Ask the OS for a free loopback port by binding to port 0, reading back
/// what it assigned, then releasing it. There is an inherent TOCTOU race
/// (something else could grab the port before we spawn the backend), but
/// that's the standard "find a free port" pattern for a local-only app and
/// good enough for this use case.
pub fn find_free_port() -> Result<u16, String> {
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    drop(listener);
    Ok(port)
}

/// Resolve the `bun` executable. In a dev shell `bun` is reliably on PATH,
/// but a packaged macOS app launched from Finder does not inherit the
/// user's shell PATH (no ~/.bun/bin), so PATH lookup alone is not
/// production-safe. Check common install locations first, then an explicit
/// override, then fall back to PATH for dev convenience.
fn resolve_bun_path() -> Result<PathBuf, String> {
    if let Ok(p) = std::env::var("CORTEX_BUN_PATH") {
        let path = PathBuf::from(p);
        if path.is_file() {
            return Ok(path);
        }
    }

    let home = std::env::var("HOME").unwrap_or_default();
    let candidates = [
        format!("{home}/.bun/bin/bun"),
        "/opt/homebrew/bin/bun".to_string(),
        "/usr/local/bin/bun".to_string(),
    ];
    for candidate in candidates {
        let path = PathBuf::from(&candidate);
        if path.is_file() {
            return Ok(path);
        }
    }

    if let Ok(path_var) = std::env::var("PATH") {
        for dir in path_var.split(':') {
            let candidate = PathBuf::from(dir).join("bun");
            if candidate.is_file() {
                return Ok(candidate);
            }
        }
    }

    Err("Could not locate the `bun` executable. Set CORTEX_BUN_PATH to its absolute path.".into())
}

/// Resolve the backend CLI entry point (`src/cli.ts`). Dev builds fall back
/// to a path computed relative to this crate, which only exists in a
/// monorepo checkout. Phase G's packaged build must set CORTEX_BACKEND_CLI
/// (or replace this whole module with a compiled sidecar binary) — this
/// fallback is intentionally dev-only and fails loudly rather than
/// resolving to a wrong or missing path.
fn resolve_cli_path() -> Result<PathBuf, String> {
    if let Ok(p) = std::env::var("CORTEX_BACKEND_CLI") {
        let path = PathBuf::from(p);
        if path.is_file() {
            return path.canonicalize().map_err(|e| e.to_string());
        }
    }

    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let candidate = manifest_dir.join("../../src/cli.ts");
    if candidate.is_file() {
        return candidate.canonicalize().map_err(|e| e.to_string());
    }

    Err(
        "Could not locate the Cortex backend entry point (src/cli.ts). Set CORTEX_BACKEND_CLI \
         to its absolute path."
            .into(),
    )
}

pub fn spawn(vault_path: &str, port: u16, resource_dir: Option<&Path>) -> Result<Child, String> {
    if let Some(resource_dir) = resource_dir {
        let sidecar = resolve_packaged_sidecar(resource_dir)?;
        let mut child = Command::new(sidecar)
            .arg("dev")
            .arg("--vault")
            .arg(vault_path)
            .arg("--port")
            .arg(port.to_string())
            .env("CORTEX_UI_DIST", packaged_ui_dist(resource_dir))
            .env("CORTEX_PACKAGED_CHROMIUM_PATH", packaged_chromium_path(resource_dir))
            .env("CORTEX_PACKAGED", "1")
            .env("NODE_PATH", packaged_node_modules_path(resource_dir))
            .current_dir(resource_dir)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("Failed to start the packaged Cortex backend: {e}"));
        if let Ok(child) = &mut child {
            attach_output_drainers(child);
        }
        return child;
    }

    let bun = resolve_bun_path()?;
    let cli = resolve_cli_path()?;
    let repo_root = cli
        .parent() // src/
        .and_then(|p| p.parent()) // repo root
        .ok_or_else(|| "Could not determine the backend repository root".to_string())?;

    let mut child = Command::new(bun)
        .arg("run")
        .arg(&cli)
        .arg("dev")
        .arg("--vault")
        .arg(vault_path)
        .arg("--port")
        .arg(port.to_string())
        .current_dir(repo_root)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to start the Cortex backend: {e}"));
    if let Ok(child) = &mut child {
        attach_output_drainers(child);
    }
    child
}

/// Poll GET /api/health until it responds 200 or `timeout` elapses.
#[allow(dead_code)]
pub fn wait_for_health(
    child: &mut Child,
    port: u16,
    timeout: Duration,
) -> Result<serde_json::Value, String> {
    wait_for_health_until(child, port, timeout, || false)
}

/// Poll health while allowing the owning supervisor to cancel a superseded
/// start. Cancellation kills and joins the child before returning, so a
/// generation change cannot leave a startup process running in the background.
pub fn wait_for_health_until<F: Fn() -> bool>(
    child: &mut Child,
    port: u16,
    timeout: Duration,
    cancelled: F,
) -> Result<serde_json::Value, String> {
    let url = format!("http://127.0.0.1:{port}/api/health");
    let deadline = Instant::now() + timeout;
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_millis(300))
        .timeout(Duration::from_millis(500))
        .build();

    loop {
        if cancelled() {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!("Cortex sidecar startup on port {port} was cancelled."));
        }
        match child.try_wait() {
            Ok(Some(status)) => {
                return Err(format!(
                    "Cortex sidecar exited before reporting healthy on port {port} with status {status}."
                ));
            }
            Ok(None) => {}
            Err(error) => {
                return Err(format!(
                    "Could not inspect the Cortex sidecar while waiting for port {port}: {error}"
                ));
            }
        }
        match agent.get(&url).call() {
            Ok(resp) if resp.status() == 200 => {
                let body: serde_json::Value =
                    resp.into_json().unwrap_or_else(|_| serde_json::json!({}));
                return Ok(body);
            }
            _ => {}
        }
        if Instant::now() >= deadline {
            return Err(format!(
                "Backend did not report healthy at {url} within {timeout:?}"
            ));
        }
        std::thread::sleep(Duration::from_millis(150));
    }
}

/// Stop a sidecar cleanly: SIGTERM first so the watcher/DB handles get a
/// chance to close, then a hard kill if it hasn't exited after a short
/// grace period. Markdown is the source of truth and SQLite is a
/// rebuildable projection, so a forced kill can't corrupt durable state —
/// the grace period is a courtesy, not a correctness requirement.
pub fn dispose(handle: &mut SidecarHandle) {
    let pid = handle.child.id();
    let _ = Command::new("kill")
        .arg("-TERM")
        .arg(pid.to_string())
        .status();

    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        match handle.child.try_wait() {
            Ok(Some(_)) => return,
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = handle.child.kill();
                    let _ = handle.child.wait();
                    return;
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            Err(_) => {
                let _ = handle.child.kill();
                return;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::{Command, Stdio};

    fn repo_root() -> PathBuf {
        resolve_cli_path()
            .expect("cli.ts should resolve in a dev checkout")
            .parent() // src/
            .unwrap()
            .parent() // repo root
            .unwrap()
            .to_path_buf()
    }

    /// Create a brand-new real vault (git-inited, sample notes) via the
    /// backend's own `vault:init`, so these tests exercise the exact same
    /// code path a real user's "Add vault" would hit — not a hand-rolled
    /// fixture that might drift from what `initVault` actually produces.
    fn init_temp_vault() -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("cortex-sidecar-test-{}", uuid::Uuid::new_v4()));
        let bun = resolve_bun_path().expect("bun should be resolvable in the test environment");
        let cli = resolve_cli_path().expect("cli.ts should resolve");
        let status = Command::new(bun)
            .arg("run")
            .arg(&cli)
            .arg("vault:init")
            .arg(&dir)
            .current_dir(repo_root())
            .status()
            .expect("vault:init should spawn");
        assert!(status.success(), "vault:init failed for {dir:?}");
        dir
    }

    #[test]
    fn cancelled_health_wait_joins_the_starting_child() {
        let mut child = Command::new("sleep").arg("30").spawn().expect("sleep should start");
        let result = wait_for_health_until(&mut child, 9_999, Duration::from_secs(5), || true);
        assert!(result.expect_err("cancelled startup should fail").contains("cancelled"));
        assert!(child.try_wait().expect("child status should be readable").is_some());
    }

    #[test]
    fn rapid_superseded_startups_are_all_joined() {
        for _ in 0..20 {
            let mut child = Command::new("sleep").arg("30").spawn().expect("sleep should start");
            let result = wait_for_health_until(&mut child, 9_999, Duration::from_secs(5), || true);
            assert!(result.expect_err("superseded startup should fail").contains("cancelled"));
            assert!(child.try_wait().expect("child status should be readable").is_some());
        }
    }

    #[test]
    fn dispose_hard_kills_a_child_that_ignores_sigterm() {
        let child = Command::new("sh")
            .arg("-c")
            .arg("trap '' TERM; sleep 30")
            .spawn()
            .expect("test child should spawn");
        let mut handle = SidecarHandle { child, port: 9_998, vault_id: "ignored-term".into() };
        dispose(&mut handle);
        assert!(handle.child.try_wait().expect("child status should be readable").is_some());
    }

    #[test]
    fn replacing_a_window_runtime_disposes_the_previous_child() {
        let first = Command::new("sleep").arg("30").spawn().expect("first child should start");
        let first_pid = first.id();
        let mut registry = RuntimeRegistry::default();
        registry.insert("main", SidecarHandle { child: first, port: 9_997, vault_id: "first".into() });
        let second = Command::new("sleep").arg("30").spawn().expect("second child should start");
        registry.insert("main", SidecarHandle { child: second, port: 9_996, vault_id: "second".into() });
        assert!(matches!(Command::new("kill").arg("-0").arg(first_pid.to_string()).stderr(Stdio::null()).status(), Ok(status) if !status.success()));
        registry.dispose_all();
    }

    #[test]
    fn find_free_port_returns_a_usable_port() {
        let port = find_free_port().expect("should find a free port");
        assert!(port > 0);
    }

    #[test]
    fn resolve_bun_and_cli_paths_exist_in_dev_checkout() {
        let bun = resolve_bun_path().expect("bun should resolve");
        assert!(bun.is_file());
        let cli = resolve_cli_path().expect("cli.ts should resolve");
        assert!(cli.is_file());
        assert_eq!(cli.file_name().unwrap(), "cli.ts");
    }

    #[test]
    fn packaged_sidecar_path_matches_tauri_target_layout() {
        let path = packaged_sidecar_path(Path::new("/tmp/cortex-resources"));
        assert!(path.ends_with(format!("MacOS/{SIDECAR_BASENAME}")));
    }

    #[test]
    fn packaged_ui_dist_matches_tauri_resource_target() {
        let path = packaged_ui_dist(Path::new("/tmp/cortex-resources"));
        assert!(path.ends_with("dist"));
    }

    #[test]
    fn packaged_chromium_matches_resource_target() {
        let path = packaged_chromium_path(Path::new("/tmp/cortex-resources"));
        if cfg!(target_os = "macos") {
            assert!(path.ends_with("Chromium.app/Contents/MacOS/Google Chrome for Testing"));
        } else {
            assert!(path.ends_with(if cfg!(windows) { "chromium/chrome.exe" } else { "chromium/chrome" }));
        }
    }

    #[test]
    fn packaged_node_modules_matches_tauri_resource_target() {
        let resources = PathBuf::from("/Applications/Cortex.app/Contents/Resources");
        assert_eq!(packaged_node_modules_path(&resources), resources.join("node_modules"));
    }

    #[test]
    fn missing_packaged_sidecar_fails_with_rebuild_guidance() {
        let error =
            resolve_packaged_sidecar(Path::new("/tmp/cortex-missing-resources")).unwrap_err();
        assert!(error.contains("production sidecar is missing"));
        assert!(error.contains("desktop sidecar step"));
    }

    #[test]
    fn window_runtime_keys_are_stable_and_default_to_main() {
        assert_eq!(window_runtime_key(""), DEFAULT_WINDOW_LABEL);
        assert_eq!(window_runtime_key("main"), "main");
        assert_eq!(window_runtime_key("notes-window"), "notes-window");
        assert_eq!(RuntimeRegistry::default().len(), 0);
    }

    #[test]
    fn startup_budget_allows_slow_initial_indexes() {
        assert!(DEFAULT_STARTUP_TIMEOUT_SECS >= 60);
    }

    #[test]
    fn health_wait_reports_a_sidecar_that_exits_before_listening() {
        let mut child = Command::new("sh")
            .arg("-c")
            .arg("exit 17")
            .spawn()
            .expect("test child should spawn");
        let started = Instant::now();
        let error = wait_for_health(
            &mut child,
            find_free_port().unwrap(),
            Duration::from_secs(20),
        )
        .expect_err("an exited child cannot become healthy");
        assert!(started.elapsed() < Duration::from_secs(2));
        assert!(error.contains("exited"));
    }

    /// Full lifecycle against a real backend process and a real vault: spawn,
    /// health-check, dispose — and confirm dispose actually terminates the
    /// process rather than just returning. This is the process-level proof
    /// behind "sidecar lifecycle and health-check handshake" (D2-07).
    #[test]
    fn spawn_health_check_and_dispose_full_lifecycle() {
        let vault = init_temp_vault();
        let port = find_free_port().expect("free port");
        let child = spawn(vault.to_str().unwrap(), port, None).expect("spawn should succeed");
        let mut handle = SidecarHandle {
            child,
            port,
            vault_id: "test-vault".into(),
        };

        let health = wait_for_health(
            &mut handle.child,
            port,
            Duration::from_secs(DEFAULT_STARTUP_TIMEOUT_SECS),
        )
        .expect("backend should become healthy within the startup budget");
        assert_eq!(health.get("status").and_then(|v| v.as_str()), Some("ok"));

        assert!(
            matches!(handle.child.try_wait(), Ok(None)),
            "backend should still be running right before dispose"
        );

        dispose(&mut handle);
        std::thread::sleep(Duration::from_millis(300));
        assert!(
            matches!(handle.child.try_wait(), Ok(Some(_))),
            "backend process should have exited after dispose"
        );

        std::fs::remove_dir_all(&vault).ok();
    }

    /// Two vaults' sidecars can run concurrently on independent ports (the
    /// brief overlap a real vault switch goes through between "start the
    /// new one" and "the old one has already been disposed") and both
    /// dispose cleanly afterward — no leaked processes, no port collision.
    #[test]
    fn two_vaults_run_independently_and_both_dispose_cleanly() {
        let vault_a = init_temp_vault();
        let vault_b = init_temp_vault();

        let port_a = find_free_port().unwrap();
        let child_a = spawn(vault_a.to_str().unwrap(), port_a, None).expect("spawn a");
        let mut handle_a = SidecarHandle {
            child: child_a,
            port: port_a,
            vault_id: "a".into(),
        };
        wait_for_health(
            &mut handle_a.child,
            port_a,
            Duration::from_secs(DEFAULT_STARTUP_TIMEOUT_SECS),
        )
        .expect("a healthy");

        let port_b = find_free_port().unwrap();
        assert_ne!(port_a, port_b);
        let child_b = spawn(vault_b.to_str().unwrap(), port_b, None).expect("spawn b");
        let mut handle_b = SidecarHandle {
            child: child_b,
            port: port_b,
            vault_id: "b".into(),
        };
        wait_for_health(
            &mut handle_b.child,
            port_b,
            Duration::from_secs(DEFAULT_STARTUP_TIMEOUT_SECS),
        )
        .expect("b healthy");

        assert!(matches!(handle_a.child.try_wait(), Ok(None)));
        assert!(matches!(handle_b.child.try_wait(), Ok(None)));

        dispose(&mut handle_a);
        dispose(&mut handle_b);
        std::thread::sleep(Duration::from_millis(300));
        assert!(matches!(handle_a.child.try_wait(), Ok(Some(_))));
        assert!(matches!(handle_b.child.try_wait(), Ok(Some(_))));

        std::fs::remove_dir_all(&vault_a).ok();
        std::fs::remove_dir_all(&vault_b).ok();
    }
}
