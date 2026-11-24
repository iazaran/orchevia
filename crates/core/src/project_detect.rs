//! Suggest a repository's test, lint and build commands from the files it
//! already has (Makefile, package.json, Cargo.toml, go.mod, …).
//!
//! Read-only and offline: a fixed list of manifest files in the folder itself
//! is read (each capped in size), nothing is executed, and the results are
//! only suggestions the Playbooks view shows for the user to edit and save.

use serde::Serialize;
use std::collections::BTreeMap;
use std::path::Path;

/// One suggested playbook value and the file it came from.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectedCommand {
    /// Playbook field: `testCommand`, `lintCommand`, `buildCommand` or `conventions`.
    pub field: String,
    pub value: String,
    /// Where it came from, e.g. `package.json script "test"`.
    pub source: String,
}

const MAX_FILE_BYTES: u64 = 512 * 1024;

/// Files read from the repository folder. Lock files only signal which
/// package manager is in use; their contents are never needed.
const FILES: &[&str] = &[
    "Makefile",
    "makefile",
    "GNUmakefile",
    "justfile",
    "Justfile",
    "package.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    "bun.lockb",
    "bun.lock",
    "Cargo.toml",
    "go.mod",
    "pyproject.toml",
    "uv.lock",
    "poetry.lock",
    "composer.json",
    "deno.json",
    "deno.jsonc",
    "build.gradle",
    "build.gradle.kts",
    "gradlew",
    "pom.xml",
    "mix.exs",
    "AGENTS.md",
    "CLAUDE.md",
];

/// Read the known manifest files in `dir` and suggest commands.
pub fn detect_project_commands(dir: &Path) -> Result<Vec<DetectedCommand>, String> {
    if !dir.is_absolute() {
        return Err("Choose the repository by its full path.".into());
    }
    if !dir.is_dir() {
        return Err(format!("'{}' is not a folder.", dir.display()));
    }
    let mut files = BTreeMap::new();
    for name in FILES {
        let path = dir.join(name);
        let Ok(meta) = std::fs::metadata(&path) else {
            continue;
        };
        if !meta.is_file() {
            continue;
        }
        let contents = if meta.len() <= MAX_FILE_BYTES {
            std::fs::read_to_string(&path).unwrap_or_default()
        } else {
            String::new()
        };
        files.insert((*name).to_string(), contents);
    }
    Ok(detect_from_files(&files))
}

/// Detection over file name → contents (empty when only presence matters).
pub fn detect_from_files(files: &BTreeMap<String, String>) -> Vec<DetectedCommand> {
    let mut found: Vec<DetectedCommand> = Vec::new();
    let mut add = |field: &str, value: String, source: String| {
        if !found.iter().any(|d| d.field == field) {
            found.push(DetectedCommand {
                field: field.into(),
                value,
                source,
            });
        }
    };
    let file = |name: &str| files.get(name).map(String::as_str);
    let has = |name: &str| files.contains_key(name);

    // 1. Explicit project tasks win: they are the repository's own contract.
    for name in ["Makefile", "makefile", "GNUmakefile"] {
        if let Some(text) = file(name) {
            let targets = make_targets(text);
            for (field, target) in [
                ("testCommand", "test"),
                ("lintCommand", "lint"),
                ("lintCommand", "check"),
                ("buildCommand", "build"),
            ] {
                if targets.iter().any(|t| t == target) {
                    add(
                        field,
                        format!("make {target}"),
                        format!("{name} target \"{target}\""),
                    );
                }
            }
        }
    }
    for name in ["justfile", "Justfile"] {
        if let Some(text) = file(name) {
            let recipes = just_recipes(text);
            for (field, recipe) in [
                ("testCommand", "test"),
                ("lintCommand", "lint"),
                ("lintCommand", "check"),
                ("buildCommand", "build"),
            ] {
                if recipes.iter().any(|r| r == recipe) {
                    add(
                        field,
                        format!("just {recipe}"),
                        format!("{name} recipe \"{recipe}\""),
                    );
                }
            }
        }
    }

    // 2. Package scripts.
    if let Some(text) = file("package.json") {
        if let Ok(json) = serde_json::from_str::<serde_json::Value>(text) {
            let pm = package_manager(&json, &has);
            let scripts = json.get("scripts").and_then(|s| s.as_object());
            let script = |name: &str| -> Option<&str> {
                scripts
                    .and_then(|s| s.get(name))
                    .and_then(|v| v.as_str())
                    .filter(|body| !body.contains("no test specified"))
            };
            for (field, names) in [
                ("testCommand", &["test", "test:unit"][..]),
                (
                    "lintCommand",
                    &["lint", "check", "typecheck", "type-check"][..],
                ),
                ("buildCommand", &["build"][..]),
            ] {
                if let Some(name) = names.iter().find(|n| script(n).is_some()) {
                    add(
                        field,
                        run_script(pm, name),
                        format!("package.json script \"{name}\" ({pm})"),
                    );
                }
            }
        }
    }
    if let Some(text) = file("composer.json") {
        if let Ok(json) = serde_json::from_str::<serde_json::Value>(text) {
            let scripts = json.get("scripts").and_then(|s| s.as_object());
            let dev = json
                .get("require-dev")
                .and_then(|s| s.as_object())
                .map(|deps| deps.keys().cloned().collect::<Vec<_>>())
                .unwrap_or_default();
            if scripts.is_some_and(|s| s.contains_key("test")) {
                add(
                    "testCommand",
                    "composer test".into(),
                    "composer.json script \"test\"".into(),
                );
            } else if dev.iter().any(|d| d.contains("phpunit")) {
                add(
                    "testCommand",
                    "vendor/bin/phpunit".into(),
                    "composer.json require-dev phpunit".into(),
                );
            }
            if scripts.is_some_and(|s| s.contains_key("lint")) {
                add(
                    "lintCommand",
                    "composer lint".into(),
                    "composer.json script \"lint\"".into(),
                );
            } else if dev.iter().any(|d| d.contains("phpstan")) {
                add(
                    "lintCommand",
                    "vendor/bin/phpstan analyse".into(),
                    "composer.json require-dev phpstan".into(),
                );
            }
        }
    }
    for name in ["deno.json", "deno.jsonc"] {
        if let Some(text) = file(name) {
            let tasks = serde_json::from_str::<serde_json::Value>(text)
                .ok()
                .and_then(|json| json.get("tasks").and_then(|t| t.as_object()).cloned())
                .unwrap_or_default();
            for (field, task, fallback) in [
                ("testCommand", "test", Some("deno test")),
                ("lintCommand", "lint", Some("deno lint")),
                ("buildCommand", "build", None),
            ] {
                if tasks.contains_key(task) {
                    add(
                        field,
                        format!("deno task {task}"),
                        format!("{name} task \"{task}\""),
                    );
                } else if let Some(command) = fallback {
                    add(field, command.into(), name.into());
                }
            }
        }
    }

    // 3. Language defaults.
    if let Some(text) = file("Cargo.toml") {
        let workspace = if text.contains("[workspace]") {
            " --workspace"
        } else {
            ""
        };
        add(
            "testCommand",
            format!("cargo test{workspace}"),
            "Cargo.toml".into(),
        );
        add(
            "lintCommand",
            format!("cargo clippy{workspace} --all-targets -- -D warnings"),
            "Cargo.toml".into(),
        );
        add(
            "buildCommand",
            format!("cargo build{workspace}"),
            "Cargo.toml".into(),
        );
    }
    if has("go.mod") {
        add("testCommand", "go test ./...".into(), "go.mod".into());
        add("lintCommand", "go vet ./...".into(), "go.mod".into());
        add("buildCommand", "go build ./...".into(), "go.mod".into());
    }
    if let Some(text) = file("pyproject.toml") {
        let runner = if has("uv.lock") {
            "uv run "
        } else if has("poetry.lock") || text.contains("[tool.poetry") {
            "poetry run "
        } else {
            ""
        };
        if text.contains("pytest") {
            add(
                "testCommand",
                format!("{runner}pytest"),
                "pyproject.toml (pytest)".into(),
            );
        }
        if text.contains("ruff") {
            add(
                "lintCommand",
                format!("{runner}ruff check ."),
                "pyproject.toml (ruff)".into(),
            );
        } else if text.contains("flake8") {
            add(
                "lintCommand",
                format!("{runner}flake8"),
                "pyproject.toml (flake8)".into(),
            );
        }
        if text.contains("[build-system]") {
            let build = if has("uv.lock") {
                "uv build"
            } else if runner == "poetry run " {
                "poetry build"
            } else {
                "python -m build"
            };
            add(
                "buildCommand",
                build.into(),
                "pyproject.toml [build-system]".into(),
            );
        }
    }
    if has("build.gradle") || has("build.gradle.kts") {
        let gradle = if has("gradlew") {
            "./gradlew"
        } else {
            "gradle"
        };
        let source = if has("build.gradle.kts") {
            "build.gradle.kts"
        } else {
            "build.gradle"
        };
        add("testCommand", format!("{gradle} test"), source.into());
        add("lintCommand", format!("{gradle} check"), source.into());
        add("buildCommand", format!("{gradle} build"), source.into());
    }
    if has("pom.xml") {
        add("testCommand", "mvn test".into(), "pom.xml".into());
        add("buildCommand", "mvn package".into(), "pom.xml".into());
    }
    if let Some(text) = file("mix.exs") {
        add("testCommand", "mix test".into(), "mix.exs".into());
        if text.contains(":credo") {
            add("lintCommand", "mix credo".into(), "mix.exs (credo)".into());
        }
        add("buildCommand", "mix compile".into(), "mix.exs".into());
    }

    // 4. Agent instructions already in the repository.
    let guides: Vec<&str> = ["AGENTS.md", "CLAUDE.md"]
        .into_iter()
        .filter(|name| has(name))
        .collect();
    if !guides.is_empty() {
        add(
            "conventions",
            format!(
                "Follow the instructions in {} at the repository root.",
                guides.join(" and ")
            ),
            guides.join(", "),
        );
    }
    found
}

fn package_manager(json: &serde_json::Value, has: &dyn Fn(&str) -> bool) -> &'static str {
    let declared = json
        .get("packageManager")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    if has("pnpm-lock.yaml") || declared.starts_with("pnpm@") {
        "pnpm"
    } else if has("yarn.lock") || declared.starts_with("yarn@") {
        "yarn"
    } else if has("bun.lockb") || has("bun.lock") || declared.starts_with("bun@") {
        "bun"
    } else {
        "npm"
    }
}

fn run_script(pm: &str, script: &str) -> String {
    match (pm, script) {
        ("npm" | "pnpm" | "yarn", "test") => format!("{pm} test"),
        ("yarn", _) => format!("yarn {script}"),
        _ => format!("{pm} run {script}"),
    }
}

/// Target names defined at the start of a Makefile line (`test:`), not
/// variable assignments (`X := 1`) or pattern rules.
fn make_targets(text: &str) -> Vec<String> {
    let mut targets = Vec::new();
    for line in text.lines() {
        if line.starts_with(['\t', ' ', '#', '.']) {
            continue;
        }
        let Some((head, rest)) = line.split_once(':') else {
            continue;
        };
        if rest.starts_with('=') || head.contains('=') || head.contains('%') {
            continue;
        }
        for name in head.split_whitespace() {
            if name
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || "_-./".contains(c))
            {
                targets.push(name.to_string());
            }
        }
    }
    targets
}

/// Recipe names in a justfile (`test:` or `test arg:`), skipping settings,
/// assignments and indented recipe bodies.
fn just_recipes(text: &str) -> Vec<String> {
    let mut recipes = Vec::new();
    for line in text.lines() {
        if line.starts_with([' ', '\t', '#', '[', '@']) {
            continue;
        }
        let Some((head, rest)) = line.split_once(':') else {
            continue;
        };
        if rest.starts_with('=') {
            continue;
        }
        let Some(name) = head.split_whitespace().next() else {
            continue;
        };
        if ["set", "alias", "export", "import", "mod"].contains(&name) {
            continue;
        }
        if name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
        {
            recipes.push(name.to_string());
        }
    }
    recipes
}

#[cfg(test)]
mod tests {
    use super::*;

    fn detect(files: &[(&str, &str)]) -> Vec<(String, String)> {
        let map = files
            .iter()
            .map(|(name, text)| ((*name).to_string(), (*text).to_string()))
            .collect();
        detect_from_files(&map)
            .into_iter()
            .map(|d| (d.field, d.value))
            .collect()
    }

    fn pairs(items: &[(&str, &str)]) -> Vec<(String, String)> {
        items
            .iter()
            .map(|(a, b)| ((*a).to_string(), (*b).to_string()))
            .collect()
    }

    #[test]
    fn node_scripts_use_the_locked_package_manager() {
        let pkg = r#"{"scripts":{"test":"vitest run","lint":"eslint .","build":"vite build"}}"#;
        assert_eq!(
            detect(&[("package.json", pkg), ("pnpm-lock.yaml", "")]),
            pairs(&[
                ("testCommand", "pnpm test"),
                ("lintCommand", "pnpm run lint"),
                ("buildCommand", "pnpm run build"),
            ])
        );
        assert_eq!(
            detect(&[("package.json", pkg), ("bun.lockb", "")])[0],
            ("testCommand".into(), "bun run test".into())
        );
        assert_eq!(
            detect(&[("package.json", pkg)])[1],
            ("lintCommand".into(), "npm run lint".into())
        );
        assert_eq!(
            detect(&[("package.json", pkg), ("yarn.lock", "")])[2],
            ("buildCommand".into(), "yarn build".into())
        );
    }

    #[test]
    fn placeholder_npm_test_script_is_ignored() {
        let pkg =
            r#"{"scripts":{"test":"echo \"Error: no test specified\" && exit 1","check":"tsc"}}"#;
        assert_eq!(
            detect(&[("package.json", pkg)]),
            pairs(&[("lintCommand", "npm run check")])
        );
    }

    #[test]
    fn makefile_targets_win_over_language_defaults() {
        let make = "VERSION := 1\n.PHONY: test\ntest: deps\n\tcargo test\nlint:\n\tcargo clippy\n%.o: %.c\n";
        assert_eq!(
            detect(&[
                ("Makefile", make),
                ("Cargo.toml", "[package]\nname = \"x\"")
            ]),
            pairs(&[
                ("testCommand", "make test"),
                ("lintCommand", "make lint"),
                ("buildCommand", "cargo build"),
            ])
        );
    }

    #[test]
    fn justfile_recipes_are_found() {
        let just = "set shell := [\"bash\", \"-c\"]\nalias t := test\n\ntest *args:\n    cargo test {{args}}\n\nbuild:\n    cargo build\n";
        assert_eq!(
            detect(&[("justfile", just)]),
            pairs(&[("testCommand", "just test"), ("buildCommand", "just build")])
        );
    }

    #[test]
    fn rust_workspaces_go_and_python() {
        assert_eq!(
            detect(&[("Cargo.toml", "[workspace]\nmembers = [\"a\"]")])[1].1,
            "cargo clippy --workspace --all-targets -- -D warnings"
        );
        assert_eq!(
            detect(&[("go.mod", "module x")]),
            pairs(&[
                ("testCommand", "go test ./..."),
                ("lintCommand", "go vet ./..."),
                ("buildCommand", "go build ./..."),
            ])
        );
        let py = "[build-system]\nrequires = [\"hatchling\"]\n[tool.ruff]\n[dependency-groups]\ndev = [\"pytest\"]";
        assert_eq!(
            detect(&[("pyproject.toml", py), ("uv.lock", "")]),
            pairs(&[
                ("testCommand", "uv run pytest"),
                ("lintCommand", "uv run ruff check ."),
                ("buildCommand", "uv build"),
            ])
        );
    }

    #[test]
    fn php_deno_gradle_maven_and_elixir() {
        let composer = r#"{"require-dev":{"phpunit/phpunit":"^11","phpstan/phpstan":"^2"}}"#;
        assert_eq!(
            detect(&[("composer.json", composer)]),
            pairs(&[
                ("testCommand", "vendor/bin/phpunit"),
                ("lintCommand", "vendor/bin/phpstan analyse"),
            ])
        );
        assert_eq!(
            detect(&[("deno.json", r#"{"tasks":{"build":"deno run b.ts"}}"#)]),
            pairs(&[
                ("testCommand", "deno test"),
                ("lintCommand", "deno lint"),
                ("buildCommand", "deno task build"),
            ])
        );
        assert_eq!(
            detect(&[("build.gradle.kts", ""), ("gradlew", "")])[0].1,
            "./gradlew test"
        );
        assert_eq!(
            detect(&[("pom.xml", "<project/>")]),
            pairs(&[("testCommand", "mvn test"), ("buildCommand", "mvn package")])
        );
        assert_eq!(
            detect(&[("mix.exs", "{:credo, \"~> 1.7\"}")])[1].1,
            "mix credo"
        );
    }

    #[test]
    fn agent_guides_become_a_convention() {
        let found = detect_from_files(
            &[("AGENTS.md", ""), ("CLAUDE.md", "")]
                .into_iter()
                .map(|(a, b)| (a.to_string(), b.to_string()))
                .collect(),
        );
        assert_eq!(
            found,
            vec![DetectedCommand {
                field: "conventions".into(),
                value: "Follow the instructions in AGENTS.md and CLAUDE.md at the repository root."
                    .into(),
                source: "AGENTS.md, CLAUDE.md".into(),
            }]
        );
    }

    #[test]
    fn reads_a_real_folder_and_refuses_relative_paths() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("go.mod"), "module example.com/x\n").unwrap();
        std::fs::write(dir.path().join("Makefile"), "test:\n\tgo test ./...\n").unwrap();
        let found = detect_project_commands(dir.path()).unwrap();
        assert_eq!(found[0].value, "make test");
        assert_eq!(found[0].source, "Makefile target \"test\"");
        assert_eq!(found[1].value, "go vet ./...");
        assert!(detect_project_commands(Path::new("relative/dir")).is_err());
        assert!(detect_project_commands(&dir.path().join("missing")).is_err());
    }
}
