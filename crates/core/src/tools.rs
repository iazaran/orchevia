//! Generic local CLI discovery and the search `PATH` shared by every child.
//!
//! A `ToolDefinition` describes an optional external executable; discovery
//! finds it on the search `PATH` and probes `--version` safely (no shell,
//! short timeout). The UI renders whatever definitions are registered, so
//! adding a new tool does not require UI or engine changes.
//!
//! Apps launched from a desktop menu do not inherit the `PATH` configured in
//! shell rc files (nvm, fnm, Homebrew, …). [`refresh_search_environment`]
//! asks the user's login shell for its `PATH` once, off the main thread and
//! with a hard timeout, then combines it with Orchevia's own `PATH` and
//! well-known install directories. The result drives executable lookup and
//! becomes the `PATH` of every spawned child ([`child_path`]), so a CLI found
//! here can also find its own interpreter (`#!/usr/bin/env node`). Only
//! `PATH` is imported; no other shell variable is read.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::ffi::{OsStr, OsString};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};

use crate::process::{run_command, CommandSpec};

/// Built-in tool identifiers for Milestone 1.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum KnownTool {
    Git,
    Gh,
    Claude,
    Codex,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolDefinition {
    pub id: String,
    pub display_name: String,
    pub executables: Vec<String>,
    pub version_args: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolStatus {
    pub id: String,
    pub display_name: String,
    pub installed: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
}

/// Default registry: the four optional CLIs from Milestone 1.
pub fn default_tools() -> Vec<ToolDefinition> {
    vec![
        ToolDefinition {
            id: "git".into(),
            display_name: "Git".into(),
            executables: vec!["git".into()],
            version_args: vec!["--version".into()],
        },
        ToolDefinition {
            id: "gh".into(),
            display_name: "GitHub CLI".into(),
            executables: vec!["gh".into()],
            version_args: vec!["--version".into()],
        },
        ToolDefinition {
            id: "claude".into(),
            display_name: "Claude Code".into(),
            executables: vec!["claude".into()],
            version_args: vec!["--version".into()],
        },
        ToolDefinition {
            id: "codex".into(),
            display_name: "Codex".into(),
            executables: vec!["codex".into()],
            version_args: vec!["--version".into()],
        },
    ]
}

/// Discover all registered tools. Probes are independent and individually
/// bounded, so they run concurrently.
pub fn discover_tools(definitions: &[ToolDefinition]) -> Vec<ToolStatus> {
    std::thread::scope(|scope| {
        let handles: Vec<_> = definitions
            .iter()
            .map(|def| std::thread::Builder::new().spawn_scoped(scope, move || discover_one(def)))
            .collect();
        handles
            .into_iter()
            .zip(definitions)
            .map(|(handle, def)| match handle {
                Ok(handle) => handle.join().unwrap_or_else(|_| missing_tool(def)),
                Err(_) => discover_one(def),
            })
            .collect()
    })
}

fn discover_one(def: &ToolDefinition) -> ToolStatus {
    for exe in &def.executables {
        if let Some(path) = find_executable(exe) {
            let version = probe_version(&path, &def.version_args);
            return ToolStatus {
                id: def.id.clone(),
                display_name: def.display_name.clone(),
                installed: true,
                version,
                path: Some(path.to_string_lossy().into_owned()),
            };
        }
    }
    missing_tool(def)
}

fn missing_tool(def: &ToolDefinition) -> ToolStatus {
    ToolStatus {
        id: def.id.clone(),
        display_name: def.display_name.clone(),
        installed: false,
        version: None,
        path: None,
    }
}

/// Upper bound for asking the login shell for its `PATH`.
pub const SHELL_RESOLVE_TIMEOUT: Duration = Duration::from_secs(5);
/// A refresh this soon after a completed resolution reuses it: startup
/// resolution and the first Environment detection arrive together.
const REFRESH_COALESCE: Duration = Duration::from_secs(3);
/// Login-shell output kept while looking for the `PATH` markers.
const MAX_SHELL_OUTPUT: usize = 256 * 1024;

/// Where the effective search `PATH` came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SearchPathSource {
    /// The user's login shell reported its `PATH`.
    LoginShell,
    /// Orchevia's own `PATH` plus well-known install directories.
    Fallback,
}

/// Ordered directories used for executable lookup and as children's `PATH`.
#[derive(Debug, Clone)]
pub struct SearchEnvironment {
    dirs: Vec<PathBuf>,
    source: SearchPathSource,
    note: Option<String>,
}

impl SearchEnvironment {
    /// Login-shell `PATH` first, then Orchevia's `PATH`, then existing
    /// well-known directories. Empty and relative entries are dropped.
    pub fn from_login(login: &OsStr, current: Option<&OsStr>, home: Option<&Path>) -> Self {
        let mut dirs = absolute_entries(Some(login));
        dirs.extend(absolute_entries(current));
        dirs.extend(well_known_dirs(home).into_iter().filter(|d| d.is_dir()));
        Self {
            dirs: dedup(dirs),
            source: SearchPathSource::LoginShell,
            note: None,
        }
    }

    /// Safe fallback without a shell: Orchevia's `PATH` plus existing
    /// well-known directories.
    pub fn fallback(current: Option<&OsStr>, home: Option<&Path>, note: Option<String>) -> Self {
        let mut dirs = absolute_entries(current);
        dirs.extend(well_known_dirs(home).into_iter().filter(|d| d.is_dir()));
        Self {
            dirs: dedup(dirs),
            source: SearchPathSource::Fallback,
            note,
        }
    }

    pub fn source(&self) -> SearchPathSource {
        self.source
    }

    /// Why the fallback was used, when it was.
    pub fn note(&self) -> Option<&str> {
        self.note.as_deref()
    }

    pub fn dirs(&self) -> &[PathBuf] {
        &self.dirs
    }

    /// The joined `PATH` value given to children.
    pub fn path(&self) -> OsString {
        std::env::join_paths(&self.dirs).unwrap_or_else(|_| {
            // A directory containing the separator cannot be joined; skip it.
            std::env::join_paths(
                self.dirs
                    .iter()
                    .filter(|d| std::env::join_paths([d.as_path()]).is_ok()),
            )
            .unwrap_or_default()
        })
    }

    /// First executable file named `exe` in the search directories.
    pub fn find(&self, exe: &str) -> Option<PathBuf> {
        for dir in &self.dirs {
            let candidate = dir.join(exe);
            if is_executable_file(&candidate) {
                return Some(candidate);
            }
            // Windows PATHEXT handling (harmless elsewhere).
            #[cfg(windows)]
            for ext in ["exe", "cmd", "bat"] {
                let with_ext = candidate.with_extension(ext);
                if is_executable_file(&with_ext) {
                    return Some(with_ext);
                }
            }
        }
        None
    }
}

fn absolute_entries(path: Option<&OsStr>) -> Vec<PathBuf> {
    path.map(|p| {
        std::env::split_paths(p)
            .filter(|dir| dir.is_absolute())
            .collect()
    })
    .unwrap_or_default()
}

fn dedup(dirs: Vec<PathBuf>) -> Vec<PathBuf> {
    let mut seen = std::collections::HashSet::new();
    dirs.into_iter()
        .filter(|dir| seen.insert(dir.clone()))
        .collect()
}

/// A regular file that the current user may execute (exec bit on Unix).
pub fn is_executable_file(path: &Path) -> bool {
    match std::fs::metadata(path) {
        Ok(meta) if meta.is_file() => {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                meta.permissions().mode() & 0o111 != 0
            }
            #[cfg(not(unix))]
            {
                true
            }
        }
        _ => false,
    }
}

/// Well-known install directories used beyond `PATH` (existence unchecked).
///
/// Covers the installers and version managers developers actually use:
/// user bins, npm/volta/asdf/mise shims, the default (or newest) nvm Node,
/// fnm's default alias, bun, cargo, pnpm home, Claude's local install,
/// Homebrew/Linuxbrew and common system directories. Nothing is executed.
pub fn well_known_dirs(home: Option<&Path>) -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Some(h) = home {
        for sub in [
            ".local/bin",
            ".npm-global/bin",
            ".volta/bin",
            ".asdf/shims",
            ".local/share/mise/shims",
            ".bun/bin",
            ".cargo/bin",
            ".claude/local",
        ] {
            dirs.push(h.join(sub));
        }
        dirs.extend(nvm_bin(h));
        let fnm_roots = [
            std::env::var_os("FNM_DIR").map(PathBuf::from),
            Some(h.join(".local/share/fnm")),
            Some(h.join("Library/Application Support/fnm")),
            Some(h.join(".fnm")),
        ];
        dirs.extend(
            fnm_roots
                .into_iter()
                .flatten()
                .map(|root| root.join("aliases/default/bin")),
        );
        let pnpm_homes = [
            std::env::var_os("PNPM_HOME").map(PathBuf::from),
            Some(h.join(".local/share/pnpm")),
            Some(h.join("Library/pnpm")),
        ];
        dirs.extend(pnpm_homes.into_iter().flatten());
        dirs.push(h.join(".linuxbrew/bin"));
    }
    for fixed in [
        "/usr/local/bin",
        "/usr/bin",
        "/opt/homebrew/bin",
        "/opt/local/bin",
        "/snap/bin",
        "/home/linuxbrew/.linuxbrew/bin",
    ] {
        dirs.push(PathBuf::from(fixed));
    }
    dirs
}

/// nvm's default Node `bin`: the `alias/default` version (or prefix) when
/// installed, otherwise the newest installed version.
fn nvm_bin(home: &Path) -> Option<PathBuf> {
    let root = std::env::var_os("NVM_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".nvm"));
    nvm_default_bin(&root)
}

fn nvm_default_bin(root: &Path) -> Option<PathBuf> {
    let mut versions: Vec<(Vec<u64>, PathBuf)> = std::fs::read_dir(root.join("versions/node"))
        .ok()?
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            let version = name
                .strip_prefix('v')?
                .split('.')
                .map(|part| part.parse().ok())
                .collect::<Option<Vec<u64>>>()?;
            Some((version, entry.path().join("bin")))
        })
        .collect();
    versions.sort();
    let alias = std::fs::read_to_string(root.join("alias/default")).unwrap_or_default();
    let wanted: Option<Vec<u64>> = alias
        .trim()
        .trim_start_matches('v')
        .split('.')
        .map(|part| part.parse().ok())
        .collect();
    let chosen = wanted
        .filter(|w| !w.is_empty())
        .and_then(|w| versions.iter().rev().find(|(v, _)| v.starts_with(&w)))
        .or_else(|| versions.last());
    chosen.map(|(_, bin)| bin.clone())
}

/// Existing executable candidates named `exe` in [`well_known_dirs`].
pub fn fallback_candidates(exe: &str, home: Option<&Path>) -> Vec<PathBuf> {
    well_known_dirs(home)
        .into_iter()
        .map(|d| d.join(exe))
        .filter(|p| is_executable_file(p))
        .collect()
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .filter(|h| h.is_absolute())
}

/// The user's login shell: `$SHELL` when it is an executable absolute path,
/// otherwise the platform default.
fn login_shell() -> Option<PathBuf> {
    std::env::var_os("SHELL")
        .map(PathBuf::from)
        .filter(|shell| shell.is_absolute() && is_executable_file(shell))
        .or_else(|| {
            let defaults: &[&str] = if cfg!(target_os = "macos") {
                &["/bin/zsh", "/bin/bash", "/bin/sh"]
            } else {
                &["/bin/bash", "/bin/sh"]
            };
            defaults
                .iter()
                .map(PathBuf::from)
                .find(|shell| is_executable_file(shell))
        })
}

/// Ask `shell` (interactive login mode, so rc files load) for its `PATH`.
///
/// Runs with null stdin, in a new session without a controlling terminal,
/// with `ORCHEVIA_RESOLVING_ENVIRONMENT=1` so rc files can skip slow work.
/// The value is read between unique marker lines, so banners and other rc
/// output are ignored. Exceeding `timeout` stops the shell's process group.
pub fn login_shell_path(shell: &Path, timeout: Duration) -> Result<OsString, String> {
    let marker = format!("__ORCHEVIA_PATH_{}__", uuid::Uuid::new_v4().simple());
    let script = format!("echo {marker}; printenv PATH; echo {marker}");
    let mut cmd = std::process::Command::new(shell);
    cmd.args(["-i", "-l", "-c", &script])
        .env("ORCHEVIA_RESOLVING_ENVIRONMENT", "1")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // SAFETY: the closure runs in the forked child before exec and only
        // calls setsid, which is async-signal-safe and touches no shared memory.
        // A new session keeps an interactive shell from claiming a terminal.
        unsafe {
            cmd.pre_exec(|| {
                if libc::setsid() == -1 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
    }
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Could not start login shell {}: {e}", shell.display()))?;
    // Dropping the group stops whatever the probe shell left running.
    let group = crate::process::ProcessGroup::new(Some(child.id()));
    let (sender, receiver) = std::sync::mpsc::channel::<Vec<u8>>();
    let reader = child.stdout.take().map(|mut stdout| {
        std::thread::Builder::new()
            .name("orchevia-shell-path".into())
            .spawn(move || {
                let mut chunk = [0u8; 8192];
                loop {
                    match stdout.read(&mut chunk) {
                        Ok(0) => break,
                        Ok(n) => {
                            if sender.send(chunk[..n].to_vec()).is_err() {
                                break;
                            }
                        }
                        Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                        Err(_) => break,
                    }
                }
            })
    });
    if !matches!(reader, Some(Ok(_))) {
        drop(group);
        let _ = child.kill();
        let _ = child.wait();
        return Err("Could not read the login shell output.".into());
    }
    let deadline = Instant::now() + timeout;
    let mut output = Vec::new();
    // Stop as soon as both markers arrived: an rc file may leave a background
    // job holding stdout open after the shell itself has finished.
    let parsed = loop {
        let left = deadline.saturating_duration_since(Instant::now());
        match receiver.recv_timeout(left.min(Duration::from_millis(50))) {
            Ok(chunk) => {
                let keep = chunk
                    .len()
                    .min(MAX_SHELL_OUTPUT.saturating_sub(output.len()));
                output.extend_from_slice(&chunk[..keep]);
                if let Some(value) = parse_login_path(&String::from_utf8_lossy(&output), &marker) {
                    break Ok(value);
                }
            }
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                break parse_login_path(&String::from_utf8_lossy(&output), &marker)
                    .ok_or_else(|| "Login shell output did not contain a PATH value.".to_string());
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) if left.is_zero() => {
                break Err(format!(
                    "Login shell did not report PATH within {}s.",
                    timeout.as_secs()
                ));
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
        }
    };
    drop(receiver);
    // Let a shell that answered exit on its own; then stop anything it left.
    let exit_deadline = Instant::now() + Duration::from_millis(500);
    while parsed.is_ok() && matches!(child.try_wait(), Ok(None)) && Instant::now() < exit_deadline {
        std::thread::sleep(Duration::from_millis(20));
    }
    drop(group);
    let _ = child.kill();
    let _ = child.wait();
    parsed.map(OsString::from)
}

/// The value printed between the first two `marker` lines, ignoring rc noise.
fn parse_login_path(output: &str, marker: &str) -> Option<String> {
    let mut lines = output.lines().map(|line| line.trim_end_matches('\r'));
    lines.find(|line| line.trim() == marker)?;
    let mut value: Option<&str> = None;
    for line in lines {
        if line.trim() == marker {
            return value
                .map(str::trim)
                .filter(|v| !v.is_empty())
                .map(str::to_string);
        }
        if value.is_none() && !line.trim().is_empty() {
            value = Some(line);
        }
    }
    None
}

/// Resolve the search environment through `shell`, falling back safely.
pub fn resolve_search_environment(
    shell: Option<&Path>,
    home: Option<&Path>,
    timeout: Duration,
) -> SearchEnvironment {
    let current = std::env::var_os("PATH");
    let result = match shell {
        Some(shell) if cfg!(unix) => login_shell_path(shell, timeout),
        Some(_) => Err("Login shell resolution is not used on this platform.".to_string()),
        None => Err("No login shell found.".to_string()),
    };
    match result {
        Ok(login) if !absolute_entries(Some(&login)).is_empty() => {
            SearchEnvironment::from_login(&login, current.as_deref(), home)
        }
        Ok(_) => SearchEnvironment::fallback(
            current.as_deref(),
            home,
            Some("Login shell PATH had no absolute directories.".into()),
        ),
        Err(note) => SearchEnvironment::fallback(current.as_deref(), home, Some(note)),
    }
}

struct SearchState {
    env: Option<Arc<SearchEnvironment>>,
    resolving: bool,
    resolved_at: Option<Instant>,
    /// Bare executable name → resolved path for the current environment.
    cache: HashMap<String, PathBuf>,
}

fn search_state() -> &'static (Mutex<SearchState>, Condvar) {
    static STATE: OnceLock<(Mutex<SearchState>, Condvar)> = OnceLock::new();
    STATE.get_or_init(|| {
        (
            Mutex::new(SearchState {
                env: None,
                resolving: false,
                resolved_at: None,
                cache: HashMap::new(),
            }),
            Condvar::new(),
        )
    })
}

fn process_fallback() -> SearchEnvironment {
    SearchEnvironment::fallback(
        std::env::var_os("PATH").as_deref(),
        home_dir().as_deref(),
        None,
    )
}

/// The current search environment. Waits (bounded) for an in-flight login
/// shell resolution; before any resolution it is the safe fallback, so
/// library users and tests never spawn a shell implicitly.
pub fn search_environment() -> Arc<SearchEnvironment> {
    let (lock, changed) = search_state();
    let Ok(mut guard) = lock.lock() else {
        return Arc::new(process_fallback());
    };
    let deadline = Instant::now() + SHELL_RESOLVE_TIMEOUT + Duration::from_secs(1);
    while guard.resolving {
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            break;
        }
        guard = match changed.wait_timeout(guard, left) {
            Ok((guard, _)) => guard,
            Err(_) => return Arc::new(process_fallback()),
        };
    }
    Arc::clone(
        guard
            .env
            .get_or_insert_with(|| Arc::new(process_fallback())),
    )
}

/// Resolve the login shell `PATH` again and drop cached lookups. Blocking
/// (up to [`SHELL_RESOLVE_TIMEOUT`]); call it off the UI thread. Concurrent
/// or just-completed resolutions are reused instead of starting another shell.
pub fn refresh_search_environment() -> Arc<SearchEnvironment> {
    let (lock, _) = search_state();
    if let Ok(guard) = lock.lock() {
        if guard.resolving
            || guard
                .resolved_at
                .is_some_and(|at| at.elapsed() < REFRESH_COALESCE)
        {
            drop(guard);
            return search_environment();
        }
    }
    install_search_environment(|| {
        resolve_search_environment(
            login_shell().as_deref(),
            home_dir().as_deref(),
            SHELL_RESOLVE_TIMEOUT,
        )
    })
}

fn install_search_environment(
    resolve: impl FnOnce() -> SearchEnvironment,
) -> Arc<SearchEnvironment> {
    let (lock, changed) = search_state();
    match lock.lock() {
        Ok(mut guard) if !guard.resolving => guard.resolving = true,
        Ok(guard) => {
            drop(guard);
            return search_environment();
        }
        Err(_) => return Arc::new(resolve()),
    }
    let env = Arc::new(resolve());
    if let Ok(mut guard) = lock.lock() {
        guard.env = Some(Arc::clone(&env));
        guard.resolving = false;
        guard.resolved_at = Some(Instant::now());
        guard.cache.clear();
    }
    changed.notify_all();
    env
}

/// The `PATH` value for every spawned child.
pub fn child_path() -> OsString {
    search_environment().path()
}

fn cached_lookup(
    env: &SearchEnvironment,
    cache: &mut HashMap<String, PathBuf>,
    exe: &str,
) -> Option<PathBuf> {
    if let Some(hit) = cache.get(exe) {
        // One stat keeps uninstalls and version switches from using a stale path.
        if is_executable_file(hit) {
            return Some(hit.clone());
        }
        cache.remove(exe);
    }
    let found = env.find(exe)?;
    cache.insert(exe.to_string(), found.clone());
    Some(found)
}

/// Find an executable on the search `PATH` (login shell, Orchevia's own
/// `PATH`, well-known install locations). A value containing a path
/// separator is checked as given. Pure lookup: never executes anything.
pub fn find_executable(exe: &str) -> Option<PathBuf> {
    let exe = exe.trim();
    if exe.is_empty() {
        return None;
    }
    if exe.contains('/') || exe.contains('\\') {
        let path = PathBuf::from(exe);
        return is_executable_file(&path).then_some(path);
    }
    let env = search_environment();
    let (lock, _) = search_state();
    match lock.lock() {
        Ok(mut guard) if guard.env.as_ref().is_some_and(|e| Arc::ptr_eq(e, &env)) => {
            cached_lookup(&env, &mut guard.cache, exe)
        }
        _ => env.find(exe),
    }
}

/// Resolve a bare executable name to an absolute path (see
/// [`find_executable`]). Pass-through when `exe` already contains a path
/// separator: explicit paths in profiles and nodes always win.
pub fn resolve_executable(exe: &str) -> Option<String> {
    let trimmed = exe.trim();
    if trimmed.is_empty() {
        return None;
    }
    if trimmed.contains('/') || trimmed.contains('\\') {
        return Some(trimmed.to_string());
    }
    find_executable(trimmed).map(|p| p.to_string_lossy().into_owned())
}

/// [`resolve_executable`], with a user-facing error explaining how to fix it.
pub fn require_executable(exe: &str) -> Result<String, String> {
    resolve_executable(exe).ok_or_else(|| {
        format!(
            "'{exe}' was not found on PATH (your login shell PATH and common install \
             locations were checked). Install it, or set the full path to the executable \
             in the Agent Profile or node, then use Refresh in Environment."
        )
    })
}

/// Run `<exe> <version_args>` with a short timeout; return the first line.
fn probe_version(exe: &std::path::Path, version_args: &[String]) -> Option<String> {
    let exe_str = exe.to_string_lossy().into_owned();
    let spec = CommandSpec {
        executable: exe_str,
        args: version_args.to_vec(),
        working_dir: None,
        stdin: None,
    };
    let result = run_command(&spec, Some(Duration::from_secs(5))).ok()?;
    if result.exit_code != Some(0) {
        return None;
    }
    let combined = format!("{}\n{}", result.stdout, result.stderr);
    combined
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(|line| line.chars().take(120).collect())
}

/// Test hook: put `dir` in front of the current search environment, as if the
/// login shell had reported it. Other directories stay, so concurrent tests
/// keep finding their tools.
#[cfg(test)]
pub(crate) fn prepend_search_dir_for_tests(dir: &Path) {
    let current = search_environment();
    let mut dirs = vec![dir.to_path_buf()];
    dirs.extend(current.dirs.iter().cloned());
    install_search_environment(|| SearchEnvironment {
        dirs: dedup(dirs),
        source: SearchPathSource::LoginShell,
        note: None,
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_tool_reports_not_found() {
        let defs = vec![ToolDefinition {
            id: "nope".into(),
            display_name: "Nope".into(),
            executables: vec!["orchevia-definitely-missing-binary-xyz".into()],
            version_args: vec!["--version".into()],
        }];
        let statuses = discover_tools(&defs);
        assert_eq!(statuses.len(), 1);
        assert!(!statuses[0].installed);
        assert!(statuses[0].version.is_none());
    }

    #[test]
    fn echo_based_tool_is_discovered() {
        // `sh` should exist on every Unix dev machine; use it as a stand-in.
        let defs = vec![ToolDefinition {
            id: "sh".into(),
            display_name: "Shell".into(),
            executables: vec!["sh".into()],
            version_args: vec!["--version".into()],
        }];
        let statuses = discover_tools(&defs);
        assert!(statuses[0].installed);
        assert!(statuses[0].path.is_some());
    }

    #[cfg(unix)]
    fn write_executable(path: &Path, body: &str) {
        use std::os::unix::fs::PermissionsExt;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).expect("mkdir");
        }
        std::fs::write(path, body).expect("write");
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).expect("chmod");
    }

    #[cfg(unix)]
    #[test]
    fn fallback_candidates_find_home_binaries() {
        let dir = tempfile::tempdir().expect("tempdir");
        let bin_dir = dir.path().join(".local").join("bin");
        let exe = bin_dir.join("orchevia-fake-claude-xyz");
        write_executable(&exe, "#!/bin/sh\nexit 0\n");
        let found = fallback_candidates("orchevia-fake-claude-xyz", Some(dir.path()));
        assert_eq!(found, vec![exe]);
        assert!(
            fallback_candidates("orchevia-definitely-missing-xyz", Some(dir.path())).is_empty()
        );
    }

    #[test]
    fn fallback_candidates_reject_non_files() {
        let dir = tempfile::tempdir().expect("tempdir");
        // A directory with the exe name must not match.
        std::fs::create_dir_all(dir.path().join(".local").join("bin").join("mydir"))
            .expect("mkdir");
        assert!(fallback_candidates("mydir", Some(dir.path())).is_empty());
    }

    #[test]
    fn resolve_executable_prefers_absolute_paths() {
        let dir = tempfile::tempdir().expect("tempdir");
        let exe = dir.path().join("my-tool");
        std::fs::write(&exe, "#!/bin/sh\nexit 0\n").expect("write");
        let abs = exe.to_string_lossy().into_owned();
        assert_eq!(resolve_executable(&abs).as_deref(), Some(abs.as_str()));
        assert!(resolve_executable("   ").is_none());
        assert!(require_executable("orchevia-definitely-missing-xyz").is_err());
    }

    #[test]
    fn default_registry_has_four_tools() {
        let tools = default_tools();
        assert_eq!(tools.len(), 4);
        let ids: Vec<&str> = tools.iter().map(|t| t.id.as_str()).collect();
        assert!(ids.contains(&"git"));
        assert!(ids.contains(&"gh"));
        assert!(ids.contains(&"claude"));
        assert!(ids.contains(&"codex"));
    }

    #[cfg(unix)]
    #[test]
    fn executables_need_the_exec_bit_and_cached_hits_are_revalidated() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().expect("tempdir");
        let exe = dir.path().join("orchevia-exec-bit-xyz");
        std::fs::write(&exe, "#!/bin/sh\nexit 0\n").expect("write");
        let env = SearchEnvironment::fallback(Some(dir.path().as_os_str()), None, None);
        assert!(env.find("orchevia-exec-bit-xyz").is_none(), "no exec bit");
        assert!(!is_executable_file(&exe));
        std::fs::set_permissions(&exe, std::fs::Permissions::from_mode(0o755)).expect("chmod");
        let mut cache = HashMap::new();
        assert_eq!(
            cached_lookup(&env, &mut cache, "orchevia-exec-bit-xyz"),
            Some(exe.clone())
        );
        assert_eq!(cache.get("orchevia-exec-bit-xyz"), Some(&exe));
        // A cached path that stops being executable is dropped, not reused.
        std::fs::set_permissions(&exe, std::fs::Permissions::from_mode(0o644)).expect("chmod");
        assert_eq!(
            cached_lookup(&env, &mut cache, "orchevia-exec-bit-xyz"),
            None
        );
        assert!(cache.is_empty());
    }

    #[test]
    fn login_path_parsing_ignores_rc_noise() {
        let output =
            "Last login: Thu\n__M__ banner\n\n__M__\n\n/home/u/.nvm/bin:/usr/bin\n__M__\nbye\n";
        assert_eq!(
            parse_login_path(output, "__M__").as_deref(),
            Some("/home/u/.nvm/bin:/usr/bin")
        );
        assert_eq!(parse_login_path("no markers here", "__M__"), None);
        assert_eq!(parse_login_path("__M__\n\n__M__\n", "__M__"), None);
        assert_eq!(
            parse_login_path("__M__\r\n/bin\r\n__M__\r\n", "__M__").as_deref(),
            Some("/bin")
        );
    }

    #[test]
    fn login_path_comes_first_and_relative_entries_are_dropped() {
        let env = SearchEnvironment::from_login(
            OsStr::new("/login/bin:relative/bin::/usr/bin"),
            Some(OsStr::new("/usr/bin:/gui/bin:.")),
            None,
        );
        assert_eq!(env.source(), SearchPathSource::LoginShell);
        let dirs: Vec<_> = env.dirs().iter().take(3).cloned().collect();
        assert_eq!(
            dirs,
            [
                PathBuf::from("/login/bin"),
                PathBuf::from("/usr/bin"),
                PathBuf::from("/gui/bin")
            ]
        );
        assert!(env.dirs().iter().all(|d| d.is_absolute()));
    }

    #[cfg(unix)]
    #[test]
    fn noisy_login_shell_reports_path_promptly_and_its_jobs_are_stopped() {
        let dir = tempfile::tempdir().expect("tempdir");
        let shell = dir.path().join("fake-shell");
        let job = dir.path().join("job.pid");
        write_executable(
            &shell,
            &format!(
                "#!/bin/sh\necho 'Last login: today'\necho 'rc warning' >&2\nsleep 30 &\necho $$ > {}\nfor script; do :; done\nPATH=\"/orchevia-login-test/bin:$PATH\" /bin/sh -c \"$script\"\necho 'bye from zlogout'\n",
                shell_escape::escape(job.to_string_lossy())
            ),
        );
        let started = Instant::now();
        let env = resolve_search_environment(Some(&shell), None, Duration::from_secs(5));
        // The rc job keeps stdout open; parsing stops at the markers instead.
        assert!(
            started.elapsed() < Duration::from_secs(3),
            "{:?}",
            started.elapsed()
        );
        assert_eq!(
            env.source(),
            SearchPathSource::LoginShell,
            "{:?}",
            env.note()
        );
        assert_eq!(env.dirs()[0], PathBuf::from("/orchevia-login-test/bin"));
        let group: u32 = std::fs::read_to_string(&job)
            .expect("pid")
            .trim()
            .parse()
            .expect("number");
        let deadline = Instant::now() + Duration::from_secs(3);
        while crate::process::process_group_alive(group) && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(
            !crate::process::process_group_alive(group),
            "rc job survived"
        );
    }

    #[cfg(unix)]
    #[test]
    fn hung_login_shell_times_out_to_the_safe_fallback() {
        let dir = tempfile::tempdir().expect("tempdir");
        let shell = dir.path().join("hung-shell");
        write_executable(&shell, "#!/bin/sh\necho 'starting'\nsleep 30\n");
        let started = Instant::now();
        let env = resolve_search_environment(Some(&shell), None, Duration::from_millis(300));
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "{:?}",
            started.elapsed()
        );
        assert_eq!(env.source(), SearchPathSource::Fallback);
        assert!(env.note().unwrap_or("").contains("did not report PATH"));
        // The fallback still carries Orchevia's own PATH.
        assert!(env.find("sh").is_some());
        let missing = resolve_search_environment(None, None, Duration::from_millis(300));
        assert_eq!(missing.source(), SearchPathSource::Fallback);
    }

    #[cfg(unix)]
    #[test]
    fn nvm_default_alias_or_newest_version_is_used() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path().join(".nvm");
        for version in ["v20.1.0", "v22.3.0", "v9.0.0"] {
            std::fs::create_dir_all(root.join("versions/node").join(version).join("bin"))
                .expect("mkdir");
        }
        let newest = root.join("versions/node/v22.3.0/bin");
        assert_eq!(nvm_default_bin(&root), Some(newest.clone()));
        std::fs::create_dir_all(root.join("alias")).expect("alias dir");
        std::fs::write(root.join("alias/default"), "20\n").expect("alias");
        assert_eq!(
            nvm_default_bin(&root),
            Some(root.join("versions/node/v20.1.0/bin"))
        );
        std::fs::write(root.join("alias/default"), "lts/*").expect("alias");
        assert_eq!(nvm_default_bin(&root), Some(newest));
        let dirs = well_known_dirs(Some(dir.path()));
        for expected in [
            ".bun/bin",
            ".cargo/bin",
            ".claude/local",
            ".local/share/pnpm",
        ] {
            assert!(dirs.contains(&dir.path().join(expected)), "{expected}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn children_get_the_resolved_path_for_env_shebangs() {
        let dir = tempfile::tempdir().expect("tempdir");
        let interpreters = dir.path().join("interpreters");
        write_executable(
            &interpreters.join("orchevia-fake-node-xyz"),
            "#!/bin/sh\nprintf 'fake-node ran %s' \"$(basename \"$1\")\"\n",
        );
        let cli = dir.path().join("cli").join("fake-claude");
        write_executable(&cli, "#!/usr/bin/env orchevia-fake-node-xyz\n");
        // Orchevia's own PATH cannot find the interpreter…
        let own = SearchEnvironment::fallback(std::env::var_os("PATH").as_deref(), None, None);
        assert!(own.find("orchevia-fake-node-xyz").is_none());
        // …but once the login shell reports it, the CLI's children can.
        prepend_search_dir_for_tests(&interpreters);
        assert_eq!(
            find_executable("orchevia-fake-node-xyz"),
            Some(interpreters.join("orchevia-fake-node-xyz"))
        );
        let result = run_command(
            &CommandSpec {
                executable: cli.to_string_lossy().into_owned(),
                args: vec![],
                working_dir: None,
                stdin: None,
            },
            Some(Duration::from_secs(10)),
        )
        .expect("run");
        assert_eq!(result.exit_code, Some(0), "{}", result.stderr);
        assert_eq!(result.stdout, "fake-node ran fake-claude");
    }
}
