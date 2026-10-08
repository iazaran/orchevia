//! Safe child-process execution.
//!
//! Security rules enforced here:
//! - executable and arguments are passed separately to [`std::process::Command`];
//!   no shell is involved, so shell metacharacters in arguments are inert;
//! - callers decide the working directory explicitly; it must exist;
//! - environments are inherited, never dumped or persisted; `PATH` is replaced
//!   by the resolved search path from [`crate::tools::child_path`];
//! - stdout/stderr are captured with a configurable cap to avoid unbounded memory;
//! - on Unix every child leads its own process group so timeouts, cancellation
//!   and app exit stop its descendants too (see [`ProcessGroup`]).

use std::io::Write;
use std::path::Path;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum ProcessError {
    #[error("executable must not be empty")]
    EmptyExecutable,
    #[error("working directory does not exist: {0}")]
    MissingWorkingDir(String),
    #[error("failed to spawn '{0}': {1}")]
    Spawn(String, std::io::Error),
    #[error("failed to wait on '{0}': {1}")]
    Wait(String, std::io::Error),
}

#[derive(Debug, Clone)]
pub struct ProcessResult {
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub duration_ms: u64,
    pub timed_out: bool,
}

/// Maximum bytes kept per stream (remainder truncated with a marker).
pub const MAX_STREAM_BYTES: usize = 256 * 1024;

/// Specification of a command to run. Used for previews and execution alike.
#[derive(Debug, Clone)]
pub struct CommandSpec {
    pub executable: String,
    pub args: Vec<String>,
    pub working_dir: Option<String>,
    /// Text written to the child's stdin, which is then closed (EOF). `None`
    /// connects stdin to null. Prompts travel here so they never hit argv
    /// length limits or appear in other users' process listings.
    pub stdin: Option<String>,
}

impl CommandSpec {
    /// Human-readable preview with shell escaping (display only). Stdin
    /// content is summarized, never inlined.
    pub fn preview(&self) -> String {
        let mut parts = vec![shell_escape::escape(self.executable.clone().into()).to_string()];
        for arg in &self.args {
            parts.push(shell_escape::escape(arg.clone().into()).to_string());
        }
        if let Some(input) = &self.stdin {
            parts.push(format!(
                "<prompt via stdin, {} chars>",
                input.chars().count()
            ));
        }
        parts.join(" ")
    }
}

/// Time between `SIGTERM` and `SIGKILL` when stopping a process group.
pub const TERMINATE_GRACE: Duration = Duration::from_secs(2);

/// Process groups that may still need cleanup when the application exits.
static LIVE_GROUPS: Mutex<Vec<u32>> = Mutex::new(Vec::new());

/// Start a child as the leader of a new process group (Unix only), so
/// [`ProcessGroup`] can signal it together with its descendants.
pub fn isolate_process_group(cmd: &mut std::process::Command) {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    #[cfg(not(unix))]
    let _ = cmd;
}

/// Ownership of a spawned child's process group.
///
/// Cancellation, timeouts and app exit call [`ProcessGroup::terminate`] /
/// [`ProcessGroup::kill`]. A normal exit calls [`ProcessGroup::release`] and
/// leaves deliberately backgrounded descendants alone, as before. Dropping an
/// unreleased group (for example an aborted task) kills it. Windows keeps the
/// direct-child kill performed by callers.
#[derive(Debug)]
pub struct ProcessGroup {
    pgid: Option<u32>,
}

impl ProcessGroup {
    /// Track the group led by `pid` (the direct child spawned with
    /// [`isolate_process_group`]).
    pub fn new(pid: Option<u32>) -> Self {
        let pgid = pid.filter(|pid| cfg!(unix) && *pid > 1);
        if let Some(id) = pgid {
            if let Ok(mut live) = LIVE_GROUPS.lock() {
                live.push(id);
            }
        }
        Self { pgid }
    }

    /// Ask every process in the group to stop (`SIGTERM`).
    pub fn terminate(&self) {
        if let Some(id) = self.pgid {
            signal_group(id, Signal::Terminate);
        }
    }

    /// Stop every remaining process in the group immediately (`SIGKILL`).
    pub fn kill(&self) {
        if let Some(id) = self.pgid {
            signal_group(id, Signal::Kill);
        }
    }

    /// The direct child finished normally; stop tracking without signalling.
    pub fn release(&mut self) {
        if let Some(id) = self.pgid.take() {
            unregister(id);
        }
    }
}

impl Drop for ProcessGroup {
    fn drop(&mut self) {
        if let Some(id) = self.pgid.take() {
            signal_group(id, Signal::Kill);
            unregister(id);
        }
    }
}

fn unregister(id: u32) {
    if let Ok(mut live) = LIVE_GROUPS.lock() {
        live.retain(|other| *other != id);
    }
}

#[derive(Clone, Copy)]
enum Signal {
    Probe,
    Terminate,
    Kill,
}

/// Send `signal` to process group `pgid`. Returns whether any process received it.
#[cfg(unix)]
fn signal_group(pgid: u32, signal: Signal) -> bool {
    let Ok(pgid) = libc::pid_t::try_from(pgid) else {
        return false;
    };
    if pgid <= 1 {
        return false;
    }
    let signal = match signal {
        Signal::Probe => 0,
        Signal::Terminate => libc::SIGTERM,
        Signal::Kill => libc::SIGKILL,
    };
    // SAFETY: killpg takes two integers and has no memory-safety requirements;
    // `pgid` is a group this process created and is never 0 or 1.
    unsafe { libc::killpg(pgid, signal) == 0 }
}

#[cfg(not(unix))]
fn signal_group(_pgid: u32, _signal: Signal) -> bool {
    false
}

/// Whether any process remains in group `pgid` (Unix; always false elsewhere).
pub fn process_group_alive(pgid: u32) -> bool {
    signal_group(pgid, Signal::Probe)
}

/// Stop every tracked child process group: `SIGTERM`, up to
/// [`TERMINATE_GRACE`] for them to exit, then `SIGKILL`. Called on app exit.
pub fn terminate_all_process_groups() {
    let groups = LIVE_GROUPS
        .lock()
        .map(|live| live.clone())
        .unwrap_or_default();
    terminate_groups(&groups);
}

fn terminate_groups(groups: &[u32]) {
    for id in groups {
        signal_group(*id, Signal::Terminate);
    }
    let deadline = Instant::now() + TERMINATE_GRACE;
    while Instant::now() < deadline && groups.iter().any(|id| process_group_alive(*id)) {
        std::thread::sleep(Duration::from_millis(25));
    }
    for id in groups {
        signal_group(*id, Signal::Kill);
    }
}

/// Write `input` to a child's stdin on a detached thread, then close it (EOF).
/// A child that exits without reading produces `EPIPE`, which is ignored; the
/// writer never delays result collection.
pub(crate) fn feed_stdin(pipe: std::process::ChildStdin, input: String) -> std::io::Result<()> {
    std::thread::Builder::new()
        .name("orchevia-stdin".into())
        .spawn(move || {
            let mut pipe = pipe;
            let _ = pipe.write_all(input.as_bytes());
        })
        .map(|_| ())
}

/// Run a command to completion. Blocks the calling thread; Tauri callers run
/// this on a blocking thread pool so the UI stays responsive.
pub fn run_command(
    spec: &CommandSpec,
    timeout: Option<Duration>,
) -> Result<ProcessResult, ProcessError> {
    if spec.executable.trim().is_empty() {
        return Err(ProcessError::EmptyExecutable);
    }
    if let Some(dir) = spec.working_dir.as_deref() {
        if !Path::new(dir).is_dir() {
            return Err(ProcessError::MissingWorkingDir(dir.to_string()));
        }
    }
    let exe = crate::tools::require_executable(&spec.executable).map_err(|message| {
        ProcessError::Spawn(
            spec.executable.clone(),
            std::io::Error::new(std::io::ErrorKind::NotFound, message),
        )
    })?;
    let started = Instant::now();
    let mut cmd = std::process::Command::new(&exe);
    cmd.args(&spec.args);
    cmd.env("PATH", crate::tools::child_path());
    if let Some(dir) = spec.working_dir.as_deref() {
        cmd.current_dir(dir);
    }
    // Avoid interactive prompts inheriting the terminal.
    cmd.stdin(if spec.stdin.is_some() {
        std::process::Stdio::piped()
    } else {
        std::process::Stdio::null()
    });
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());
    isolate_process_group(&mut cmd);

    run_with_timeout(cmd, timeout, &spec.executable, spec.stdin.clone(), started)
}

fn finish(output: std::process::Output, started: Instant, timed_out: bool) -> ProcessResult {
    ProcessResult {
        exit_code: output.status.code(),
        stdout: truncate_lossy(output.stdout),
        stderr: truncate_lossy(output.stderr),
        duration_ms: started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64,
        timed_out,
    }
}

fn truncate_lossy(bytes: Vec<u8>) -> String {
    let mut s = String::from_utf8_lossy(&bytes).into_owned();
    if s.len() > MAX_STREAM_BYTES {
        let mut end = MAX_STREAM_BYTES;
        while !s.is_char_boundary(end) {
            end -= 1;
        }
        s.truncate(end);
        s.push_str("\n… [truncated]");
    }
    s
}

/// Poll-based timeout that stops the child's process group on expiry
/// (`SIGTERM`, grace period, `SIGKILL`). Simple and portable.
fn run_with_timeout(
    mut cmd: std::process::Command,
    limit: Option<Duration>,
    executable: &str,
    input: Option<String>,
    started: Instant,
) -> Result<ProcessResult, ProcessError> {
    let mut child = cmd
        .spawn()
        .map_err(|e| ProcessError::Spawn(executable.to_string(), e))?;
    let mut group = ProcessGroup::new(Some(child.id()));
    if let (Some(input), Some(pipe)) = (input, child.stdin.take()) {
        if let Err(error) = feed_stdin(pipe, input) {
            group.kill();
            let _ = child.kill();
            let _ = child.wait();
            return Err(ProcessError::Wait(executable.to_string(), error));
        }
    }
    // Drain both pipes while the child is alive; otherwise a verbose child
    // blocks on a full pipe and can never exit before its timeout.
    struct Reader {
        captured: std::sync::Arc<std::sync::Mutex<Vec<u8>>>,
        done: std::sync::mpsc::Receiver<()>,
    }
    impl Reader {
        fn finish(self, deadline: Instant, executable: &str) -> Result<Vec<u8>, ProcessError> {
            // A grandchild can inherit a pipe after the direct child exits.
            // Bound the drain; detached readers retain only capped buffers.
            let _ = self
                .done
                .recv_timeout(deadline.saturating_duration_since(Instant::now()));
            self.captured
                .lock()
                .map(|bytes| bytes.clone())
                .map_err(|_| {
                    ProcessError::Wait(
                        executable.to_string(),
                        std::io::Error::other("output capture poisoned"),
                    )
                })
        }
    }
    fn reader<R: std::io::Read + Send + 'static>(pipe: Option<R>) -> std::io::Result<Reader> {
        let captured = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let output = std::sync::Arc::clone(&captured);
        let (done, receiver) = std::sync::mpsc::sync_channel(1);
        std::thread::Builder::new().spawn(move || {
            if let Some(mut pipe) = pipe {
                let mut chunk = [0u8; 8192];
                loop {
                    match pipe.read(&mut chunk) {
                        Ok(0) => break,
                        Ok(n) => {
                            let Ok(mut kept) = output.lock() else { break };
                            let retain = n.min((MAX_STREAM_BYTES + 1).saturating_sub(kept.len()));
                            kept.extend_from_slice(&chunk[..retain]);
                        }
                        Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                        Err(_) => break,
                    }
                }
            }
            let _ = done.send(());
        })?;
        Ok(Reader {
            captured,
            done: receiver,
        })
    }
    let readers = reader(child.stdout.take())
        .and_then(|stdout| reader(child.stderr.take()).map(|stderr| (stdout, stderr)));
    let (stdout, stderr) = match readers {
        Ok(readers) => readers,
        Err(error) => {
            group.kill();
            let _ = child.kill();
            let _ = child.wait();
            return Err(ProcessError::Wait(executable.to_string(), error));
        }
    };
    let mut timed_out = false;
    let mut terminated_at: Option<Instant> = None;
    loop {
        match child
            .try_wait()
            .map_err(|e| ProcessError::Wait(executable.to_string(), e))?
        {
            Some(status) => {
                if timed_out {
                    // Descendants that ignored SIGTERM must not outlive the timeout.
                    group.kill();
                }
                group.release();
                let drain_deadline = Instant::now() + Duration::from_secs(2);
                return Ok(finish(
                    std::process::Output {
                        status,
                        stdout: stdout.finish(drain_deadline, executable)?,
                        stderr: stderr.finish(drain_deadline, executable)?,
                    },
                    started,
                    timed_out,
                ));
            }
            None => {
                if !timed_out && limit.is_some_and(|limit| started.elapsed() >= limit) {
                    group.terminate();
                    terminated_at = Some(Instant::now());
                    timed_out = true;
                    #[cfg(not(unix))]
                    let _ = child.kill();
                }
                if terminated_at.is_some_and(|at| at.elapsed() >= TERMINATE_GRACE) {
                    group.kill();
                    let _ = child.kill();
                    terminated_at = None;
                }
                std::thread::sleep(Duration::from_millis(25));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn verbose_command_is_drained_before_its_timeout() {
        let spec = CommandSpec {
            executable: "sh".into(),
            args: vec![
                "-c".into(),
                "head -c 1048576 /dev/zero; head -c 1048576 /dev/zero >&2".into(),
            ],
            working_dir: None,
            stdin: None,
        };
        let result = run_command(&spec, Some(Duration::from_secs(2))).expect("run");
        assert!(
            !result.timed_out,
            "a successful verbose child must not block on its pipes"
        );
        assert_eq!(result.exit_code, Some(0));
        assert!(result.stdout.ends_with("… [truncated]"));
        assert!(result.stderr.ends_with("… [truncated]"));
        assert!(result.stdout.len() < 262200);
        assert!(result.stderr.len() < 262200);
    }

    #[test]
    fn truncating_output_preserves_a_utf8_boundary() {
        let mut bytes = vec![b'a'; MAX_STREAM_BYTES - 1];
        bytes.extend_from_slice("é trailing".as_bytes());
        let output = truncate_lossy(bytes);
        assert!(output.ends_with("… [truncated]"));
        assert!(!output.contains('é'));
    }

    #[cfg(unix)]
    #[test]
    fn exited_child_does_not_wait_forever_for_a_background_pipe_holder() {
        let spec = CommandSpec {
            executable: "sh".into(),
            args: vec!["-c".into(), "printf before; sleep 4 &".into()],
            working_dir: None,
            stdin: None,
        };
        let started = Instant::now();
        let result = run_command(&spec, Some(Duration::from_secs(1))).expect("run");
        assert!(started.elapsed() < Duration::from_millis(2750));
        assert_eq!(result.stdout, "before");
        assert_eq!(result.exit_code, Some(0));
        assert!(!result.timed_out);
    }

    #[cfg(unix)]
    #[test]
    fn timed_out_child_keeps_partial_output_without_waiting_for_descendants() {
        let spec = CommandSpec {
            executable: "sh".into(),
            args: vec!["-c".into(), "printf before; sleep 4 & wait".into()],
            working_dir: None,
            stdin: None,
        };
        let started = Instant::now();
        let result = run_command(&spec, Some(Duration::from_millis(100))).expect("run");
        assert!(started.elapsed() < Duration::from_millis(2750));
        assert_eq!(result.stdout, "before");
        assert!(result.timed_out);
    }

    #[test]
    fn runs_echo_successfully() {
        let spec = CommandSpec {
            executable: "echo".into(),
            args: vec!["hello".into()],
            working_dir: None,
            stdin: None,
        };
        let result = run_command(&spec, None).expect("run");
        assert_eq!(result.exit_code, Some(0));
        assert!(result.stdout.contains("hello"));
        assert!(!result.timed_out);
    }

    #[test]
    fn nonzero_exit_is_captured_not_error() {
        let spec = CommandSpec {
            executable: "false".into(),
            args: vec![],
            working_dir: None,
            stdin: None,
        };
        let result = run_command(&spec, None).expect("run");
        assert_ne!(result.exit_code, Some(0));
    }

    #[test]
    fn empty_executable_rejected() {
        let spec = CommandSpec {
            executable: "   ".into(),
            args: vec![],
            working_dir: None,
            stdin: None,
        };
        assert!(matches!(
            run_command(&spec, None),
            Err(ProcessError::EmptyExecutable)
        ));
    }

    #[test]
    fn missing_working_dir_rejected() {
        let spec = CommandSpec {
            executable: "echo".into(),
            args: vec![],
            working_dir: Some("/definitely/not/a/real/dir-xyz".into()),
            stdin: None,
        };
        assert!(matches!(
            run_command(&spec, None),
            Err(ProcessError::MissingWorkingDir(_))
        ));
    }

    #[test]
    fn arguments_are_not_shell_interpreted() {
        // If a shell were involved, `$(...)` or `;` would execute.
        let spec = CommandSpec {
            executable: "echo".into(),
            args: vec!["a; echo pwned".into(), "$(echo pwned)".into()],
            working_dir: None,
            stdin: None,
        };
        let result = run_command(&spec, None).expect("run");
        assert!(result.stdout.contains("a; echo pwned"));
    }

    #[test]
    fn preview_escapes_spaces() {
        let spec = CommandSpec {
            executable: "git".into(),
            args: vec!["commit".into(), "-m".into(), "hello world".into()],
            working_dir: None,
            stdin: None,
        };
        let preview = spec.preview();
        assert!(preview.contains("hello\\ world") || preview.contains("'hello world'"));
    }

    #[cfg(unix)]
    #[test]
    fn large_stdin_is_delivered_and_closed() {
        // 300 KB exceeds Linux's 128 KiB single-argument limit; `wc` only
        // finishes once stdin reaches EOF.
        let spec = CommandSpec {
            executable: "sh".into(),
            args: vec!["-c".into(), "wc -c | tr -d ' '".into()],
            working_dir: None,
            stdin: Some("x".repeat(300_000)),
        };
        let result = run_command(&spec, Some(Duration::from_secs(10))).expect("run");
        assert!(!result.timed_out);
        assert_eq!(result.stdout.trim(), "300000");
        assert!(spec.preview().ends_with("<prompt via stdin, 300000 chars>"));
        assert!(!spec.preview().contains("xxxx"));
    }

    #[cfg(unix)]
    #[test]
    fn child_exiting_without_reading_stdin_does_not_hang() {
        let spec = CommandSpec {
            executable: "sh".into(),
            args: vec!["-c".into(), "printf early; exit 3".into()],
            working_dir: None,
            stdin: Some("y".repeat(4 * 1024 * 1024)),
        };
        let started = Instant::now();
        let result = run_command(&spec, Some(Duration::from_secs(10))).expect("run");
        assert!(started.elapsed() < Duration::from_secs(3));
        assert_eq!(result.exit_code, Some(3));
        assert_eq!(result.stdout, "early");
    }

    #[cfg(unix)]
    fn wait_until_group_gone(group: u32) -> bool {
        let deadline = Instant::now() + Duration::from_secs(3);
        while process_group_alive(group) && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        !process_group_alive(group)
    }

    #[cfg(unix)]
    #[test]
    fn timeout_stops_descendants_in_the_process_group() {
        let dir = tempfile::tempdir().expect("tempdir");
        let group_file = dir.path().join("group");
        let spec = CommandSpec {
            executable: "sh".into(),
            args: vec![
                "-c".into(),
                format!(
                    "echo $$ > {}; sleep 30 & printf started; wait",
                    shell_escape::escape(group_file.to_string_lossy())
                ),
            ],
            working_dir: None,
            stdin: None,
        };
        let result = run_command(&spec, Some(Duration::from_millis(300))).expect("run");
        assert!(result.timed_out);
        assert_eq!(result.stdout, "started");
        let group: u32 = std::fs::read_to_string(&group_file)
            .expect("group")
            .trim()
            .parse()
            .expect("pid");
        assert!(
            wait_until_group_gone(group),
            "grandchild survived the timeout"
        );
    }

    #[cfg(unix)]
    #[test]
    fn app_exit_cleanup_stops_tracked_groups() {
        let mut child = {
            let mut cmd = std::process::Command::new("sh");
            cmd.args(["-c", "sleep 30 & wait"]);
            isolate_process_group(&mut cmd);
            cmd.spawn().expect("spawn")
        };
        let mut group = ProcessGroup::new(Some(child.id()));
        assert!(process_group_alive(child.id()));
        let tracked = LIVE_GROUPS.lock().expect("registry").clone();
        assert!(tracked.contains(&child.id()));
        // Exit cleanup signals the tracked list; scoped here so parallel
        // tests keep their own children.
        terminate_groups(&[child.id()]);
        let _ = child.wait();
        assert!(wait_until_group_gone(child.id()));
        group.release();
        assert!(!LIVE_GROUPS.lock().expect("registry").contains(&child.id()));
    }
}
