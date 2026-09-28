//! Safe child-process execution.
//!
//! Security rules enforced here:
//! - executable and arguments are passed separately to [`std::process::Command`];
//!   no shell is involved, so shell metacharacters in arguments are inert;
//! - callers decide the working directory explicitly; it must exist;
//! - environments are inherited, never dumped or persisted;
//! - stdout/stderr are captured with a configurable cap to avoid unbounded memory.

use std::path::Path;
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
}

impl CommandSpec {
    /// Human-readable preview with shell escaping (display only).
    pub fn preview(&self) -> String {
        let mut parts = vec![shell_escape::escape(self.executable.clone().into()).to_string()];
        for arg in &self.args {
            parts.push(shell_escape::escape(arg.clone().into()).to_string());
        }
        parts.join(" ")
    }
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
    if let Some(dir) = spec.working_dir.as_deref() {
        cmd.current_dir(dir);
    }
    // Avoid interactive prompts inheriting the terminal.
    cmd.stdin(std::process::Stdio::null());
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());

    run_with_timeout(cmd, timeout, &spec.executable, started)
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

/// Poll-based timeout that kills the child on expiry. Simple and portable.
fn run_with_timeout(
    mut cmd: std::process::Command,
    limit: Option<Duration>,
    executable: &str,
    started: Instant,
) -> Result<ProcessResult, ProcessError> {
    let mut child = cmd
        .spawn()
        .map_err(|e| ProcessError::Spawn(executable.to_string(), e))?;
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
            let _ = child.kill();
            let _ = child.wait();
            return Err(ProcessError::Wait(executable.to_string(), error));
        }
    };
    let mut timed_out = false;
    loop {
        match child
            .try_wait()
            .map_err(|e| ProcessError::Wait(executable.to_string(), e))?
        {
            Some(status) => {
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
                    let _ = child.kill();
                    timed_out = true;
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
        };
        let preview = spec.preview();
        assert!(preview.contains("hello\\ world") || preview.contains("'hello world'"));
    }
}
