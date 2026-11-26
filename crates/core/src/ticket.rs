//! Ticket Source interface with a ticket-over-MCP implementation: Jira
//! issues (`jira_get_issue`) and Shortcut stories (`stories-get-by-id`),
//! whichever tool the step's server lists.
//!
//! Ticket data is normalized to a provider-neutral structure so prompts,
//! conditions, and later workflow steps never depend on Jira or Shortcut
//! field layouts.
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

/// The tool Ticket steps call on a Jira MCP server.
pub const DEFAULT_TICKET_TOOL: &str = "jira_get_issue";
/// The tool Ticket steps call on Shortcut's MCP server.
pub const SHORTCUT_STORY_TOOL: &str = "stories-get-by-id";
/// The tools a Ticket step can read a ticket with, in the order tried.
pub const TICKET_TOOLS: [&str; 2] = [DEFAULT_TICKET_TOOL, SHORTCUT_STORY_TOOL];

/// Which ticket system a ticket came from, by the tool that read it (the
/// provenance recorded with the step's result).
pub fn provider_of_tool(tool: &str) -> &'static str {
    if tool == SHORTCUT_STORY_TOOL {
        "shortcut-mcp"
    } else {
        "jira-mcp"
    }
}

/// Jira or Shortcut via a configured MCP server: the step uses whichever
/// ticket tool the server lists. `tool_name` is the Jira tool's name.
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
            tool_name: DEFAULT_TICKET_TOOL.to_string(),
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
        self.load_ticket_with_tool(key).map(|(ticket, _)| ticket)
    }
}

impl JiraMcpSource {
    /// The ticket and the tool that read it.
    pub fn load_ticket_with_tool(&self, key: &str) -> Result<(NormalizedTicket, String), String> {
        let input = key.trim();
        if input.is_empty() {
            return Err("Ticket key must not be empty.".to_string());
        }
        if input.chars().count() > 300 {
            return Err("Ticket key is too long.".to_string());
        }
        let jira_key = ticket_key(input);
        let story = shortcut_story_id(input);
        let jira_tool = self.tool_name.clone();
        let candidates = [jira_tool.as_str(), SHORTCUT_STORY_TOOL];
        let arguments = {
            let jira_key = jira_key.clone();
            let jira_tool = jira_tool.clone();
            let input = input.to_string();
            move |tool: &str| {
                if tool == jira_tool {
                    if jira_key.len() > 60 {
                        return Err("Ticket key is too long.".to_string());
                    }
                    return Ok(serde_json::json!({ "key": jira_key, "issueKey": jira_key }));
                }
                match story {
                    Some(id) => Ok(serde_json::json!({ "storyPublicId": id })),
                    None => Err(format!(
                        "'{input}' is not a Shortcut story: use its number, sc-123 or the story's link."
                    )),
                }
            }
        };
        // A server that cannot list its tools is called as a Jira server, as
        // Ticket steps always did.
        let result = crate::mcp::call_first_listed(
            &self.server,
            &candidates,
            Some(jira_tool.as_str()),
            arguments,
            self.timeout,
            &self.cancel,
        )?;
        if result.is_error {
            return Err(format!("Ticket tool error: {}", snippet(&result.text, 500)));
        }
        let ticket = if result.tool == SHORTCUT_STORY_TOOL {
            // The id was checked before the call.
            normalize_shortcut_payload(story.unwrap_or_default(), &result.text)?
        } else {
            normalize_jira_payload(&jira_key, &result.text)?
        };
        Ok((ticket, result.tool))
    }
}

/// A Shortcut story's number in a ticket input: `123`, `#123`, `sc-123`, or
/// a story link such as `https://app.shortcut.com/acme/story/123/a-title`.
pub fn shortcut_story_id(input: &str) -> Option<u64> {
    let trimmed = input.trim();
    let number = |text: &str| {
        let digits = text.trim();
        (!digits.is_empty() && digits.len() <= 12 && digits.chars().all(|c| c.is_ascii_digit()))
            .then(|| digits.parse::<u64>().ok())
            .flatten()
            .filter(|n| *n > 0)
    };
    if trimmed.contains("://") {
        // The number after a `story` segment (a workspace may be named
        // "story" too, so keep looking).
        let parts: Vec<&str> = trimmed.split(['/', '?', '#']).collect();
        return parts
            .windows(2)
            .filter(|pair| pair[0] == "story")
            .find_map(|pair| number(pair[1]));
    }
    let lower = trimmed.to_ascii_lowercase();
    let rest = lower
        .strip_prefix("sc-")
        .or_else(|| lower.strip_prefix('#'))
        .unwrap_or(&lower);
    number(rest)
}

/// Normalize a Shortcut story read by `stories-get-by-id`: its JSON holds
/// `story` (name, description, `app_url`, labels, `workflow_state_id`) and
/// `relatedEntities.workflows` with the state names. A reply without a named
/// story (an error the server did not mark as one) is an error.
pub fn normalize_shortcut_payload(id: u64, text: &str) -> Result<NormalizedTicket, String> {
    let key = format!("sc-{id}");
    let value = extract_json_object(text)
        .and_then(|json| serde_json::from_str::<serde_json::Value>(&json).ok());
    let story = value
        .as_ref()
        .map(|v| v.get("story").unwrap_or(v))
        .filter(|story| {
            story
                .get("name")
                .and_then(|n| n.as_str())
                .is_some_and(|n| !n.trim().is_empty())
        });
    let (Some(value), Some(story)) = (value.as_ref(), story) else {
        return Err(format!(
            "Shortcut did not return story {key}: {}",
            snippet(text, 300)
        ));
    };
    let text_of = |names: &[&str]| {
        names
            .iter()
            .filter_map(|n| story.get(*n))
            .find_map(|v| v.as_str())
            .unwrap_or("")
            .to_string()
    };
    let state_id = story.get("workflow_state_id").and_then(|v| v.as_u64());
    let status = value
        .get("relatedEntities")
        .and_then(|r| r.get("workflows"))
        .and_then(|w| w.as_object())
        .into_iter()
        .flat_map(|workflows| workflows.values())
        .filter_map(|workflow| workflow.get("states").and_then(|s| s.as_array()))
        .flatten()
        .find(|state| state.get("id").and_then(|v| v.as_u64()) == state_id && state_id.is_some())
        .and_then(|state| state.get("name").and_then(|v| v.as_str()))
        .map(str::to_string)
        .unwrap_or_else(|| text_of(&["workflow_state_name", "state"]));
    let labels = story
        .get("labels")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| {
                    v.as_str()
                        .map(str::to_string)
                        .or_else(|| v.get("name").and_then(|n| n.as_str()).map(str::to_string))
                })
                .collect()
        })
        .unwrap_or_default();
    // The story's tasks read as acceptance criteria: they are what "done"
    // means. Finished ones say so.
    let acceptance_criteria = story
        .get("tasks")
        .and_then(|v| v.as_array())
        .map(|tasks| {
            tasks
                .iter()
                .filter_map(|t| {
                    let text = t.get("description").and_then(|d| d.as_str())?;
                    let done = t.get("complete").and_then(|c| c.as_bool()) == Some(true);
                    Some(if done {
                        format!("{text} (done)")
                    } else {
                        text.to_string()
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    let url = Some(text_of(&["app_url", "url"])).filter(|u| !u.is_empty());
    Ok(NormalizedTicket {
        key,
        title: text_of(&["name", "title"]),
        description: text_of(&["description"]),
        acceptance_criteria,
        status,
        url,
        labels,
    })
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
    fn shortcut_story_ids_come_from_numbers_keys_and_links() {
        for (input, id) in [
            ("123", Some(123)),
            (" sc-123 ", Some(123)),
            ("SC-77", Some(77)),
            ("#9", Some(9)),
            (
                "https://app.shortcut.com/acme/story/4567/dark-mode",
                Some(4567),
            ),
            (
                "https://app.shortcut.com/acme/story/4567?ct_workflow=all",
                Some(4567),
            ),
            ("https://app.shortcut.com/acme/epic/12", None),
            ("https://app.shortcut.com/story/story/12/a-title", Some(12)),
            ("DEV-12", None),
            ("0", None),
            ("sc-", None),
        ] {
            assert_eq!(shortcut_story_id(input), id, "{input}");
        }
    }

    #[test]
    fn normalizes_a_shortcut_story() {
        let text = r#"Story: sc-42

<json>
{
  "story": {
    "id": 42,
    "name": "Dark mode",
    "app_url": "https://app.shortcut.com/acme/story/42",
    "description": "Add a toggle in settings",
    "workflow_state_id": 500000008,
    "labels": ["ui"],
    "tasks": [
      {"id": 1, "description": "Toggle persists", "complete": false},
      {"id": 2, "description": "Design approved", "complete": true}
    ]
  },
  "relatedEntities": {
    "workflows": {
      "500000005": {"id": 500000005, "name": "Engineering", "states": [
        {"id": 500000007, "name": "To Do", "type": "unstarted"},
        {"id": 500000008, "name": "In Progress", "type": "started"}
      ]}
    }
  }
}
</json>"#;
        let ticket = normalize_shortcut_payload(42, text).expect("story");
        assert_eq!(ticket.key, "sc-42");
        assert_eq!(ticket.title, "Dark mode");
        assert_eq!(ticket.status, "In Progress");
        assert_eq!(ticket.description, "Add a toggle in settings");
        assert_eq!(
            ticket.url.as_deref(),
            Some("https://app.shortcut.com/acme/story/42")
        );
        assert_eq!(ticket.labels, ["ui"]);
        assert_eq!(
            ticket.acceptance_criteria,
            ["Toggle persists", "Design approved (done)"]
        );
        // A reply with no story in it is an error, not a ticket named after it.
        let missing =
            normalize_shortcut_payload(9, "Failed to retrieve Shortcut story with public ID: 9");
        assert!(missing
            .expect_err("no story")
            .contains("did not return story sc-9"));
        assert_eq!(provider_of_tool(SHORTCUT_STORY_TOOL), "shortcut-mcp");
        assert_eq!(provider_of_tool(DEFAULT_TICKET_TOOL), "jira-mcp");
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
