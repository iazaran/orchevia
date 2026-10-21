//! Agent tool permissions: refused tool calls reported by the CLI and the
//! allow rules that would admit them.
//!
//! Headless `claude -p` does not prompt: a tool its settings do not allow is
//! refused, the model carries on, and the final `result` event still says
//! `"subtype":"success"`. The refusals arrive only as `permission_denials` on
//! that event, so Orchevia reads them and fails the node instead of reporting
//! a success that did none of the gated work. No settings files are read or
//! written here; rules are suggestions the user may add to a profile.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// At most this many allow rules per profile or node declaration.
pub const MAX_TOOL_RULES: usize = 64;
const MAX_RULE_CHARS: usize = 256;
const MAX_DETAIL_CHARS: usize = 200;
/// Keep the node's structured result bounded even if a CLI refuses a lot.
const MAX_RECORDED_DENIALS: usize = 50;

/// One refused tool call, as recorded in the node's structured result.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionDenial {
    pub tool_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_use_id: Option<String>,
    /// Short summary of the refused input (command, path, URL, query).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    /// Allow rules that would admit this call.
    pub rules: Vec<String>,
}

impl PermissionDenial {
    /// Decode one entry of Claude's `permission_denials` array.
    pub fn from_claude(value: &Value) -> Option<Self> {
        let tool_name = value.get("tool_name")?.as_str()?.trim();
        if tool_name.is_empty() {
            return None;
        }
        let tool_name: String = tool_name.chars().take(MAX_RULE_CHARS).collect();
        let input = value.get("tool_input").unwrap_or(&Value::Null);
        Some(Self {
            rules: suggest_rules(&tool_name, input),
            detail: input_detail(input),
            tool_use_id: value
                .get("tool_use_id")
                .and_then(Value::as_str)
                .map(str::to_string),
            tool_name,
        })
    }
}

/// Decode Claude's `permission_denials`, dropping duplicate tool-use ids.
pub fn claude_denials(value: &Value) -> Vec<PermissionDenial> {
    let mut seen = std::collections::HashSet::new();
    value
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(PermissionDenial::from_claude)
                .filter(|d| {
                    d.tool_use_id
                        .as_ref()
                        .is_none_or(|id| seen.insert(id.clone()))
                })
                .take(MAX_RECORDED_DENIALS)
                .collect()
        })
        .unwrap_or_default()
}

fn input_detail(input: &Value) -> Option<String> {
    [
        "command",
        "file_path",
        "notebook_path",
        "path",
        "url",
        "query",
        "pattern",
    ]
    .iter()
    .find_map(|key| input.get(*key).and_then(Value::as_str))
    .map(str::trim)
    .filter(|text| !text.is_empty())
    .map(|text| {
        let line: String = text
            .chars()
            .map(|c| if c.is_control() { ' ' } else { c })
            .collect();
        if line.chars().count() > MAX_DETAIL_CHARS {
            format!(
                "{}…",
                line.chars().take(MAX_DETAIL_CHARS).collect::<String>()
            )
        } else {
            line
        }
    })
}

/// The allow rule(s) that would admit a refused call: an MCP tool's server
/// rule `mcp__<server>`, `Bash(<command prefix> *)` per command in a Bash
/// line, otherwise the tool name itself.
pub fn suggest_rules(tool_name: &str, input: &Value) -> Vec<String> {
    if let Some(rest) = tool_name.strip_prefix("mcp__") {
        // Claude names MCP tools `mcp__<server>__<tool>`; the server is the
        // first segment, as Claude Code itself parses it.
        let server = rest.split("__").next().unwrap_or_default();
        return vec![if server.is_empty() {
            tool_name.to_string()
        } else {
            format!("mcp__{server}")
        }];
    }
    if tool_name == "Bash" {
        let mut rules: Vec<String> = Vec::new();
        if let Some(command) = input.get("command").and_then(Value::as_str) {
            for prefix in bash_prefixes(command) {
                let rule = format!("Bash({prefix} *)");
                if !rules.contains(&rule) {
                    rules.push(rule);
                }
            }
        }
        if rules.is_empty() {
            rules.push("Bash".into());
        }
        return rules;
    }
    vec![tool_name.to_string()]
}

/// CLIs whose second word picks the operation (`git status`, `pnpm test`), so
/// the suggested rule stays as narrow as the refused command.
const SUBCOMMAND_TOOLS: &[&str] = &[
    "bun", "bundle", "cargo", "composer", "docker", "dotnet", "gh", "git", "go", "gradle",
    "kubectl", "make", "mvn", "npm", "npx", "pip", "pnpm", "poetry", "uv", "yarn",
];

/// Command prefixes (`git status`, `touch`) for every simple command in a
/// shell line. Claude checks each command of a compound line separately, so
/// each needs its own rule.
pub fn bash_prefixes(command: &str) -> Vec<String> {
    let mut prefixes = Vec::new();
    for segment in split_commands(command) {
        let words = shell_words(&segment);
        let mut words = words
            .iter()
            .skip_while(|word| is_assignment(word))
            .map(String::as_str);
        let Some(program) = words.next().filter(|w| safe_word(w, true)) else {
            continue;
        };
        let prefix = match words.next() {
            Some(sub) if SUBCOMMAND_TOOLS.contains(&program) && safe_word(sub, false) => {
                format!("{program} {sub}")
            }
            _ => program.to_string(),
        };
        if !prefixes.contains(&prefix) {
            prefixes.push(prefix);
        }
    }
    prefixes
}

fn is_assignment(word: &str) -> bool {
    word.split_once('=').is_some_and(|(name, _)| {
        !name.is_empty()
            && name.starts_with(|c: char| c.is_ascii_alphabetic() || c == '_')
            && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
    })
}

fn safe_word(word: &str, program: bool) -> bool {
    !word.is_empty()
        && !word.starts_with('-')
        && word.chars().all(|c| {
            c.is_ascii_alphanumeric()
                || matches!(c, '_' | '-' | '.' | '+')
                || (program && c == '/')
                || (!program && c == ':')
        })
}

/// Split a shell line on `&&`, `||`, `;`, `|`, `&` and newlines outside
/// quotes. Redirections (`2>&1`, `&> log`) are not separators, and heredoc
/// bodies (`cat <<'EOF'` … `EOF`) are data, so they are skipped.
fn split_commands(command: &str) -> Vec<String> {
    let mut segments = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    let mut heredocs: Vec<String> = Vec::new();
    let mut chars = command.chars().peekable();
    while let Some(c) = chars.next() {
        match quote {
            Some(q) => {
                if c == q {
                    quote = None;
                } else if c == '\\' && q == '"' {
                    current.push(c);
                    if let Some(next) = chars.next() {
                        current.push(next);
                    }
                    continue;
                }
                current.push(c);
            }
            None => match c {
                '\'' | '"' => {
                    quote = Some(c);
                    current.push(c);
                }
                '\\' => {
                    current.push(c);
                    if let Some(next) = chars.next() {
                        current.push(next);
                    }
                }
                // `2>&1`, `>&2`, `<&3`, `&>file`: a redirection.
                '&' if current.ends_with(['>', '<']) || chars.peek() == Some(&'>') => {
                    current.push(c);
                }
                '<' if chars.peek() == Some(&'<') => {
                    chars.next();
                    current.push_str("<<");
                    if chars.peek() == Some(&'<') {
                        // `<<<` is a here-string, not a heredoc.
                        chars.next();
                        current.push('<');
                    } else if let Some(delimiter) = heredoc_delimiter(&mut chars, &mut current) {
                        heredocs.push(delimiter);
                    }
                }
                ';' | '\n' | '|' | '&' => {
                    if matches!(c, '|' | '&') && chars.peek() == Some(&c) {
                        chars.next();
                    }
                    segments.push(std::mem::take(&mut current));
                    if c == '\n' {
                        for delimiter in std::mem::take(&mut heredocs) {
                            skip_heredoc_body(&mut chars, &delimiter);
                        }
                    }
                }
                _ => current.push(c),
            },
        }
    }
    segments.push(current);
    segments
        .into_iter()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

/// Read a heredoc operator's delimiter word (after `<<`), copying it into the
/// current segment: `EOF`, `'EOF'`, `"EOF"`, `\\EOF` or `-EOF` (tab-stripped).
fn heredoc_delimiter(
    chars: &mut std::iter::Peekable<std::str::Chars<'_>>,
    current: &mut String,
) -> Option<String> {
    if chars.peek() == Some(&'-') {
        chars.next();
        current.push('-');
    }
    while chars.peek().is_some_and(|c| *c == ' ' || *c == '\t') {
        current.extend(chars.next());
    }
    let mut delimiter = String::new();
    let mut quote: Option<char> = None;
    while let Some(&c) = chars.peek() {
        match quote {
            Some(q) if c == q => quote = None,
            Some(_) => delimiter.push(c),
            None if c == '\'' || c == '"' => quote = Some(c),
            None if c == '\\' => {}
            None if c.is_whitespace() || ";|&<>()".contains(c) => break,
            None => delimiter.push(c),
        }
        current.push(c);
        chars.next();
    }
    (!delimiter.is_empty()).then_some(delimiter)
}

/// Skip a heredoc body: every line up to and including the one that is the
/// delimiter (leading tabs and trailing blanks ignored).
fn skip_heredoc_body(chars: &mut std::iter::Peekable<std::str::Chars<'_>>, delimiter: &str) {
    while chars.peek().is_some() {
        let line: String = chars.by_ref().take_while(|c| *c != '\n').collect();
        if line.trim_start_matches('\t').trim_end() == delimiter {
            return;
        }
    }
}

/// Whitespace-separated words with simple quote removal (no expansion).
fn shell_words(segment: &str) -> Vec<String> {
    let mut words = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    let mut started = false;
    for c in segment.chars() {
        match quote {
            Some(q) if c == q => quote = None,
            Some(_) => current.push(c),
            None if c == '\'' || c == '"' => {
                quote = Some(c);
                started = true;
            }
            None if c.is_whitespace() => {
                if started || !current.is_empty() {
                    words.push(std::mem::take(&mut current));
                }
                started = false;
            }
            None => current.push(c),
        }
    }
    if started || !current.is_empty() {
        words.push(current);
    }
    words
}

/// Every distinct suggested rule, in first-seen order.
pub fn denied_rules(denials: &[PermissionDenial]) -> Vec<String> {
    let mut rules: Vec<String> = Vec::new();
    for rule in denials.iter().flat_map(|d| d.rules.iter()) {
        if !rules.contains(rule) {
            rules.push(rule.clone());
        }
    }
    rules
}

/// The node error for refused calls: each denied tool and the rule that
/// would admit it.
pub fn denial_message(denials: &[PermissionDenial]) -> String {
    let mut parts: Vec<(String, usize, Vec<String>)> = Vec::new();
    for denial in denials {
        match parts
            .iter_mut()
            .find(|(name, _, rules)| name == &denial.tool_name && rules == &denial.rules)
        {
            Some(part) => part.1 += 1,
            None => parts.push((denial.tool_name.clone(), 1, denial.rules.clone())),
        }
    }
    let listed: Vec<String> = parts
        .iter()
        .map(|(name, count, rules)| {
            let times = if *count > 1 {
                format!(" ×{count}")
            } else {
                String::new()
            };
            format!("{name}{times} (allow with {})", rules.join(", "))
        })
        .collect();
    let calls = denials.len();
    format!(
        "Claude refused {calls} tool call{} under this profile's permissions, so its work is \
         incomplete: {}. Give agents full access (Environment → Agent permissions) or add the \
         rule{} to the Agent Profile's allowed tools, then retry.",
        if calls == 1 { "" } else { "s" },
        listed.join("; "),
        if denied_rules(denials).len() == 1 {
            ""
        } else {
            "s"
        },
    )
}

/// Validate one allow rule: a tool name (`Edit`, `mcp__server`,
/// `mcp__server__tool`) with an optional `(specifier)`, e.g. `Bash(git *)`.
pub fn validate_tool_rule(rule: &str) -> Result<(), String> {
    let invalid = || {
        format!(
            "Invalid allowed tool '{rule}'. Use a tool name such as Edit, mcp__server, or Bash(git *)."
        )
    };
    if rule.is_empty() || rule.trim() != rule || rule.chars().count() > MAX_RULE_CHARS {
        return Err(invalid());
    }
    if rule.chars().any(char::is_control) {
        return Err(invalid());
    }
    let lower = rule.to_ascii_lowercase();
    for marker in [
        "api-key",
        "apikey",
        "auth-token",
        "access-token",
        "bearer",
        "password",
        "secret",
    ] {
        if lower.contains(marker) {
            return Err(format!(
                "Allowed tool '{rule}' looks like it carries a credential and is not allowed."
            ));
        }
    }
    let (name, specifier) = match rule.split_once('(') {
        Some((name, rest)) => match rest.strip_suffix(')') {
            Some(inner) if !inner.trim().is_empty() => (name, Some(inner)),
            _ => return Err(invalid()),
        },
        None => (rule, None),
    };
    let name_ok = name.starts_with(|c: char| c.is_ascii_alphabetic())
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
    if !name_ok || specifier.is_some_and(|s| s.contains([',', '(', ')'])) {
        return Err(invalid());
    }
    Ok(())
}

/// Validate a list of allow rules: each rule, the count and duplicates.
pub fn validate_tool_rules(rules: &[String], what: &str) -> Vec<String> {
    let mut errors = Vec::new();
    if rules.len() > MAX_TOOL_RULES {
        errors.push(format!("{what} can list at most {MAX_TOOL_RULES} tools."));
    }
    let mut seen = std::collections::HashSet::new();
    for rule in rules {
        if let Err(error) = validate_tool_rule(rule) {
            errors.push(error);
        } else if !seen.insert(rule.as_str()) {
            errors.push(format!("Duplicate allowed tool '{rule}'."));
        }
    }
    errors
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn mcp_tools_suggest_their_server_rule() {
        assert_eq!(
            suggest_rules(
                "mcp__claude_ai_Atlassian_Rovo_2__getJiraIssue",
                &json!({"issueIdOrKey": "DEV-1234"})
            ),
            ["mcp__claude_ai_Atlassian_Rovo_2"]
        );
        assert_eq!(suggest_rules("mcp__github__", &json!({})), ["mcp__github"]);
        assert_eq!(suggest_rules("mcp__", &json!({})), ["mcp__"]);
    }

    #[test]
    fn bash_suggests_one_prefix_rule_per_command() {
        assert_eq!(
            suggest_rules("Bash", &json!({"command": "touch probe.txt && git status"})),
            ["Bash(touch *)", "Bash(git status *)"]
        );
        assert_eq!(
            suggest_rules(
                "Bash",
                &json!({"command": "CI=1 pnpm test -- --run | tee out.log; git -C x log"})
            ),
            ["Bash(pnpm test *)", "Bash(tee *)", "Bash(git *)"]
        );
        // Quoted operators are data, not command separators.
        assert_eq!(
            suggest_rules("Bash", &json!({"command": "echo 'a && b; c' | wc -l"})),
            ["Bash(echo *)", "Bash(wc *)"]
        );
        assert_eq!(
            suggest_rules("Bash", &json!({"command": "$(cat x)"})),
            ["Bash"]
        );
        assert_eq!(suggest_rules("Bash", &json!({})), ["Bash"]);
        // Redirections are not command separators.
        assert_eq!(
            suggest_rules(
                "Bash",
                &json!({"command": "cat x 2>/dev/null | head -150; make test 2>&1 >&2 &>log"})
            ),
            ["Bash(cat *)", "Bash(head *)", "Bash(make test *)"]
        );
        assert_eq!(
            suggest_rules("Write", &json!({"file_path": "/x"})),
            ["Write"]
        );
    }

    #[test]
    fn heredoc_bodies_are_data_not_commands() {
        // The refused command from a real run: its PR body became rules such
        // as `Bash(The *)` and `Bash(EOF *)` before heredocs were skipped.
        let command = "cd /home/u/.cache/orchevia/ticket-to-pr && printf '%s\\n' '[DEV-1] Fix' > PR_TITLE && cat > PR_BODY.md <<'EOF'\n## What and why\n\nThe server runs PHP.\nNo behaviour change.\n2. Rebuild\n3. Deploy; then | check & done\nDocBlocks stay\nEOF\ngit status --short | head";
        assert_eq!(
            suggest_rules("Bash", &json!({ "command": command })),
            [
                "Bash(cd *)",
                "Bash(printf *)",
                "Bash(cat *)",
                "Bash(git status *)",
                "Bash(head *)"
            ]
        );
        // Unquoted, dashed (tab-stripped) and several heredocs on one line.
        assert_eq!(
            bash_prefixes(
                "cat <<-END >a && tee b <<\"X\"\n\tbody one\n\tEND\nbody two\nX\nwc -l a"
            ),
            ["cat", "tee", "wc"]
        );
        // A here-string is not a heredoc; an unterminated heredoc ends the line.
        assert_eq!(bash_prefixes("grep x <<< \"$v\"\nls"), ["grep", "ls"]);
        assert_eq!(bash_prefixes("cat <<EOF\nrm -rf /\n"), ["cat"]);
    }

    #[test]
    fn claude_denials_decode_the_reported_shape() {
        let result = json!([
            {"tool_name": "Bash", "tool_use_id": "toolu_1",
             "tool_input": {"command": "touch probe.txt && git status", "description": "x"}},
            {"tool_name": "Bash", "tool_use_id": "toolu_1",
             "tool_input": {"command": "touch probe.txt && git status"}},
            {"tool_name": "Write", "tool_use_id": "toolu_2",
             "tool_input": {"file_path": "/tmp/notes.txt", "content": "hi"}},
            {"tool_name": "mcp__claude_ai_Atlassian_Rovo_2__getJiraIssue", "tool_use_id": "toolu_3",
             "tool_input": {"cloudId": "c", "issueIdOrKey": "DEV-1234"}},
            {"tool_use_id": "missing-name"}
        ]);
        let denials = claude_denials(&result);
        assert_eq!(denials.len(), 3);
        assert_eq!(
            denials[0].detail.as_deref(),
            Some("touch probe.txt && git status")
        );
        assert_eq!(denials[1].detail.as_deref(), Some("/tmp/notes.txt"));
        assert_eq!(denials[2].detail, None);
        assert_eq!(
            denied_rules(&denials),
            [
                "Bash(touch *)",
                "Bash(git status *)",
                "Write",
                "mcp__claude_ai_Atlassian_Rovo_2"
            ]
        );
        let message = denial_message(&denials);
        assert!(
            message.starts_with("Claude refused 3 tool calls"),
            "{message}"
        );
        assert!(message.contains("Bash (allow with Bash(touch *), Bash(git status *))"));
        assert!(message.contains(
            "mcp__claude_ai_Atlassian_Rovo_2__getJiraIssue (allow with mcp__claude_ai_Atlassian_Rovo_2)"
        ));
        assert!(message.contains("Give agents full access (Environment → Agent permissions)"));
        assert!(message.contains("add the rules to the Agent Profile's allowed tools"));
        assert!(claude_denials(&json!(null)).is_empty());
    }

    #[test]
    fn repeated_denials_of_one_tool_are_counted_once_in_the_message() {
        let denials = claude_denials(&json!([
            {"tool_name": "mcp__jira__getIssue", "tool_use_id": "a"},
            {"tool_name": "mcp__jira__getIssue", "tool_use_id": "b"}
        ]));
        let message = denial_message(&denials);
        assert!(message.contains("2 tool calls"));
        assert!(message.contains("mcp__jira__getIssue ×2 (allow with mcp__jira)"));
        assert!(message.contains("add the rule to"));
    }

    #[test]
    fn tool_rules_accept_names_and_specifiers_only() {
        for rule in [
            "Edit",
            "mcp__claude_ai_Atlassian_Rovo_2",
            "mcp__github__create_pull_request",
            "Bash(git status *)",
            "Bash(pnpm test:*)",
            "Read(./src/**)",
            "WebFetch(domain:example.com)",
        ] {
            assert!(validate_tool_rule(rule).is_ok(), "{rule}");
        }
        for rule in [
            "",
            " Edit",
            "-p",
            "--dangerously-skip-permissions",
            "Bash(",
            "Bash()",
            "Bash(a, b)",
            "Edit Write",
            "Bash(curl -H 'Authorization: Bearer x' *)",
            "Edit\nWrite",
        ] {
            assert!(validate_tool_rule(rule).is_err(), "{rule:?}");
        }
        let errors = validate_tool_rules(&["Edit".into(), "Edit".into()], "Allowed tools");
        assert_eq!(errors, ["Duplicate allowed tool 'Edit'."]);
        let many: Vec<String> = (0..=MAX_TOOL_RULES).map(|i| format!("T{i}")).collect();
        assert!(validate_tool_rules(&many, "Allowed tools")[0].contains("at most 64"));
    }
}
