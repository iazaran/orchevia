//! Files a run made (v0.4.0): what its steps created or changed in the
//! folders they ran in, so Runs can preview a report, an image or a video
//! next to the log. Everything here only reads, except `open_run_file`, which
//! hands a listed document to the system's default app.
//!
//! A run's folders come from its workflow snapshot: the repository folder,
//! each Command or Agent step's own folder, the folder of a profile that sets
//! its own, and the workflow's workspace folder when a step uses it. A file
//! counts when it changed between the run's start and end. Hidden entries and
//! dependency or build folders are never listed, read or opened.

use crate::agents::WorkingDirMode;
use crate::db::SqliteDb;
use crate::workflow::NodeKind;
use chrono::{DateTime, Utc};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

/// Folders never walked: dependencies, build output, caches and tool state.
const SKIPPED_DIRS: &[&str] = &[
    "node_modules",
    "target",
    "dist",
    "build",
    "vendor",
    "venv",
    "__pycache__",
    "coverage",
    "Pods",
    "DerivedData",
];
/// How deep below a run folder files are looked for.
const MAX_DEPTH: usize = 8;
/// Entries visited in each run folder, so a home-folder repository stays
/// quick and one large folder cannot hide the others.
const MAX_VISITED: usize = 50_000;
/// Files returned, newest first.
const MAX_FILES: usize = 300;
/// Text shown in a preview.
pub const MAX_TEXT_BYTES: u64 = 512 * 1024;
/// Images, audio, video and PDFs previewed inline.
pub const MAX_MEDIA_BYTES: u64 = 20 * 1024 * 1024;
/// File-system clocks and the run's clock can differ by a moment.
const CLOCK_SLACK: Duration = Duration::from_secs(2);
/// Writes that land just after a step reports back still belong to the run.
const FINISH_SLACK: Duration = Duration::from_secs(10);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RunFileKind {
    Image,
    Video,
    Audio,
    Pdf,
    Markdown,
    Text,
    Document,
    Other,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunFile {
    pub path: String,
    pub folder: String,
    pub rel_path: String,
    pub size: u64,
    pub modified_at: DateTime<Utc>,
    pub kind: RunFileKind,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunFiles {
    /// Folders looked in, as they exist now.
    pub folders: Vec<String>,
    pub files: Vec<RunFile>,
    /// More files changed than are listed, or the walk stopped early.
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunFilePreview {
    pub path: String,
    pub kind: RunFileKind,
    pub mime: String,
    pub size: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base64: Option<String>,
    /// Text cut at `MAX_TEXT_BYTES`, or media too large to show inline.
    pub truncated: bool,
}

fn extension(path: &Path) -> String {
    path.extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
}

/// What a file is, by its extension. Mirrors `fileKindOf` in
/// `src/lib/outputs.ts`.
pub fn kind_of(path: &Path) -> RunFileKind {
    match extension(path).as_str() {
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "svg" | "avif" | "bmp" | "ico" => {
            RunFileKind::Image
        }
        "mp4" | "webm" | "mov" | "m4v" | "mkv" | "ogv" | "avi" => RunFileKind::Video,
        "mp3" | "wav" | "ogg" | "oga" | "m4a" | "flac" | "aac" | "opus" => RunFileKind::Audio,
        "pdf" => RunFileKind::Pdf,
        "md" | "markdown" | "mdx" => RunFileKind::Markdown,
        "txt" | "csv" | "tsv" | "json" | "jsonl" | "yaml" | "yml" | "toml" | "xml" | "html"
        | "htm" | "css" | "js" | "mjs" | "ts" | "tsx" | "jsx" | "py" | "rs" | "go" | "rb"
        | "java" | "kt" | "swift" | "c" | "h" | "cpp" | "sh" | "sql" | "log" | "ini" | "cfg"
        | "conf" | "srt" | "vtt" | "tex" | "rst" | "adoc" | "php" | "vue" | "svelte" => {
            RunFileKind::Text
        }
        "docx" | "doc" | "xlsx" | "xls" | "pptx" | "ppt" | "odt" | "ods" | "odp" | "rtf"
        | "epub" | "key" | "pages" | "numbers" => RunFileKind::Document,
        _ => RunFileKind::Other,
    }
}

fn mime_of(path: &Path, kind: RunFileKind) -> &'static str {
    match extension(path).as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "avif" => "image/avif",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        "mp4" | "m4v" => "video/mp4",
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        "mkv" => "video/x-matroska",
        "ogv" => "video/ogg",
        "avi" => "video/x-msvideo",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "ogg" | "oga" => "audio/ogg",
        "m4a" => "audio/mp4",
        "flac" => "audio/flac",
        "aac" => "audio/aac",
        "opus" => "audio/opus",
        "pdf" => "application/pdf",
        "md" | "markdown" | "mdx" => "text/markdown",
        "csv" => "text/csv",
        "json" | "jsonl" => "application/json",
        "html" | "htm" => "text/html",
        _ if kind == RunFileKind::Text => "text/plain",
        _ => "application/octet-stream",
    }
}

/// Opened with the default app: media, PDFs, office documents and plain
/// text formats. Scripts and programs never are, even when listed.
fn safe_to_open(path: &Path) -> bool {
    match kind_of(path) {
        // SVG can carry scripts, and its default app is often a browser.
        RunFileKind::Image => extension(path) != "svg",
        RunFileKind::Video
        | RunFileKind::Audio
        | RunFileKind::Pdf
        | RunFileKind::Markdown
        | RunFileKind::Document => true,
        // Web pages and XML open in a browser that runs their scripts from a
        // local file, so they are only shown (and revealed), never opened.
        RunFileKind::Text => matches!(
            extension(path).as_str(),
            "txt" | "csv" | "tsv" | "json" | "yaml" | "yml" | "srt" | "vtt" | "log"
        ),
        RunFileKind::Other => false,
    }
}

fn hidden(name: &std::ffi::OsStr) -> bool {
    name.to_string_lossy().starts_with('.')
}

fn skipped_dir(name: &std::ffi::OsStr) -> bool {
    hidden(name) || SKIPPED_DIRS.iter().any(|skip| name == *skip)
}

/// The run's folders that exist now, canonical, without one nested in
/// another (the outer one already covers it).
pub fn run_folders(db: &SqliteDb, run_id: &str) -> Result<Vec<PathBuf>, String> {
    let workflow = db
        .get_run_workflow(run_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Run not found.".to_string())?;
    // The folder recorded when the run started wins over today's settings.
    let recorded = db
        .get_run(run_id)
        .map_err(|e| e.to_string())?
        .and_then(|run| run.execution.workspace);
    let profiles = db.list_agent_profiles().unwrap_or_default();
    let mut candidates: Vec<PathBuf> = Vec::new();
    let mut add = |dir: Option<&str>| {
        if let Some(dir) = dir.map(str::trim).filter(|d| !d.is_empty()) {
            let path = PathBuf::from(dir);
            if path.is_absolute() {
                candidates.push(path);
            }
        }
    };
    add(workflow
        .defaults
        .as_ref()
        .and_then(|d| d.repo_dir.as_deref()));
    let mut workspace = false;
    for node in &workflow.nodes {
        if !matches!(node.kind, NodeKind::Command | NodeKind::Agent) {
            continue;
        }
        add(node.config.working_dir.as_deref());
        if node.kind == NodeKind::Agent {
            let profile = node
                .config
                .agent_profile_id
                .as_deref()
                .and_then(|id| profiles.iter().find(|p| p.id == id));
            if let Some(profile) = profile.filter(|p| p.working_dir_mode == WorkingDirMode::Profile)
            {
                add(profile.working_dir.as_deref());
            }
        }
        workspace |=
            crate::workspace::step_uses_workspace(node, workflow.defaults.as_ref(), &profiles);
    }
    if workspace {
        if let Some(folder) = recorded {
            candidates.push(PathBuf::from(folder));
        } else if let Some(root) = crate::workspace::root(db) {
            candidates.push(crate::workspace::workflow_folder(
                &root,
                &workflow.name,
                &workflow.id,
            ));
        }
    }
    let mut folders: Vec<PathBuf> = candidates
        .into_iter()
        .filter_map(|p| std::fs::canonicalize(p).ok())
        .filter(|p| p.is_dir())
        .collect();
    folders.sort();
    folders.dedup();
    let nested: Vec<PathBuf> = folders
        .iter()
        .filter(|f| folders.iter().any(|o| o != *f && f.starts_with(o)))
        .cloned()
        .collect();
    folders.retain(|f| !nested.contains(f));
    Ok(folders)
}

fn system_time(at: DateTime<Utc>) -> SystemTime {
    SystemTime::from(at)
}

/// A file's status change time (Unix), when the system reports one.
fn status_changed_at(meta: &std::fs::Metadata) -> Option<SystemTime> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let secs = u64::try_from(meta.ctime()).ok()?;
        let nanos = u64::try_from(meta.ctime_nsec()).unwrap_or(0);
        SystemTime::UNIX_EPOCH
            .checked_add(Duration::from_secs(secs))?
            .checked_add(Duration::from_nanos(nanos))
    }
    #[cfg(not(unix))]
    {
        let _ = meta;
        None
    }
}

/// Whether a file changed in `[since, until]`: its modification time, or its
/// status change time, falls inside. The status time catches a copy that
/// kept an older modification time (`cp -p`, `tar`, `curl -R`); either time
/// alone suffices, so renaming or opening a file later never hides it.
fn changed_within(meta: &std::fs::Metadata, since: SystemTime, until: Option<SystemTime>) -> bool {
    let inside = |at: SystemTime| at >= since && until.is_none_or(|end| at <= end);
    meta.modified().is_ok_and(inside) || status_changed_at(meta).is_some_and(inside)
}

/// Files under `folders` modified in `[since, until]`, newest first.
pub fn scan(folders: &[PathBuf], since: SystemTime, until: Option<SystemTime>) -> RunFiles {
    let mut files: Vec<RunFile> = Vec::new();
    let mut truncated = false;
    for folder in folders {
        let mut visited = 0usize;
        let mut stack: Vec<(PathBuf, usize)> = vec![(folder.clone(), 0)];
        while let Some((dir, depth)) = stack.pop() {
            let Ok(entries) = std::fs::read_dir(&dir) else {
                continue;
            };
            for entry in entries.flatten() {
                visited += 1;
                if visited > MAX_VISITED {
                    truncated = true;
                    break;
                }
                let name = entry.file_name();
                // `file_type` does not follow links: a link is never walked
                // into or listed, so nothing outside the folder is reached.
                let Ok(kind) = entry.file_type() else {
                    continue;
                };
                if kind.is_dir() {
                    if depth + 1 < MAX_DEPTH && !skipped_dir(&name) {
                        stack.push((entry.path(), depth + 1));
                    }
                    continue;
                }
                if !kind.is_file() || hidden(&name) {
                    continue;
                }
                let Ok(meta) = entry.metadata() else {
                    continue;
                };
                if !changed_within(&meta, since, until) {
                    continue;
                }
                let Ok(modified) = meta.modified() else {
                    continue;
                };
                let path = entry.path();
                let rel = path
                    .strip_prefix(folder)
                    .map(|p| p.to_string_lossy().into_owned())
                    .unwrap_or_else(|_| name.to_string_lossy().into_owned());
                files.push(RunFile {
                    kind: kind_of(&path),
                    path: path.to_string_lossy().into_owned(),
                    folder: folder.to_string_lossy().into_owned(),
                    rel_path: rel,
                    size: meta.len(),
                    modified_at: DateTime::<Utc>::from(modified),
                });
            }
            if visited > MAX_VISITED {
                break;
            }
        }
    }
    files.sort_by(|a, b| {
        b.modified_at
            .cmp(&a.modified_at)
            .then_with(|| a.path.cmp(&b.path))
    });
    if files.len() > MAX_FILES {
        files.truncate(MAX_FILES);
        truncated = true;
    }
    RunFiles {
        folders: folders
            .iter()
            .map(|f| f.to_string_lossy().into_owned())
            .collect(),
        files,
        truncated,
    }
}

/// Files the run's steps created or changed, newest first.
pub fn list_run_files(db: &SqliteDb, run_id: &str) -> Result<RunFiles, String> {
    let run = db
        .get_run(run_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Run not found.".to_string())?;
    let folders = run_folders(db, run_id)?;
    let since = system_time(run.started_at)
        .checked_sub(CLOCK_SLACK)
        .unwrap_or(SystemTime::UNIX_EPOCH);
    // A run waiting for an approval or for feedback has a finish time too;
    // edits made while it waits (a prompt file reviewed before approving)
    // still belong to it, so only a finished run closes the window.
    let finished = matches!(
        run.status,
        crate::db::RunStatus::Succeeded
            | crate::db::RunStatus::Failed
            | crate::db::RunStatus::Cancelled
    );
    let until = run
        .finished_at
        .filter(|_| finished)
        .map(|at| system_time(at) + FINISH_SLACK);
    Ok(scan(&folders, since, until))
}

/// The canonical path of a file inside one of the run's folders, outside any
/// hidden or skipped folder. Anything else is refused.
fn run_file(db: &SqliteDb, run_id: &str, path: &str) -> Result<(PathBuf, Vec<PathBuf>), String> {
    let folders = run_folders(db, run_id)?;
    let file =
        std::fs::canonicalize(path).map_err(|_| "That file no longer exists.".to_string())?;
    check_inside(&folders, &file)?;
    if !file.is_file() {
        return Err("Only files can be opened.".into());
    }
    Ok((file, folders))
}

/// A canonical path inside one of `folders`, outside any hidden or skipped
/// folder, or why not.
fn check_inside(folders: &[PathBuf], file: &Path) -> Result<(), String> {
    let folder = folders
        .iter()
        .find(|folder| file.starts_with(folder))
        .ok_or_else(|| "Only files in this run's folders can be opened.".to_string())?;
    let inside = file.strip_prefix(folder).unwrap_or(file);
    let mut parts = inside.components().peekable();
    while let Some(part) = parts.next() {
        let name = part.as_os_str();
        let last = parts.peek().is_none();
        if hidden(name) || (!last && skipped_dir(name)) {
            return Err("Hidden files and dependency folders are not shown.".into());
        }
    }
    Ok(())
}

/// Where an open file really is, as the system reports it: a step still
/// running could swap a folder for a link between the check and the open.
#[cfg(target_os = "linux")]
fn open_file_path(file: &std::fs::File) -> Option<PathBuf> {
    use std::os::unix::io::AsRawFd;
    std::fs::read_link(format!("/proc/self/fd/{}", file.as_raw_fd())).ok()
}

#[cfg(target_os = "macos")]
fn open_file_path(file: &std::fs::File) -> Option<PathBuf> {
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::io::AsRawFd;
    let mut buf = vec![0u8; libc::PATH_MAX as usize + 1];
    // SAFETY: F_GETPATH writes at most PATH_MAX bytes and a NUL into `buf`,
    // which outlives the call; the descriptor belongs to `file`.
    let rc = unsafe { libc::fcntl(file.as_raw_fd(), libc::F_GETPATH, buf.as_mut_ptr()) };
    if rc == -1 {
        return None;
    }
    let len = buf.iter().position(|&b| b == 0)?;
    Some(PathBuf::from(std::ffi::OsStr::from_bytes(&buf[..len])))
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn open_file_path(_file: &std::fs::File) -> Option<PathBuf> {
    None
}

/// Open a checked file for reading and confirm the open file is still inside
/// the run's folders. Without a way to ask the system, the file opened must
/// be the one checked (same device and inode on Unix).
fn open_checked(file: &Path, folders: &[PathBuf]) -> Result<std::fs::File, String> {
    let handle = std::fs::File::open(file).map_err(|e| e.to_string())?;
    match open_file_path(&handle) {
        Some(real) => check_inside(folders, &real)?,
        None => {
            #[cfg(unix)]
            {
                use std::os::unix::fs::MetadataExt;
                let opened = handle.metadata().map_err(|e| e.to_string())?;
                let checked = std::fs::symlink_metadata(file).map_err(|e| e.to_string())?;
                if opened.dev() != checked.dev() || opened.ino() != checked.ino() {
                    return Err("Only files in this run's folders can be opened.".into());
                }
            }
        }
    }
    Ok(handle)
}

/// A listed file's content for preview: text (cut at 512 KiB) or base64 for
/// images, audio, video and PDFs up to 20 MiB. Other files have no content.
pub fn read_run_file(db: &SqliteDb, run_id: &str, path: &str) -> Result<RunFilePreview, String> {
    use std::io::Read;
    let (file, folders) = run_file(db, run_id, path)?;
    let handle = open_checked(&file, &folders)?;
    let size = handle.metadata().map_err(|e| e.to_string())?.len();
    let kind = kind_of(&file);
    let mut preview = RunFilePreview {
        path: file.to_string_lossy().into_owned(),
        kind,
        mime: mime_of(&file, kind).to_string(),
        size,
        text: None,
        base64: None,
        truncated: false,
    };
    let limit = match kind {
        RunFileKind::Image | RunFileKind::Video | RunFileKind::Audio | RunFileKind::Pdf => {
            if size > MAX_MEDIA_BYTES {
                preview.truncated = true;
                return Ok(preview);
            }
            MAX_MEDIA_BYTES
        }
        RunFileKind::Markdown | RunFileKind::Text => MAX_TEXT_BYTES,
        RunFileKind::Document | RunFileKind::Other => return Ok(preview),
    };
    let mut bytes = Vec::new();
    handle
        .take(limit)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if limit == MAX_TEXT_BYTES {
        preview.truncated = size > MAX_TEXT_BYTES;
        preview.text = Some(String::from_utf8_lossy(&bytes).into_owned());
    } else {
        preview.base64 = Some(base64(&bytes));
    }
    Ok(preview)
}

/// Open a listed file with its default app, or (`reveal`) show it in its
/// folder. Scripts and programs are never opened.
pub fn open_run_file(db: &SqliteDb, run_id: &str, path: &str, reveal: bool) -> Result<(), String> {
    // The system opener takes a path, so a link swapped in after this check
    // is out of reach; the check is made as late as possible.
    let (file, _) = run_file(db, run_id, path)?;
    if reveal {
        return crate::desktop::reveal_path(&file);
    }
    if !safe_to_open(&file) {
        return Err(
            "Orchevia opens documents, images, audio and video only. Use Show in folder for other files."
                .into(),
        );
    }
    crate::desktop::open_path(&file)
}

/// Standard base64 with padding (RFC 4648), for data URLs.
pub fn base64(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [
            chunk[0],
            chunk.get(1).copied().unwrap_or(0),
            chunk.get(2).copied().unwrap_or(0),
        ];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        for (i, shift) in [18u32, 12, 6, 0].into_iter().enumerate() {
            if i <= chunk.len() {
                out.push(char::from(TABLE[((n >> shift) & 63) as usize]));
            } else {
                out.push('=');
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workflow::{Node, NodeConfig, Position, Workflow, WorkflowDefaults};

    #[test]
    fn base64_matches_rfc_4648_vectors() {
        for (input, expected) in [
            ("", ""),
            ("f", "Zg=="),
            ("fo", "Zm8="),
            ("foo", "Zm9v"),
            ("foob", "Zm9vYg=="),
            ("fooba", "Zm9vYmE="),
            ("foobar", "Zm9vYmFy"),
        ] {
            assert_eq!(base64(input.as_bytes()), expected);
        }
        assert_eq!(base64(&[0xff, 0xfe, 0xfd]), "//79");
    }

    /// Shared with `src/lib/outputs.test.ts`.
    #[test]
    fn kinds_follow_the_extension() {
        let cases = [
            ("cover.PNG", RunFileKind::Image),
            ("a/b/shot.webp", RunFileKind::Image),
            ("logo.svg", RunFileKind::Image),
            ("clip.mp4", RunFileKind::Video),
            ("clip.webm", RunFileKind::Video),
            ("voice.mp3", RunFileKind::Audio),
            ("deck.pdf", RunFileKind::Pdf),
            ("post.md", RunFileKind::Markdown),
            ("data.csv", RunFileKind::Text),
            ("page.html", RunFileKind::Text),
            ("brief.docx", RunFileKind::Document),
            ("archive.zip", RunFileKind::Other),
            ("Makefile", RunFileKind::Other),
        ];
        for (name, kind) in cases {
            assert_eq!(kind_of(Path::new(name)), kind, "{name}");
        }
        assert!(safe_to_open(Path::new("x.mp4")));
        assert!(safe_to_open(Path::new("x.csv")));
        for unsafe_name in [
            "run.sh",
            "tool.py",
            "app.js",
            "x.desktop",
            "x.command",
            "x.exe",
            "page.html",
            "feed.xml",
            "image-1.svg",
        ] {
            assert!(!safe_to_open(Path::new(unsafe_name)), "{unsafe_name}");
        }
    }

    fn workflow(nodes: Vec<Node>, repo: Option<&str>) -> Workflow {
        Workflow {
            schema_version: crate::workflow::CURRENT_SCHEMA_VERSION,
            id: "wf-files".into(),
            name: "Files".into(),
            inputs: vec![],
            defaults: repo.map(|r| WorkflowDefaults {
                repo_dir: Some(r.into()),
                branch: None,
            }),
            limits: None,
            nodes,
            edges: vec![],
        }
    }

    fn step(id: &str, kind: NodeKind, dir: Option<&str>) -> Node {
        Node {
            id: id.into(),
            kind,
            position: Position { x: 0.0, y: 0.0 },
            config: NodeConfig {
                working_dir: dir.map(str::to_string),
                ..NodeConfig::default()
            },
            label: None,
        }
    }

    fn record_run(db: &SqliteDb, wf: &Workflow, run_id: &str) {
        db.upsert_workflow(wf).unwrap();
        db.create_run_with_workflow(run_id, wf, &Default::default())
            .unwrap();
    }

    #[test]
    fn a_run_lists_what_changed_in_its_folders_and_nothing_hidden() {
        let db = SqliteDb::open_in_memory().unwrap();
        let repo = tempfile::tempdir().unwrap();
        let old = repo.path().join("old.md");
        std::fs::write(&old, "before the run").unwrap();
        // Written well before the run starts (past the clock slack).
        std::thread::sleep(CLOCK_SLACK + Duration::from_millis(300));
        let wf = workflow(
            vec![step("a", NodeKind::Agent, None)],
            Some(&repo.path().to_string_lossy()),
        );
        record_run(&db, &wf, "run-files");
        std::fs::create_dir_all(repo.path().join("out/images")).unwrap();
        std::fs::write(repo.path().join("post.md"), "# Post").unwrap();
        std::fs::write(repo.path().join("out/images/cover.png"), [137, 80, 78, 71]).unwrap();
        std::fs::create_dir_all(repo.path().join("node_modules/pkg")).unwrap();
        std::fs::write(repo.path().join("node_modules/pkg/index.js"), "x").unwrap();
        std::fs::create_dir_all(repo.path().join(".git")).unwrap();
        std::fs::write(repo.path().join(".git/HEAD"), "ref").unwrap();
        std::fs::write(repo.path().join(".env"), "SECRET=1").unwrap();
        let listed = list_run_files(&db, "run-files").unwrap();
        let mut names: Vec<_> = listed.files.iter().map(|f| f.rel_path.clone()).collect();
        names.sort();
        assert_eq!(names, ["out/images/cover.png", "post.md"]);
        assert!(!listed.truncated);
        let cover = listed
            .files
            .iter()
            .find(|f| f.rel_path.ends_with("cover.png"))
            .unwrap();
        assert_eq!(cover.kind, RunFileKind::Image);
        assert_eq!(cover.size, 4);

        let preview = read_run_file(&db, "run-files", &cover.path).unwrap();
        assert_eq!(preview.mime, "image/png");
        assert_eq!(preview.base64.as_deref(), Some("iVBORw=="));
        let post = read_run_file(
            &db,
            "run-files",
            &repo.path().join("post.md").to_string_lossy(),
        )
        .unwrap();
        assert_eq!(post.text.as_deref(), Some("# Post"));
        assert_eq!(post.kind, RunFileKind::Markdown);
    }

    #[test]
    fn files_outside_the_run_or_hidden_are_refused() {
        let db = SqliteDb::open_in_memory().unwrap();
        let repo = tempfile::tempdir().unwrap();
        let elsewhere = tempfile::tempdir().unwrap();
        let wf = workflow(
            vec![step("c", NodeKind::Command, None)],
            Some(&repo.path().to_string_lossy()),
        );
        record_run(&db, &wf, "run-guard");
        let outside = elsewhere.path().join("secret.md");
        std::fs::write(&outside, "no").unwrap();
        let err = read_run_file(&db, "run-guard", &outside.to_string_lossy()).unwrap_err();
        assert!(err.contains("this run's folders"), "{err}");
        std::fs::write(repo.path().join(".env"), "SECRET=1").unwrap();
        let err = read_run_file(
            &db,
            "run-guard",
            &repo.path().join(".env").to_string_lossy(),
        )
        .unwrap_err();
        assert!(err.contains("Hidden"), "{err}");
        std::fs::create_dir_all(repo.path().join("node_modules")).unwrap();
        std::fs::write(repo.path().join("node_modules/readme.md"), "x").unwrap();
        assert!(read_run_file(
            &db,
            "run-guard",
            &repo.path().join("node_modules/readme.md").to_string_lossy()
        )
        .is_err());
        let traversal = format!("{}/../{}", repo.path().display(), outside.display());
        assert!(read_run_file(&db, "run-guard", &traversal).is_err());
        #[cfg(unix)]
        {
            let link = repo.path().join("link.md");
            std::os::unix::fs::symlink(&outside, &link).unwrap();
            let err = read_run_file(&db, "run-guard", &link.to_string_lossy()).unwrap_err();
            assert!(err.contains("this run's folders"), "{err}");
            let listed = list_run_files(&db, "run-guard").unwrap();
            assert!(listed.files.iter().all(|f| !f.rel_path.contains("link")));
        }
        std::fs::write(repo.path().join("run.sh"), "echo hi").unwrap();
        let err = open_run_file(
            &db,
            "run-guard",
            &repo.path().join("run.sh").to_string_lossy(),
            false,
        )
        .unwrap_err();
        assert!(err.contains("Show in folder"), "{err}");
    }

    #[test]
    fn workspace_and_profile_folders_count_and_nested_ones_merge() {
        let db = SqliteDb::open_in_memory().unwrap();
        let root = tempfile::tempdir().unwrap();
        db.set_setting(
            crate::workspace::WORKSPACE_ROOT_SETTING,
            &root.path().to_string_lossy(),
        )
        .unwrap();
        let wf = workflow(vec![step("a", NodeKind::Agent, None)], None);
        let folder = crate::workspace::workflow_folder(root.path(), &wf.name, &wf.id);
        std::fs::create_dir_all(folder.join("sub")).unwrap();
        let mut wf = wf;
        wf.nodes.push(step(
            "c",
            NodeKind::Command,
            Some(&folder.join("sub").to_string_lossy()),
        ));
        record_run(&db, &wf, "run-ws");
        let folders = run_folders(&db, "run-ws").unwrap();
        assert_eq!(folders, [std::fs::canonicalize(&folder).unwrap()]);
        // A text preview stops at the limit and says so.
        let big = folder.join("big.txt");
        std::fs::write(&big, "x".repeat(MAX_TEXT_BYTES as usize + 10)).unwrap();
        let preview = read_run_file(&db, "run-ws", &big.to_string_lossy()).unwrap();
        assert!(preview.truncated);
        assert_eq!(preview.text.unwrap().len(), MAX_TEXT_BYTES as usize);
    }

    #[cfg(unix)]
    #[test]
    fn a_copy_that_keeps_an_old_modification_time_still_counts() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("kept.mp4");
        std::fs::write(&file, "x").unwrap();
        std::fs::File::options()
            .write(true)
            .open(&file)
            .unwrap()
            .set_modified(SystemTime::now() - Duration::from_secs(86_400))
            .unwrap();
        let since = SystemTime::now() - Duration::from_secs(60);
        let listed = scan(&[dir.path().to_path_buf()], since, None);
        assert_eq!(listed.files.len(), 1);
    }

    #[cfg(unix)]
    #[test]
    fn a_file_renamed_after_the_run_still_belongs_to_it() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("insights.md");
        std::fs::write(&file, "x").unwrap();
        let written = std::fs::metadata(&file).unwrap().modified().unwrap();
        let until = written + Duration::from_secs(1);
        std::thread::sleep(Duration::from_millis(1100));
        // A later rename (or chmod) changes only the status time.
        let renamed = dir.path().join("insights-final.md");
        std::fs::rename(&file, &renamed).unwrap();
        let since = written - Duration::from_secs(5);
        let listed = scan(&[dir.path().to_path_buf()], since, Some(until));
        assert_eq!(listed.files.len(), 1);
        // The time shown is when the run wrote it.
        assert_eq!(listed.files[0].modified_at, DateTime::<Utc>::from(written));
    }

    #[test]
    fn a_paused_run_keeps_listing_edits_made_while_it_waits() {
        let db = SqliteDb::open_in_memory().unwrap();
        let repo = tempfile::tempdir().unwrap();
        let wf = workflow(
            vec![step("a", NodeKind::Agent, None)],
            Some(&repo.path().to_string_lossy()),
        );
        record_run(&db, &wf, "run-paused");
        db.finish_run("run-paused", crate::db::RunStatus::Paused)
            .unwrap();
        // Long after the pause began: past the finished-run slack.
        let later = SystemTime::now() + FINISH_SLACK + Duration::from_secs(60);
        let file = repo.path().join("prompts.md");
        std::fs::write(&file, "edited while waiting").unwrap();
        std::fs::File::options()
            .write(true)
            .open(&file)
            .unwrap()
            .set_modified(later)
            .unwrap();
        assert_eq!(list_run_files(&db, "run-paused").unwrap().files.len(), 1);
        // A finished run's window closes: writes after it are not the run's.
        let before = SystemTime::now() - Duration::from_secs(120);
        let closed = scan(
            &[repo.path().to_path_buf()],
            before - Duration::from_secs(60),
            Some(before),
        );
        assert!(closed.files.is_empty());
    }

    #[test]
    fn listings_stop_at_the_file_limit() {
        let dir = tempfile::tempdir().unwrap();
        for i in 0..(MAX_FILES + 5) {
            std::fs::write(dir.path().join(format!("f{i}.txt")), "x").unwrap();
        }
        let since = SystemTime::now() - Duration::from_secs(60);
        let listed = scan(&[dir.path().to_path_buf()], since, None);
        assert_eq!(listed.files.len(), MAX_FILES);
        assert!(listed.truncated);
        let none = scan(
            &[dir.path().to_path_buf()],
            SystemTime::now() + Duration::from_secs(60),
            None,
        );
        assert!(none.files.is_empty());
    }
}
