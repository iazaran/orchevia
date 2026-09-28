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
use std::collections::HashMap;

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
    let norm = |s: &str| {
        s.split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
            .to_ascii_lowercase()
    };
    // Truncate explanation to its head: long prose shouldn't fork identity.
    let head: String = explanation.chars().take(160).collect();
    let key = format!(
        "{}|{}|{}|{}|{}",
        norm(severity),
        norm(file.unwrap_or("")),
        line_start.unwrap_or(-1),
        norm(title),
        norm(&head)
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
    });
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

/// Collect + deduplicate findings from agent node outputs in a run.
/// `outputs` maps node id -> (profile label, stdout).
pub fn collect_run_findings(
    outputs: &[(String, String, String)],
) -> Vec<(ReviewFinding, Vec<String>)> {
    let mut all = Vec::new();
    for (node_id, profile, stdout) in outputs {
        let source = if profile.trim().is_empty() {
            node_id.clone()
        } else {
            format!("{node_id} ({profile})")
        };
        all.extend(extract_findings(stdout, &source));
    }
    deduplicate(all)
}

/// Serializable grouped finding for API/UI layers.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupedFinding {
    pub finding: ReviewFinding,
    pub sources: Vec<String>,
}

/// Collect + deduplicate into serializable groups.
pub fn grouped_findings(outputs: &[(String, String, String)]) -> Vec<GroupedFinding> {
    collect_run_findings(outputs)
        .into_iter()
        .map(|(finding, sources)| GroupedFinding { finding, sources })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

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
        let run_findings = collect_run_findings(&[(
            "answer".into(),
            "Codex".into(),
            "## Answer\nHere is the explanation.".into(),
        )]);
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
