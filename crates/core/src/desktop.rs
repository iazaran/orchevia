//! Desktop integration facts for the app shell: whether the desktop can show
//! a tray icon, how Orchevia was installed (so update notices point at the
//! matching download), and which links the app may open in the browser.
//! Probes are best-effort and never fail the caller; parsing is pure and
//! unit-tested.

use serde::Serialize;

/// The only site the app opens in the browser: its own repository pages.
pub const REPOSITORY_URL: &str = "https://github.com/iazaran/orchevia";

/// The signed apt repository published with the project site.
pub const APT_REPOSITORY_URL: &str = "https://iazaran.github.io/orchevia/apt";

/// D-Bus name owned by the tray host (StatusNotifierItem watcher). GNOME has
/// none unless the AppIndicator extension is enabled.
#[cfg(target_os = "linux")]
const STATUS_NOTIFIER_WATCHER: &str = "org.kde.StatusNotifierWatcher";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopInfo {
    /// `Some(false)` when the desktop shows no tray icons; `None` when unknown.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tray_available: Option<bool>,
    /// `linux`, `macos`, `windows` or `other`.
    pub platform: String,
    /// `x86_64`, `arm64` or the raw architecture name.
    pub arch: String,
    /// `apt` (.deb with the apt repository set up), `deb`, `appimage`, `app`
    /// (macOS bundle) or `unknown`.
    pub install_kind: String,
    /// Whether this copy can download a signed update and replace itself:
    /// AppImage and macOS bundles of a build that carries the update key.
    pub in_place_updates: bool,
}

/// Install kinds the updater replaces in place. Debian packages stay with apt
/// (or a downloaded .deb), so a package manager never sees files change.
pub fn supports_in_place_update(install_kind: &str) -> bool {
    matches!(install_kind, "appimage" | "app")
}

pub fn platform() -> &'static str {
    if cfg!(target_os = "linux") {
        "linux"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "windows") {
        "windows"
    } else {
        "other"
    }
}

/// Release assets name Apple Silicon `arm64`.
pub fn arch() -> &'static str {
    match std::env::consts::ARCH {
        "aarch64" => "arm64",
        other => other,
    }
}

/// How the running app was installed. On Linux the AppImage runtime sets
/// `APPIMAGE`; the .deb registers the `orchevia` package with dpkg, and apt
/// updates it when a source under `/etc/apt/sources.list.d` names the
/// project's apt repository.
pub fn install_kind() -> &'static str {
    if cfg!(target_os = "macos") {
        return "app";
    }
    if cfg!(target_os = "linux") {
        if std::env::var_os("APPIMAGE").is_some() {
            return "appimage";
        }
        if std::path::Path::new("/var/lib/dpkg/info/orchevia.list").exists() {
            let sources = std::path::Path::new("/etc/apt/sources.list.d");
            return if apt_source_configured(sources) {
                "apt"
            } else {
                "deb"
            };
        }
    }
    "unknown"
}

/// Whether a `.list` or `.sources` file in `dir` names the apt repository.
pub fn apt_source_configured(dir: &std::path::Path) -> bool {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return false;
    };
    entries.flatten().any(|entry| {
        let path = entry.path();
        let source_file = path
            .extension()
            .is_some_and(|ext| ext == "list" || ext == "sources");
        source_file
            && entry.metadata().is_ok_and(|meta| meta.len() <= 64 * 1024)
            && std::fs::read_to_string(&path).is_ok_and(|text| {
                text.lines().any(|line| {
                    let line = line.trim();
                    !line.starts_with('#') && line.contains(APT_REPOSITORY_URL)
                })
            })
    })
}

/// Whether the desktop shows tray icons. macOS and Windows always do. On
/// Linux this asks the session bus whether a StatusNotifier host is running,
/// via `gdbus` or `busctl` (no new dependencies); `None` when neither answers.
/// Blocking: call it off the UI thread.
pub fn tray_available() -> Option<bool> {
    #[cfg(target_os = "linux")]
    {
        let gdbus = [
            "call",
            "--session",
            "--dest",
            "org.freedesktop.DBus",
            "--object-path",
            "/org/freedesktop/DBus",
            "--method",
            "org.freedesktop.DBus.NameHasOwner",
            STATUS_NOTIFIER_WATCHER,
        ];
        let busctl = [
            "--user",
            "call",
            "org.freedesktop.DBus",
            "/org/freedesktop/DBus",
            "org.freedesktop.DBus",
            "NameHasOwner",
            "s",
            STATUS_NOTIFIER_WATCHER,
        ];
        let probes: [(&str, &[&str]); 2] = [("gdbus", &gdbus), ("busctl", &busctl)];
        probes.iter().find_map(|(program, args)| {
            let output = std::process::Command::new(program)
                .args(*args)
                .stdin(std::process::Stdio::null())
                .output()
                .ok()?;
            if !output.status.success() {
                return None;
            }
            parse_name_has_owner(&String::from_utf8_lossy(&output.stdout))
        })
    }
    #[cfg(not(target_os = "linux"))]
    {
        Some(true)
    }
}

/// Parse a `NameHasOwner` reply: `(true,)` from `gdbus`, `b true` from
/// `busctl`.
pub fn parse_name_has_owner(output: &str) -> Option<bool> {
    let text = output.trim();
    let value = text
        .strip_prefix('(')
        .and_then(|rest| rest.strip_suffix(",)"))
        .or_else(|| text.strip_prefix("b "))?;
    match value.trim() {
        "true" => Some(true),
        "false" => Some(false),
        _ => None,
    }
}

/// Only this repository's pages, with plain URL characters (no spaces or
/// quotes), may be opened.
pub fn allowed_external_url(url: &str) -> bool {
    url.strip_prefix(REPOSITORY_URL)
        .is_some_and(|rest| rest.is_empty() || rest.starts_with('/'))
        && url.len() <= 300
        && url
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "-._~/:?=&#%+".contains(c))
}

/// Open an allowed URL in the default browser without waiting for it.
pub fn open_external(url: &str) -> Result<(), String> {
    if !allowed_external_url(url) {
        return Err("Only Orchevia's own GitHub pages can be opened.".into());
    }
    let program = if cfg!(target_os = "macos") {
        "open"
    } else if cfg!(target_os = "windows") {
        "explorer"
    } else {
        "xdg-open"
    };
    let mut child = std::process::Command::new(program)
        .arg(url)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|e| format!("Could not open the browser ({program}): {e}"))?;
    // Reap the opener so it never lingers as a zombie.
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

/// `updater_configured`: the build carries the public key that verifies
/// update signatures.
pub fn desktop_info(tray_available: Option<bool>, updater_configured: bool) -> DesktopInfo {
    let install_kind = install_kind();
    DesktopInfo {
        tray_available,
        platform: platform().into(),
        arch: arch().into(),
        install_kind: install_kind.into(),
        in_place_updates: updater_configured && supports_in_place_update(install_kind),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_appimages_and_mac_bundles_update_in_place() {
        assert!(supports_in_place_update("appimage"));
        assert!(supports_in_place_update("app"));
        for kind in ["apt", "deb", "unknown", ""] {
            assert!(!supports_in_place_update(kind), "{kind}");
        }
        // A build without the update key never offers it.
        assert!(!desktop_info(None, false).in_place_updates);
        assert_eq!(
            desktop_info(None, true).in_place_updates,
            supports_in_place_update(install_kind())
        );
    }

    #[test]
    fn parses_gdbus_and_busctl_replies() {
        assert_eq!(parse_name_has_owner("(true,)\n"), Some(true));
        assert_eq!(parse_name_has_owner("(false,)"), Some(false));
        assert_eq!(parse_name_has_owner("b true\n"), Some(true));
        assert_eq!(parse_name_has_owner("b false"), Some(false));
        assert_eq!(parse_name_has_owner(""), None);
        assert_eq!(parse_name_has_owner("Error: no bus"), None);
    }

    #[test]
    fn only_repository_pages_open() {
        assert!(allowed_external_url(
            "https://github.com/iazaran/orchevia/releases/latest"
        ));
        assert!(allowed_external_url(
            "https://github.com/iazaran/orchevia/releases/download/v0.1.20/Orchevia-linux-x86_64.deb"
        ));
        assert!(allowed_external_url("https://github.com/iazaran/orchevia"));
        assert!(!allowed_external_url(
            "https://github.com/iazaran/orchevia-evil/releases"
        ));
        assert!(!allowed_external_url(
            "https://example.com/iazaran/orchevia"
        ));
        assert!(!allowed_external_url(
            "https://github.com/iazaran/orchevia/a b"
        ));
        assert!(!allowed_external_url(
            "https://github.com/iazaran/orchevia/\"$(x)\""
        ));
        assert!(!allowed_external_url("file:///etc/passwd"));
    }

    #[test]
    fn detects_the_apt_source_in_list_and_deb822_files() {
        let dir = tempfile::tempdir().expect("dir");
        assert!(!apt_source_configured(dir.path()));
        assert!(!apt_source_configured(&dir.path().join("missing")));
        std::fs::write(
            dir.path().join("other.list"),
            "deb https://example.com/apt stable main\n",
        )
        .expect("write");
        std::fs::write(
            dir.path().join("orchevia.list.disabled"),
            format!("deb {APT_REPOSITORY_URL} stable main\n"),
        )
        .expect("write");
        std::fs::write(
            dir.path().join("commented.list"),
            format!("# deb {APT_REPOSITORY_URL} stable main\n"),
        )
        .expect("write");
        assert!(!apt_source_configured(dir.path()));
        std::fs::write(
            dir.path().join("orchevia.sources"),
            format!("Types: deb\nURIs: {APT_REPOSITORY_URL}\nSuites: stable\n"),
        )
        .expect("write");
        assert!(apt_source_configured(dir.path()));
    }

    #[test]
    fn arch_uses_release_asset_names() {
        assert!(!arch().is_empty());
        assert_ne!(arch(), "aarch64");
    }
}
