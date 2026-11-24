//! Normalized review findings (Milestone 5).
//!
//! Agents report findings in a tolerant fenced convention; Orchevia parses
//! them deterministically, fingerprints for cross-agent dedup, and never
//! fabricates file/line locations the agent did not provide.
//!
//! Convention (documented in the review guide):
//!
//! ````text
//! ```finding
//! severity: P1
//! file: src/cart.ts
//! line: 42
//! title: Unchecked empty cart
//! explanation: ...
//! fix: ...
//! ```
//! ````
//!
//! Ordinary output stays in the run transcript. Only valid fenced findings
//! appear in the findings list.

use serde::{Deserialize, Serialize};
use std::cmp::Reverse;
use std::collections::{BTreeMap, HashMap, HashSet};

fn normalize(s: &str) -> String {
    s.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_ascii_lowercase()
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewFinding {
    /// P0, P1, P2, P3, or info.
    pub severity: String,
    #[serde(default)]
    pub category: String,
    pub title: String,
    #[serde(default)]
    pub explanation: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub line_start: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub line_end: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confidence: Option<String>,
    pub source: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub suggested_fix: Option<String>,
    pub fingerprint: String,
}

impl ReviewFinding {
    /// Actionable = P0/P1 (the fix-loop trigger).
    pub fn actionable(&self) -> bool {
        matches!(self.severity.as_str(), "P0" | "P1")
    }
}

/// Stable fingerprint over normalized fields. Same finding from two agents
/// groups together without losing provenance.
pub fn fingerprint(
    severity: &str,
    file: Option<&str>,
    line_start: Option<i64>,
    title: &str,
    explanation: &str,
) -> String {
    // Truncate explanation to its head: long prose shouldn't fork identity.
    let head: String = explanation.chars().take(160).collect();
    let key = format!(
        "{}|{}|{}|{}|{}",
        normalize(severity),
        normalize(file.unwrap_or("")),
        line_start.unwrap_or(-1),
        normalize(title),
        normalize(&head)
    );
    // FNV-1a 64-bit: dependency-free, stable across runs/platforms.
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in key.bytes() {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
}

/// Parse fenced findings from agent text. Never invents locations: fields
/// the agent omitted stay empty.
pub fn extract_findings(text: &str, source: &str) -> Vec<ReviewFinding> {
    let mut findings = Vec::new();
    for block in finding_blocks(text) {
        if let Some(finding) = parse_block(&block, source) {
            findings.push(finding);
        }
    }
    findings
}

fn finding_blocks(text: &str) -> Vec<String> {
    let mut blocks = Vec::new();
    let mut current: Option<Vec<String>> = None;
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.eq_ignore_ascii_case("```finding") {
            current = Some(Vec::new());
            continue;
        }
        if trimmed == "```" {
            if let Some(lines) = current.take() {
                blocks.push(lines.join("\n"));
            }
            continue;
        }
        if let Some(lines) = current.as_mut() {
            lines.push(line.to_string());
        }
    }
    blocks
}

fn parse_block(block: &str, source: &str) -> Option<ReviewFinding> {
    let mut fields: HashMap<String, String> = HashMap::new();
    for line in block.lines() {
        if let Some((key, value)) = line.split_once(':') {
            let key = key.trim().to_ascii_lowercase();
            if !key.is_empty() {
                fields
                    .entry(key)
                    .and_modify(|v| {
                        v.push('\n');
                        v.push_str(value.trim());
                    })
                    .or_insert_with(|| value.trim().to_string());
            }
        }
    }
    let title = fields.get("title").cloned().unwrap_or_default();
    if title.trim().is_empty() {
        return None;
    }
    let severity = normalize_severity(fields.get("severity").map(String::as_str).unwrap_or("info"));
    let file = fields
        .get("file")
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let line_start = fields
        .get("line")
        .or_else(|| fields.get("line_start"))
        .and_then(|s| s.parse().ok());
    let line_end = fields.get("line_end").and_then(|s| s.parse().ok());
    let explanation = fields.get("explanation").cloned().unwrap_or_default();
    let fp = fingerprint(&severity, file.as_deref(), line_start, &title, &explanation);
    Some(ReviewFinding {
        severity,
        category: fields.get("category").cloned().unwrap_or_default(),
        title,
        explanation,
        file,
        line_start,
        line_end,
        confidence: fields.get("confidence").cloned(),
        source: source.to_string(),
        suggested_fix: fields
            .get("fix")
            .or_else(|| fields.get("suggested_fix"))
            .cloned(),
        fingerprint: fp,
    })
}

const LEVELS: [&str; 4] = ["P0", "P1", "P2", "P3"];

/// The highest severity a step's output reports, for `node.<id>.severity`.
///
/// Structured ```finding blocks win when present. Otherwise a `P0`–`P3` tag in
/// prose counts unless it names the scale (`P0–P3`) or is negated right before
/// it (`no P1`, `zero P0 or P1`, `no blocking (P0/P1)`): a clean review that says
/// "No P0/P1 issues found" reports no severity, while "Found P0/P1 issues" does.
pub fn reported_severity(text: &str) -> Option<&'static str> {
    let findings = extract_findings(text, "");
    if !findings.is_empty() {
        return LEVELS
            .into_iter()
            .find(|level| findings.iter().any(|f| f.severity == *level));
    }
    LEVELS
        .into_iter()
        .find(|level| text.lines().any(|line| tagged(line, level)))
}

/// Whether `line` carries `level` as a reported tag (not a range or negated).
fn tagged(line: &str, level: &str) -> bool {
    line.match_indices(level).any(|(start, _)| {
        let before_text = &line[..start];
        let after_text = &line[start + level.len()..];
        let before = before_text.chars().next_back();
        let after = after_text.chars().next();
        let word = |c: Option<char>| c.is_some_and(|c| c.is_alphanumeric() || c == '_');
        if word(before) || word(after) {
            return false;
        }
        // "P0–P3" names the scale, not a finding.
        let dash = |c: Option<char>| matches!(c, Some('-' | '–' | '—'));
        let range = (dash(before) && ends_with_level(trim_last(before_text)))
            || (dash(after) && starts_with_level(&after_text[after.map_or(0, char::len_utf8)..]));
        !range && !negated(clause(before_text))
    })
}

fn trim_last(text: &str) -> &str {
    let mut chars = text.chars();
    chars.next_back();
    chars.as_str()
}

fn starts_with_level(text: &str) -> bool {
    let mut chars = text.chars();
    chars.next() == Some('P') && chars.next().is_some_and(|c| ('0'..='3').contains(&c))
}

fn ends_with_level(text: &str) -> bool {
    let mut chars = text.chars();
    chars.next_back().is_some_and(|c| ('0'..='3').contains(&c))
        && chars.next_back() == Some('P')
        && !chars
            .next_back()
            .is_some_and(|c| c.is_alphanumeric() || c == '_')
}

/// The clause a tag sits in: the text after the last sentence or clause
/// break (`.` `;` `:` `!` `?`, or a dash with spaces around it).
fn clause(before: &str) -> &str {
    let mut start = 0;
    for (i, c) in before.char_indices() {
        let end = i + c.len_utf8();
        let spaced_dash = matches!(c, '-' | '–' | '—')
            && before[..i].ends_with(' ')
            && before[end..].starts_with(' ');
        if matches!(c, '.' | ';' | ':' | '!' | '?') || spaced_dash {
            start = end;
        }
    }
    &before[start..]
}

/// A negation right before the tag group: "no P1", "zero P0, P1 or P2",
/// "without **P1**", "no blocking (P0/P1)". At most one other word may sit in
/// between, and a contrast ("but", "except") ends the search, so "No P0
/// issues, one P1 race" still reports P1.
fn negated(clause: &str) -> bool {
    let mut rest = clause;
    let mut words = 0;
    loop {
        rest = rest.trim_end_matches(|c: char| {
            c.is_whitespace()
                || matches!(c, '*' | '_' | '`' | '(' | '[' | ')' | ']' | ',' | '/' | '&')
        });
        if ends_with_level(rest) {
            if words > 0 {
                return false;
            }
            rest = &rest[..rest.len() - 2];
            continue;
        }
        let word_start = rest
            .char_indices()
            .rev()
            .take_while(|(_, c)| c.is_alphanumeric() || matches!(c, '-' | '\''))
            .last()
            .map_or(rest.len(), |(i, _)| i);
        let word = rest[word_start..].to_lowercase();
        rest = &rest[..word_start];
        match word.as_str() {
            "" => return false,
            "no" | "none" | "zero" | "without" | "not" | "nothing" => return true,
            "or" | "and" | "nor" if words == 0 => {}
            "but" | "except" | "however" | "although" | "though" | "yet" => return false,
            _ => {
                words += 1;
                if words > 1 {
                    return false;
                }
            }
        }
    }
}

fn normalize_severity(raw: &str) -> String {
    let upper = raw.trim().to_ascii_uppercase();
    for level in ["P0", "P1", "P2", "P3"] {
        if upper.contains(level) {
            return level.to_string();
        }
    }
    "info".to_string()
}

/// Group findings by fingerprint, preserving per-source provenance.
/// Returns (finding, sources) with sources sorted.
pub fn deduplicate(findings: Vec<ReviewFinding>) -> Vec<(ReviewFinding, Vec<String>)> {
    let mut groups: HashMap<String, (ReviewFinding, Vec<String>)> = HashMap::new();
    for finding in findings {
        groups
            .entry(finding.fingerprint.clone())
            .and_modify(|(_, sources)| {
                if !sources.contains(&finding.source) {
                    sources.push(finding.source.clone());
                }
            })
            .or_insert_with(|| {
                let source = finding.source.clone();
                (finding, vec![source])
            });
    }
    let mut out: Vec<(ReviewFinding, Vec<String>)> = groups.into_values().collect();
    out.sort_by(|a, b| {
        severity_rank(&a.0.severity)
            .cmp(&severity_rank(&b.0.severity))
            .then_with(|| a.0.title.cmp(&b.0.title))
            .then_with(|| a.0.fingerprint.cmp(&b.0.fingerprint))
    });
    for (_, sources) in &mut out {
        sources.sort();
    }
    out
}

fn severity_rank(severity: &str) -> u8 {
    match severity {
        "P0" => 0,
        "P1" => 1,
        "P2" => 2,
        "P3" => 3,
        _ => 4,
    }
}

/// Serializable grouped finding for API/UI layers.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupedFinding {
    pub finding: ReviewFinding,
    /// Empty for findings absent from every latest review visit.
    pub sources: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub result_ids: Vec<i64>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub history: Vec<FindingHistory>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FindingState {
    Fixed,
    StillOpen,
    New,
    Reintroduced,
}

pub fn review_round_summary(groups: &[GroupedFinding]) -> Option<String> {
    let entries: Vec<_> = groups.iter().flat_map(|group| &group.history).collect();
    let counts = [
        (FindingState::Fixed, "fixed"),
        (FindingState::StillOpen, "still open"),
        (FindingState::New, "new"),
        (FindingState::Reintroduced, "reintroduced"),
    ];
    (!entries.is_empty()).then(|| {
        counts
            .into_iter()
            .map(|(state, label)| {
                let count = entries.iter().filter(|item| item.state == state).count();
                format!("{count} {label}")
            })
            .collect::<Vec<_>>()
            .join(", ")
    })
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FindingOccurrence {
    pub result_id: i64,
    pub visit: usize,
    pub finding: ReviewFinding,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FindingHistory {
    pub id: String,
    pub state: FindingState,
    pub occurrences: Vec<FindingOccurrence>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub previous_severity: Option<String>,
}

pub struct ReviewVisit<'a> {
    pub node_id: &'a str,
    pub result_id: i64,
    pub source: String,
    pub stdout: &'a str,
}

/// Use successful, actual visits. Empty output is a visit, but a running or
/// failed attempt, a reused result and a feedback decision are not reviews.
pub fn run_review_findings(
    workflow: &crate::workflow::Workflow,
    rows: &[crate::db::StoredNodeResult],
    mut profile_name: impl FnMut(&str) -> Option<String>,
) -> Vec<GroupedFinding> {
    let sources: HashMap<_, _> = workflow
        .nodes
        .iter()
        .filter(|node| node.kind == crate::workflow::NodeKind::Agent)
        .map(|node| {
            let profile = node
                .config
                .agent_profile_id
                .as_deref()
                .and_then(&mut profile_name);
            let source = match profile.filter(|name| !name.trim().is_empty()) {
                Some(name) => format!("{} ({name})", node.id),
                None => node.id.clone(),
            };
            (node.id.as_str(), source)
        })
        .collect();
    let visits: Vec<_> = rows
        .iter()
        .filter_map(|row| {
            let source = sources.get(row.node_id.as_str())?;
            if row.status != "succeeded" || !crate::run_controls::is_new_execution(row) {
                return None;
            }
            if serde_json::from_str::<serde_json::Value>(&row.structured_json)
                .is_ok_and(|metadata| metadata.get("feedbackCheck").is_some())
            {
                return None;
            }
            Some(ReviewVisit {
                node_id: &row.node_id,
                result_id: row.id,
                source: source.clone(),
                stdout: &row.stdout,
            })
        })
        .collect();
    grouped_review_findings(&visits)
}

/// Compare each reviewer independently. Exact fingerprints still group the
/// latest findings across reviewers and determine current notification counts.
pub fn grouped_review_findings(visits: &[ReviewVisit<'_>]) -> Vec<GroupedFinding> {
    let mut by_node: BTreeMap<&str, Vec<&ReviewVisit<'_>>> = BTreeMap::new();
    for visit in visits {
        by_node.entry(visit.node_id).or_default().push(visit);
    }
    let mut current = Vec::new();
    let mut result_ids: HashMap<String, Vec<i64>> = HashMap::new();
    let mut histories = Vec::new();
    for (node_id, mut visits) in by_node {
        visits.sort_by_key(|v| v.result_id);
        let visits: Vec<_> = visits
            .into_iter()
            .map(|v| {
                let mut seen = HashSet::new();
                let findings = extract_findings(v.stdout, &v.source)
                    .into_iter()
                    .filter(|f| seen.insert(f.fingerprint.clone()))
                    .collect::<Vec<_>>();
                (v.result_id, findings)
            })
            .collect();
        if let Some((result_id, findings)) = visits.last() {
            current.extend(findings.iter().cloned());
            for finding in findings {
                result_ids
                    .entry(finding.fingerprint.clone())
                    .or_default()
                    .push(*result_id);
            }
        }
        if visits.len() > 1 {
            histories.extend(compare_visits(node_id, visits));
        }
    }
    let mut groups: Vec<_> = deduplicate(current)
        .into_iter()
        .map(|(finding, sources)| {
            let result_ids = result_ids.remove(&finding.fingerprint).unwrap_or_default();
            GroupedFinding {
                finding,
                sources,
                result_ids,
                history: Vec::new(),
            }
        })
        .collect();
    let mut indexes: HashMap<_, _> = groups
        .iter()
        .enumerate()
        .map(|(index, group)| (group.finding.fingerprint.clone(), index))
        .collect();
    for history in histories {
        let Some(last) = history.occurrences.last() else {
            continue;
        };
        let index = *indexes
            .entry(last.finding.fingerprint.clone())
            .or_insert_with(|| {
                groups.push(GroupedFinding {
                    finding: last.finding.clone(),
                    sources: Vec::new(),
                    result_ids: Vec::new(),
                    history: Vec::new(),
                });
                groups.len() - 1
            });
        groups[index].history.push(history);
    }
    groups
}

fn comparison_key(finding: &ReviewFinding) -> (Option<&str>, String) {
    let file = finding
        .file
        .as_deref()
        .map(|file| file.trim_start_matches("./"));
    let title = finding
        .title
        .trim_start_matches('#')
        .trim()
        .trim_end_matches(['.', ':']);
    (file, normalize(title))
}

fn match_distance(a: &ReviewFinding, b: &ReviewFinding) -> Option<u64> {
    let (start_a, start_b) = (a.line_start?, b.line_start?);
    let end_a = a.line_end.unwrap_or(start_a).max(start_a);
    let end_b = b.line_end.unwrap_or(start_b).max(start_b);
    Some(start_a.abs_diff(start_b).min(if end_a < start_b {
        end_a.abs_diff(start_b)
    } else if end_b < start_a {
        end_b.abs_diff(start_a)
    } else {
        0
    }))
}

fn compare_visits(node_id: &str, visits: Vec<(i64, Vec<ReviewFinding>)>) -> Vec<FindingHistory> {
    let latest = visits.len();
    let mut tracks: Vec<Vec<FindingOccurrence>> = Vec::new();
    for (offset, (result_id, findings)) in visits.into_iter().enumerate() {
        let visit = offset + 1;
        let mut previous: HashMap<_, Vec<_>> = HashMap::new();
        for (index, track) in tracks.iter().enumerate() {
            if let Some(last) = track.last() {
                previous
                    .entry(comparison_key(&last.finding))
                    .or_default()
                    .push((index, last));
            }
        }
        let keys: Vec<_> = findings.iter().map(comparison_key).collect();
        let mut counts = HashMap::new();
        for key in &keys {
            *counts.entry(key).or_insert(0) += 1;
        }
        let mut candidates = Vec::new();
        for (index, (key, finding)) in keys.iter().zip(&findings).enumerate() {
            let Some(prior) = previous.get(key) else {
                continue;
            };
            let unique = prior.len() == 1 && counts.get(key) == Some(&1);
            for &(track, last) in prior {
                let distance = match_distance(&last.finding, finding);
                if unique || distance.is_some_and(|lines| lines <= 20) {
                    candidates.push((distance.unwrap_or(21), Reverse(last.visit), track, index));
                }
            }
        }
        candidates.sort_unstable();
        let mut used = HashSet::new();
        let mut matches = HashMap::new();
        for (_, _, track, index) in candidates {
            if !matches.contains_key(&index) && used.insert(track) {
                matches.insert(index, track);
            }
        }
        for (index, finding) in findings.into_iter().enumerate() {
            let occurrence = FindingOccurrence {
                result_id,
                visit,
                finding,
            };
            if let Some(track) = matches.get(&index) {
                tracks[*track].push(occurrence);
            } else {
                tracks.push(vec![occurrence]);
            }
        }
    }
    tracks
        .into_iter()
        .filter_map(|occurrences| {
            let first = occurrences.first()?;
            let last = occurrences.last()?;
            let previous = occurrences.iter().rev().nth(1);
            let state = if last.visit < latest {
                FindingState::Fixed
            } else if let Some(previous) = previous {
                if previous.visit + 1 == latest {
                    FindingState::StillOpen
                } else {
                    FindingState::Reintroduced
                }
            } else {
                FindingState::New
            };
            let previous_severity = previous
                .filter(|p| p.finding.severity != last.finding.severity)
                .map(|p| p.finding.severity.clone());
            Some(FindingHistory {
                id: format!(
                    "{node_id}:{}:{}",
                    first.result_id, first.finding.fingerprint
                ),
                state,
                occurrences,
                previous_severity,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shared_review_comparison_fixture() {
        let fixture: serde_json::Value =
            serde_json::from_str(include_str!("../../../src/test/review-rounds.json")).unwrap();
        let visits: Vec<_> = fixture["visits"]
            .as_array()
            .unwrap()
            .iter()
            .map(|value| ReviewVisit {
                node_id: value["nodeId"].as_str().unwrap(),
                result_id: value["resultId"].as_i64().unwrap(),
                source: value["nodeId"].as_str().unwrap().into(),
                stdout: value["stdout"].as_str().unwrap(),
            })
            .collect();
        let groups = grouped_review_findings(&visits);
        let mut actual: Vec<_> = groups
            .iter()
            .flat_map(|group| &group.history)
            .map(|item| {
                let mut value = serde_json::json!({
                    "title": item.occurrences.last().unwrap().finding.title,
                    "state": item.state,
                    "resultIds": item.occurrences.iter().map(|o| o.result_id).collect::<Vec<_>>()
                });
                if let Some(severity) = &item.previous_severity {
                    value["previousSeverity"] = serde_json::json!(severity);
                }
                value
            })
            .collect();
        let mut expected = fixture["expected"].as_array().unwrap().clone();
        actual.sort_by(|a, b| a["title"].as_str().cmp(&b["title"].as_str()));
        expected.sort_by(|a, b| a["title"].as_str().cmp(&b["title"].as_str()));
        assert_eq!(actual, expected);
        let shared = groups
            .iter()
            .find(|g| g.finding.title == "Missing lock")
            .unwrap();
        assert_eq!(shared.sources, ["review-a", "review-b"]);
    }

    /// Shared with `src/lib/severity.test.ts`; keep both tables identical.
    const SEVERITY_CASES: &[(&str, Option<&str>)] = &[
        ("No P0/P1 issues found.", None),
        ("There are no P0 or P1 findings.", None),
        ("Found zero P0, P1 or P2 problems.", None),
        ("Without **P1** findings, this is ready.", None),
        ("No blocking (P0/P1) issues.", None),
        ("Severities run P0–P3.", None),
        ("Nothing blocking.", None),
        ("SP1 sprint notes", None),
        (
            "- **P1** src/a.ts:3 — the lock is never released",
            Some("P1"),
        ),
        ("P0: crash on an empty cart", Some("P0")),
        ("Severity: P1", Some("P1")),
        ("No P0 issues; one P2 naming nit.", Some("P2")),
        ("No P0 issues, one P1 race.", Some("P1")),
        ("Two findings: P2 naming and P1 race.", Some("P1")),
        ("P1-level risk in auth", Some("P1")),
        (
            "Found P0/P1 issues: authentication can be bypassed.",
            Some("P0"),
        ),
        ("No P0 — P1: authentication is bypassed.", Some("P1")),
        ("Not blocking, but P1: a race on retry.", Some("P1")),
        ("There is no auth check on this route (P0).", Some("P0")),
        (
            "No P0/P1 issues.\n```finding\nseverity: P2\ntitle: Naming\n```",
            Some("P2"),
        ),
        (
            "P0 crash mentioned in prose\n```finding\nseverity: info\ntitle: Note\n```",
            None,
        ),
    ];

    #[test]
    fn reported_severity_ignores_lists_and_negations_and_prefers_findings() {
        for (text, expected) in SEVERITY_CASES {
            assert_eq!(reported_severity(text), *expected, "{text}");
        }
    }

    const SAMPLE: &str = r#"Review done.
```finding
severity: P1
file: src/cart.ts
line: 42
title: Unchecked empty cart
explanation: Checkout proceeds with zero items.
fix: Guard on cart.length.
```
Trailing prose.
"#;

    #[test]
    fn parses_fenced_block() {
        let findings = extract_findings(SAMPLE, "claude");
        assert_eq!(findings.len(), 1);
        let finding = &findings[0];
        assert_eq!(finding.severity, "P1");
        assert_eq!(finding.file.as_deref(), Some("src/cart.ts"));
        assert_eq!(finding.line_start, Some(42));
        assert_eq!(finding.title, "Unchecked empty cart");
        assert!(finding.actionable());
        assert!(!finding.fingerprint.is_empty());
    }

    #[test]
    fn ordinary_agent_answer_is_not_a_review_finding() {
        let findings = extract_findings("## Answer\nHere is the explanation.", "codex");
        assert!(findings.is_empty());
        let run_findings = grouped_review_findings(&[ReviewVisit {
            node_id: "answer",
            result_id: 1,
            source: "answer (Codex)".into(),
            stdout: "## Answer\nHere is the explanation.",
        }]);
        assert!(run_findings.is_empty());
    }

    #[test]
    fn same_finding_dedupes_across_agents() {
        let a = extract_findings(SAMPLE, "claude");
        let b = extract_findings(SAMPLE, "codex");
        let all: Vec<ReviewFinding> = a.into_iter().chain(b).collect();
        assert_eq!(all[0].fingerprint, all[1].fingerprint);
        let grouped = deduplicate(all);
        assert_eq!(grouped.len(), 1);
        assert_eq!(grouped[0].1.len(), 2);
    }

    #[test]
    fn different_findings_stay_separate() {
        let other = SAMPLE.replace("Unchecked empty cart", "Missing auth check");
        let grouped = deduplicate(
            extract_findings(SAMPLE, "a")
                .into_iter()
                .chain(extract_findings(&other, "b"))
                .collect(),
        );
        assert_eq!(grouped.len(), 2);
    }

    #[test]
    fn actionable_only_p0_p1() {
        let p2 = ReviewFinding {
            severity: "P2".into(),
            category: String::new(),
            title: "t".into(),
            explanation: String::new(),
            file: None,
            line_start: None,
            line_end: None,
            confidence: None,
            source: "s".into(),
            suggested_fix: None,
            fingerprint: "x".into(),
        };
        assert!(!p2.actionable());
    }

    #[test]
    fn block_without_title_skipped() {
        let findings = extract_findings("```finding\nseverity: P0\n```", "s");
        // No valid title means no structured finding; the raw output remains in Runs.
        assert!(findings.is_empty());
    }
}
