//! Ticket Source interface with a Jira-over-MCP implementation (Milestone 4).
//!
//! Ticket data is normalized to a provider-neutral structure so prompts,
//! conditions, and later workflow steps never depend on Jira field layouts.
//! Ticket/PR text is **untrusted input**: it is passed to agents as data and
//! is never executed. History and prompts cap ticket context explicitly.

use serde::{Deserialize, Serialize};
use std::sync::{atomic::AtomicBool, Arc};
use std::time::Duration;

/// Provider-neutral ticket.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NormalizedTicket {
    pub key: String,
    pub title: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub acceptance_criteria: Vec<String>,
    #[serde(default)]
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default)]
    pub labels: Vec<String>,
}

impl NormalizedTicket {
    /// Bounded context string for prompts: title + description + criteria,
    /// truncated to keep agent context deliberate.
    pub fn prompt_context(&self, max_chars: usize) -> String {
        let mut out = format!("{}: {}\n", self.key, self.title);
        if !self.status.is_empty() {
            out.push_str(&format!("Status: {}\n", self.status));
        }
        if !self.description.is_empty() {
            out.push_str(&format!("Description:\n{}\n", self.description));
        }
        if !self.acceptance_criteria.is_empty() {
            out.push_str("Acceptance criteria:\n");
            for criterion in &self.acceptance_criteria {
                out.push_str(&format!("- {criterion}\n"));
            }
        }
        if out.chars().count() > max_chars {
            let truncated: String = out.chars().take(max_chars).collect();
            format!("{truncated}\n… [ticket context truncated]")
        } else {
            out
        }
    }
}

/// What the engine needs from any ticket provider.
pub trait TicketSource {
    fn source_name(&self) -> String;
    fn load_ticket(&self, key: &str) -> Result<NormalizedTicket, String>;
}

/// Jira via a configured MCP server. The tool name is configurable because
/// MCP servers differ (`jira_get_issue` is the common default).
pub struct JiraMcpSource {
    pub server: crate::mcp::McpServerConfig,
    pub tool_name: String,
    pub timeout: Duration,
    pub cancel: Arc<AtomicBool>,
    /// Cap on ticket context injected into prompts (default 8000 chars).
    pub max_context_chars: usize,
}

impl JiraMcpSource {
    pub fn new(server: crate::mcp::McpServerConfig) -> Self {
        Self {
            server,
            tool_name: "jira_get_issue".to_string(),
            timeout: Duration::from_secs(30),
            cancel: Arc::new(AtomicBool::new(false)),
            max_context_chars: 8000,
        }
    }
}

impl TicketSource for JiraMcpSource {
    fn source_name(&self) -> String {
        format!("jira (MCP server '{}')", self.server.name)
    }

    fn load_ticket(&self, key: &str) -> Result<NormalizedTicket, String> {
        let key = ticket_key(key);
        let trimmed = key.as_str();
        if trimmed.is_empty() {
            return Err("Ticket key must not be empty.".to_string());
        }
        if trimmed.len() > 60 {
            return Err("Ticket key is too long.".to_string());
        }
        let result = crate::mcp::call_tool(
            &self.server,
            &self.tool_name,
            &serde_json::json!({ "key": trimmed, "issueKey": trimmed }),
            self.timeout,
            &self.cancel,
        )?;
        if result.is_error {
            return Err(format!("Ticket tool error: {}", snippet(&result.text, 500)));
        }
        normalize_jira_payload(trimmed, &result.text)
    }
}

/// The issue key in a ticket input: a key as typed, or the key inside a Jira
/// URL such as `https://acme.atlassian.net/browse/DEV-1234?focusedId=1`.
pub fn ticket_key(input: &str) -> String {
    let trimmed = input.trim();
    if !trimmed.contains("://") {
        return trimmed.to_string();
    }
    let is_key = |token: &&str| {
        let Some((project, number)) = token.split_once('-') else {
            return false;
        };
        project.starts_with(|c: char| c.is_ascii_uppercase())
            && project
                .chars()
                .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_')
            && !number.is_empty()
            && number.chars().all(|c| c.is_ascii_digit())
    };
    trimmed
        .split(['/', '?', '&', '=', '#'])
        .rfind(is_key)
        .unwrap_or(trimmed)
        .to_string()
}

/// Best-effort normalization of a Jira MCP payload: accept either a JSON
/// object with common fields or raw text (kept as description).
pub fn normalize_jira_payload(key: &str, text: &str) -> Result<NormalizedTicket, String> {
    // Try to find a JSON object in the text (MCP wraps content as text).
    if let Some(json) = extract_json_object(text) {
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(&json) {
            let get = |names: &[&str]| {
                names
                    .iter()
                    .filter_map(|n| value.get(*n))
                    .find_map(|v| v.as_str())
                    .unwrap_or("")
                    .to_string()
            };
            let title = get(&["summary", "title", "name"]);
            let description = get(&["description", "body"]);
            let status = value
                .get("status")
                .map(|s| {
                    if let Some(name) = s.as_str() {
                        name.to_string()
                    } else {
                        s.get("name")
                            .and_then(|n| n.as_str())
                            .unwrap_or("")
                            .to_string()
                    }
                })
                .unwrap_or_default();
            let acceptance_criteria = value
                .get("acceptanceCriteria")
                .or_else(|| value.get("acceptance_criteria"))
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|v| v.as_str().map(str::to_string))
                        .collect()
                })
                .unwrap_or_default();
            let url = value
                .get("url")
                .or_else(|| value.get("self"))
                .and_then(|v| v.as_str())
                .map(str::to_string);
            let labels = value
                .get("labels")
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|v| {
                            v.as_str().map(str::to_string).or_else(|| {
                                v.get("name").and_then(|n| n.as_str()).map(str::to_string)
                            })
                        })
                        .collect()
                })
                .unwrap_or_default();
            return Ok(NormalizedTicket {
                key: value
                    .get("key")
                    .and_then(|v| v.as_str())
                    .unwrap_or(key)
                    .to_string(),
                title,
                description,
                acceptance_criteria,
                status,
                url,
                labels,
            });
        }
    }
    // Non-JSON payloads: keep as description so nothing is lost.
    Ok(NormalizedTicket {
        key: key.to_string(),
        title: snippet(text, 120),
        description: snippet(text, 4000),
        acceptance_criteria: Vec::new(),
        status: String::new(),
        url: None,
        labels: Vec::new(),
    })
}

fn extract_json_object(text: &str) -> Option<String> {
    let start = text.find('{')?;
    let end = text.rfind('}')?;
    if end > start {
        Some(text[start..=end].to_string())
    } else {
        None
    }
}

fn snippet(text: &str, max: usize) -> String {
    let one_line: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if one_line.chars().count() > max {
        one_line.chars().take(max).collect()
    } else {
        one_line
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ticket_key_accepts_keys_and_jira_urls() {
        for (input, key) in [
            ("DEV-1234", "DEV-1234"),
            ("  DEV-1234 ", "DEV-1234"),
            ("https://acme.atlassian.net/browse/DEV-1234", "DEV-1234"),
            ("https://acme.atlassian.net/browse/OPS_2-77?focusedCommentId=9", "OPS_2-77"),
            (
                "https://acme.atlassian.net/jira/software/projects/DEV/boards/1?selectedIssue=DEV-42",
                "DEV-42",
            ),
            ("https://example.com/no-key-here", "https://example.com/no-key-here"),
        ] {
            assert_eq!(ticket_key(input), key, "{input}");
        }
    }

    #[test]
    fn normalizes_json_payload() {
        let ticket = normalize_jira_payload(
            "DEV-1",
            r#"prefix {"key":"DEV-1","summary":"Cart bug","description":"Fails on empty cart","status":{"name":"To Do"},"labels":["bug"]} suffix"#,
        )
        .expect("normalize");
        assert_eq!(ticket.key, "DEV-1");
        assert_eq!(ticket.title, "Cart bug");
        assert!(ticket.description.contains("empty cart"));
        assert_eq!(ticket.labels, vec!["bug".to_string()]);
    }

    #[test]
    fn falls_back_to_text_payload() {
        let ticket = normalize_jira_payload("DEV-9", "just some text").expect("normalize");
        assert_eq!(ticket.key, "DEV-9");
        assert!(ticket.description.contains("just some text"));
    }

    #[test]
    fn prompt_context_is_bounded() {
        let ticket = NormalizedTicket {
            key: "DEV-1".into(),
            title: "T".into(),
            description: "x".repeat(10_000),
            acceptance_criteria: vec![],
            status: "Open".into(),
            url: None,
            labels: vec![],
        };
        let context = ticket.prompt_context(100);
        assert!(context.chars().count() <= 200);
        assert!(context.contains("truncated"));
    }

    #[test]
    fn empty_key_rejected() {
        let server = crate::mcp::McpServerConfig {
            id: "j".into(),
            name: "J".into(),
            command: "true".into(),
            args: vec![],
            enabled: true,
        };
        let source = JiraMcpSource::new(server);
        assert!(source.load_ticket("   ").is_err());
    }
}
