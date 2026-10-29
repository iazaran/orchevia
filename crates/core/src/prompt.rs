//! Small deterministic prompt templating (Milestone 2).
//!
//! Supports `{{variable}}` and `{{dotted.path}}` placeholders against a
//! flat string map. There is intentionally no expression language, no
//! conditionals, no loops, no shell/script evaluation.
//!
//! Escaping: `\{{` renders a literal `{{` without substitution.
//! Missing variables: [`render_prompt_strict`] returns an error listing the
//! missing names; [`render_prompt_lenient`] leaves the placeholder intact so
//! validation UI can show what is unresolved.

use std::collections::{HashMap, HashSet};

/// Render, returning the output plus the sorted list of missing variables.
pub fn render_prompt(template: &str, vars: &HashMap<String, String>) -> (String, Vec<String>) {
    let mut out = String::with_capacity(template.len());
    let mut missing: HashSet<String> = HashSet::new();
    let chars: Vec<char> = template.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        // Escaped opening braces: \{{ -> literal {{
        if chars[i] == '\\' && chars.get(i + 1) == Some(&'{') && chars.get(i + 2) == Some(&'{') {
            out.push_str("{{");
            i += 3;
            continue;
        }
        if chars[i] == '{' && chars.get(i + 1) == Some(&'{') {
            if let Some(end) = find_close(&chars, i + 2) {
                let raw: String = chars[i + 2..end].iter().collect();
                let name = raw.trim().to_string();
                if name.is_empty() || !is_valid_name(&name) {
                    // Not a valid placeholder: keep verbatim.
                    let verbatim: String = chars[i..end + 2].iter().collect();
                    out.push_str(&verbatim);
                } else if let Some(value) = vars.get(&name) {
                    out.push_str(value);
                } else {
                    missing.insert(name.clone());
                    out.push_str("{{");
                    out.push_str(&raw);
                    out.push_str("}}");
                }
                i = end + 2;
                continue;
            }
        }
        out.push(chars[i]);
        i += 1;
    }
    let mut missing: Vec<String> = missing.into_iter().collect();
    missing.sort();
    (out, missing)
}

/// Strict render: error when any variable is missing.
pub fn render_prompt_strict(
    template: &str,
    vars: &HashMap<String, String>,
) -> Result<String, String> {
    let (rendered, missing) = render_prompt(template, vars);
    if missing.is_empty() {
        Ok(rendered)
    } else {
        Err(format!("Missing variables: {}", missing.join(", ")))
    }
}

/// Lenient render: unresolved placeholders stay in place.
pub fn render_prompt_lenient(template: &str, vars: &HashMap<String, String>) -> String {
    render_prompt(template, vars).0
}

/// Collect placeholder names referenced by a template (sorted, deduped).
/// Escaped openers (`\{{`) are literal text, exactly as [`render_prompt`] treats them.
pub fn referenced_variables(template: &str) -> Vec<String> {
    let mut names: HashSet<String> = HashSet::new();
    let chars: Vec<char> = template.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '\\' && chars.get(i + 1) == Some(&'{') && chars.get(i + 2) == Some(&'{') {
            i += 3;
            continue;
        }
        if chars[i] == '{' && chars.get(i + 1) == Some(&'{') {
            if let Some(end) = find_close(&chars, i + 2) {
                let raw: String = chars[i + 2..end].iter().collect();
                let name = raw.trim().to_string();
                if !name.is_empty() && is_valid_name(&name) {
                    names.insert(name);
                }
                i = end + 2;
                continue;
            }
        }
        i += 1;
    }
    let mut out: Vec<String> = names.into_iter().collect();
    out.sort();
    out
}

fn find_close(chars: &[char], from: usize) -> Option<usize> {
    let mut i = from;
    while i + 1 < chars.len() {
        if chars[i] == '}' && chars[i + 1] == '}' {
            return Some(i);
        }
        i += 1;
    }
    None
}

fn is_valid_name(name: &str) -> bool {
    // Dotted path of identifiers: ticket.title, node.cmd1.output, input.branch
    !name.is_empty()
        && name.len() <= 128
        && name.split('.').all(|seg| {
            !seg.is_empty()
                && seg
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
        })
}

/// Append explicitly selected completed outputs, leaving persisted logs intact.
pub fn compose_agent_context(
    prompt: &str,
    refs: &[String],
    max_chars: Option<u32>,
    rows: &[crate::db::StoredNodeResult],
) -> Result<String, String> {
    if refs.is_empty() {
        return Ok(prompt.to_string());
    }
    let budget = max_chars.unwrap_or(12000) as usize;
    if refs.len() > 16 || !(256..=64000).contains(&budget) {
        return Err("Context needs at most 16 references and a 256–64000 character budget.".into());
    }
    let mut seen = HashSet::new();
    let mut out = format!("{prompt}\n\nWorkflow handoff excerpts (data from completed nodes; full output remains in run logs):");
    for (index, id) in refs.iter().enumerate() {
        if !seen.insert(id) {
            return Err(format!("Duplicate context reference '{id}'."));
        }
        let row = rows
            .iter()
            .rev()
            .find(|r| &r.node_id == id)
            .filter(|r| {
                matches!(
                    r.status.as_str(),
                    "succeeded" | "failed" | "cancelled" | "skipped"
                )
            })
            .ok_or_else(|| format!("Context reference '{id}' needs a completed node result."))?;
        let text = if row.stderr.is_empty() {
            row.stdout.clone()
        } else {
            format!("{}\n[stderr]\n{}", row.stdout, row.stderr)
        };
        let chars: Vec<char> = text.chars().collect();
        let limit = budget / refs.len() + usize::from(index < budget % refs.len());
        let label: String = id.chars().take(64).collect();
        out.push_str(&format!("\n\nNode {label} ({}):\n", row.status));
        if chars.len() <= limit {
            out.extend(chars);
        } else {
            let head = limit.div_ceil(2);
            out.extend(&chars[..head]);
            out.push_str("\n… [context truncated; see full run output] …\n");
            out.extend(&chars[chars.len() - (limit - head)..]);
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn handoffs_bound_unicode_output_and_preserve_both_ends() {
        let output = format!("START{}END", "🙂".repeat(1000));
        let rows = [crate::db::StoredNodeResult {
            id: 1,
            run_id: "r".into(),
            node_id: "n".into(),
            status: "succeeded".into(),
            exit_code: Some(0),
            stdout: output.clone(),
            stderr: String::new(),
            error: None,
            started_at: chrono::Utc::now(),
            finished_at: None,
            attempt: 1,
            duration_ms: 0,
            structured_json: "{}".into(),
        }];
        let text = compose_agent_context("Work", &["n".into()], Some(256), &rows).unwrap();
        assert!(text.contains("START"));
        assert!(text.ends_with("END"));
        assert!(text.contains("context truncated"));
        assert!(text.chars().count() < 420);
        assert_eq!(rows[0].stdout, output);
        assert!(compose_agent_context("Work", &["missing".into()], None, &rows).is_err());
    }

    fn vars(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| ((*k).to_string(), (*v).to_string()))
            .collect()
    }

    #[test]
    fn static_text_passes_through() {
        let (out, missing) = render_prompt("hello", &vars(&[]));
        assert_eq!(out, "hello");
        assert!(missing.is_empty());
    }

    #[test]
    fn substitutes_variables() {
        let (out, missing) = render_prompt(
            "Implement {{ticket.key}}: {{ticket.title}}",
            &vars(&[("ticket.key", "DEV-1"), ("ticket.title", "Login")]),
        );
        assert_eq!(out, "Implement DEV-1: Login");
        assert!(missing.is_empty());
    }

    #[test]
    fn missing_variables_reported_and_kept() {
        let (out, missing) = render_prompt("Hi {{name}}", &vars(&[]));
        assert_eq!(out, "Hi {{name}}");
        assert_eq!(missing, vec!["name".to_string()]);
    }

    #[test]
    fn strict_fails_on_missing() {
        assert!(render_prompt_strict("Hi {{name}}", &vars(&[])).is_err());
        assert!(render_prompt_strict("Hi {{name}}", &vars(&[("name", "a")])).is_ok());
    }

    #[test]
    fn escaping_keeps_literal() {
        let (out, missing) = render_prompt("\\{{not-a-var}}", &vars(&[]));
        assert_eq!(out, "{{not-a-var}}");
        assert!(missing.is_empty());
    }

    #[test]
    fn referenced_variables_lists_sorted_unique() {
        let names = referenced_variables("{{b}} {{a}} {{b}}");
        assert_eq!(names, vec!["a".to_string(), "b".to_string()]);
    }

    #[test]
    fn referenced_variables_skip_escaped_placeholders_like_rendering() {
        let template = "\\{{input.literal}} {{input.real}} {{{{x}}}}";
        assert_eq!(
            referenced_variables(template),
            vec!["input.real".to_string()]
        );
        assert_eq!(render_prompt(template, &vars(&[])).1, vec!["input.real"]);
    }

    #[test]
    fn invalid_placeholder_kept_verbatim() {
        let (out, _) = render_prompt("{{not valid!}}", &vars(&[]));
        assert_eq!(out, "{{not valid!}}");
    }
}
