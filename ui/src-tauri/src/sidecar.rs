use std::net::TcpListener;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

pub struct SidecarHandle {
    pub child: Child,
    pub port: u16,
    pub vault_id: String,
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

pub fn spawn(vault_path: &str, port: u16) -> Result<Child, String> {
    let bun = resolve_bun_path()?;
    let cli = resolve_cli_path()?;
    let repo_root = cli
        .parent() // src/
        .and_then(|p| p.parent()) // repo root
        .ok_or_else(|| "Could not determine the backend repository root".to_string())?;

    Command::new(bun)
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
        .map_err(|e| format!("Failed to start the Cortex backend: {e}"))
}

/// Poll GET /api/health until it responds 200 or `timeout` elapses.
pub fn wait_for_health(port: u16, timeout: Duration) -> Result<serde_json::Value, String> {
    let url = format!("http://127.0.0.1:{port}/api/health");
    let deadline = Instant::now() + timeout;
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_millis(300))
        .timeout(Duration::from_millis(500))
        .build();

    loop {
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
    use std::process::Command;

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
        let dir = std::env::temp_dir().join(format!("cortex-sidecar-test-{}", uuid::Uuid::new_v4()));
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

    /// Full lifecycle against a real backend process and a real vault: spawn,
    /// health-check, dispose — and confirm dispose actually terminates the
    /// process rather than just returning. This is the process-level proof
    /// behind "sidecar lifecycle and health-check handshake" (D2-07).
    #[test]
    fn spawn_health_check_and_dispose_full_lifecycle() {
        let vault = init_temp_vault();
        let port = find_free_port().expect("free port");
        let child = spawn(vault.to_str().unwrap(), port).expect("spawn should succeed");
        let mut handle = SidecarHandle {
            child,
            port,
            vault_id: "test-vault".into(),
        };

        let health = wait_for_health(port, Duration::from_secs(20))
            .expect("backend should become healthy within 20s");
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
        let child_a = spawn(vault_a.to_str().unwrap(), port_a).expect("spawn a");
        let mut handle_a = SidecarHandle {
            child: child_a,
            port: port_a,
            vault_id: "a".into(),
        };
        wait_for_health(port_a, Duration::from_secs(20)).expect("a healthy");

        let port_b = find_free_port().unwrap();
        assert_ne!(port_a, port_b);
        let child_b = spawn(vault_b.to_str().unwrap(), port_b).expect("spawn b");
        let mut handle_b = SidecarHandle {
            child: child_b,
            port: port_b,
            vault_id: "b".into(),
        };
        wait_for_health(port_b, Duration::from_secs(20)).expect("b healthy");

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
