//! Feedback a person sends about a step while its run is going: the stored
//! item, who handles it, the check prompt and its decision block, and which
//! steps a correction reruns. Routing (holding checkpoints, resetting steps,
//! replay) lives in the engine; storage in the database.
//!
//! Feedback is never part of the workflow definition and never reaches a CLI
//! that is already running: it waits for the run's next checkpoint (a
//! publishing step, an Approval step or the end).

use crate::run_controls::{dependency_pairs, downstream_closure};
use crate::workflow::{find_loop_edges, NodeKind, Workflow};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

/// Longest feedback text, in characters.
pub const MAX_FEEDBACK_CHARS: usize = 4000;
/// Most feedback items one run accepts.
pub const MAX_FEEDBACK_PER_RUN: i64 = 50;
/// Pseudo step of the row that starts a correction round.
pub const ROUND_NODE: &str = "__feedback";
/// Pseudo step of the rows that pause and continue a run for feedback.
pub const GUARD_NODE: &str = "__feedback_guard";
/// Correction rounds a run makes unless its workflow says otherwise.
pub const DEFAULT_CORRECTION_ROUNDS: u32 = 2;
pub const MAX_CORRECTION_ROUNDS: u32 = 5;

/// Waiting for the run's next checkpoint.
pub const PENDING: &str = "pending";
/// An agent is checking it now.
pub const CHECKING: &str = "checking";
/// The check found the work already does what it asks.
pub const SATISFIED: &str = "satisfied";
/// A correction and the steps after it are running.
pub const CORRECTING: &str = "correcting";
/// The correction finished and the steps after it ran again.
pub const ADDRESSED: &str = "addressed";
/// Could not be handled; the run paused before publishing.
pub const NEEDS_ATTENTION: &str = "needs-attention";
/// Arrived after publishing started; recorded, not processed.
pub const LATE: &str = "late";
/// The run ended (failed, cancelled, restarted) before it was handled.
pub const NOT_PROCESSED: &str = "not-processed";

/// Statuses that keep a run from publishing or finishing.
pub const OPEN: [&str; 3] = [PENDING, CHECKING, CORRECTING];

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunFeedback {
    pub id: i64,
    pub run_id: String,
    /// The step it was written on.
    pub node_id: String,
    /// The result row (visit) it was written on, when the person picked one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result_id: Option<i64>,
    pub text: String,
    pub status: String,
    /// What happened, in words for the person: the check's explanation, the
    /// requested change, or why it could not be handled.
    #[serde(default)]
    pub decision: String,
    /// The AI step that checked and, if needed, corrected it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_node_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub check_result_id: Option<i64>,
    #[serde(default)]
    pub correction_result_ids: Vec<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub round: Option<u32>,
    /// The item in a failed run this one was carried over from by recovery.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub carried_from: Option<i64>,
    /// A `needs-attention` item the person has seen at a feedback pause.
    #[serde(default)]
    pub acknowledged: bool,
    pub created_at: String,
    pub updated_at: String,
}

/// Per-run feedback bookkeeping, kept in `RunExecution`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedbackState {
    /// The first publishing step's dispatch: the feedback cutoff.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub publication_started: Option<PublicationStart>,
    /// Correction rounds made so far.
    #[serde(default, skip_serializing_if = "is_zero")]
    pub rounds: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pause: Option<FeedbackPause>,
    /// The run claimed its finish with no open feedback; later feedback is
    /// refused because nothing would handle it.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub closed: bool,
}

fn is_zero(n: &u32) -> bool {
    *n == 0
}

impl FeedbackState {
    pub fn is_empty(&self) -> bool {
        *self == Self::default()
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicationStart {
    pub node_id: String,
    pub label: String,
    pub at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedbackPause {
    /// The guard row that paused the run; continuing must name it.
    pub id: i64,
    pub reason: String,
}

/// Trimmed feedback text, or why it cannot be accepted.
pub fn validate_text(text: &str) -> Result<String, String> {
    let text = text.trim();
    if text.is_empty() {
        return Err("Write the feedback first.".into());
    }
    if text.chars().count() > MAX_FEEDBACK_CHARS {
        return Err(format!(
            "Feedback can be at most {MAX_FEEDBACK_CHARS} characters."
        ));
    }
    if text.contains('\0') {
        return Err("Feedback cannot contain a NUL character.".into());
    }
    Ok(text.to_string())
}

/// The AI step that handles feedback on `node_id`: the step itself when it
/// is an AI step, otherwise the nearest AI step whose work it uses. Edges
/// and data references count first; loop-back edges (the fix step of a
/// loop) only when nothing else reaches an AI step. Ties go to the step
/// defined later, which is closer to the step the feedback is about.
pub fn feedback_target(workflow: &Workflow, node_id: &str) -> Option<String> {
    let kind_of = |id: &str| workflow.nodes.iter().find(|n| n.id == id).map(|n| n.kind);
    if kind_of(node_id) == Some(NodeKind::Agent) {
        return Some(node_id.to_string());
    }
    let order = |id: &str| workflow.nodes.iter().position(|n| n.id == id);
    let loops = find_loop_edges(workflow);
    let ordinary: Vec<(String, String)> = workflow
        .edges
        .iter()
        .filter(|e| !loops.contains(&e.id))
        .map(|e| (e.source.clone(), e.target.clone()))
        .chain(dependency_pairs(workflow).into_iter().filter(|(s, t)| {
            !workflow
                .edges
                .iter()
                .any(|e| e.source == *s && e.target == *t)
        }))
        .collect();
    let looping: Vec<(String, String)> = workflow
        .edges
        .iter()
        .filter(|e| loops.contains(&e.id))
        .map(|e| (e.source.clone(), e.target.clone()))
        .collect();
    for pairs in [ordinary.clone(), [ordinary, looping].concat()] {
        let mut seen: HashSet<String> = HashSet::from([node_id.to_string()]);
        let mut frontier = vec![node_id.to_string()];
        while !frontier.is_empty() {
            let mut next: Vec<String> = Vec::new();
            for id in &frontier {
                for (source, target) in &pairs {
                    if target == id && seen.insert(source.clone()) {
                        next.push(source.clone());
                    }
                }
            }
            if let Some(agent) = next
                .iter()
                .filter(|id| kind_of(id) == Some(NodeKind::Agent))
                .max_by_key(|id| order(id))
            {
                return Some(agent.clone());
            }
            frontier = next;
        }
    }
    None
}

/// The decision a check reports in its `orchevia-feedback` block.
#[derive(Debug, Clone, PartialEq)]
pub enum Decision {
    Satisfied { explanation: String },
    Change { explanation: String, change: String },
    Unclear { reason: String },
}

impl Decision {
    pub fn kind(&self) -> &'static str {
        match self {
            Decision::Satisfied { .. } => "satisfied",
            Decision::Change { .. } => "change",
            Decision::Unclear { .. } => "unclear",
        }
    }
}

/// Read the last ```orchevia-feedback block (or a last line holding the same
/// JSON object). Anything else is unclear, never satisfied.
pub fn parse_decision(text: &str) -> Decision {
    let fenced = text
        .rsplit("```orchevia-feedback")
        .next()
        .filter(|_| text.contains("```orchevia-feedback"))
        .and_then(|rest| rest.split("```").next())
        .map(str::trim);
    let candidate = fenced.or_else(|| {
        text.lines()
            .rev()
            .map(str::trim)
            .find(|line| line.starts_with('{') && line.contains("\"decision\""))
    });
    let Some(value) =
        candidate.and_then(|json| serde_json::from_str::<serde_json::Value>(json).ok())
    else {
        return Decision::Unclear {
            reason: "The check did not end with the decision block.".into(),
        };
    };
    let field = |key: &str| {
        value[key]
            .as_str()
            .map(|s| s.trim().chars().take(1000).collect::<String>())
            .unwrap_or_default()
    };
    match value["decision"].as_str().map(str::trim) {
        Some("satisfied") => Decision::Satisfied {
            explanation: field("explanation"),
        },
        Some("change") if !field("change").is_empty() || !field("explanation").is_empty() => {
            Decision::Change {
                explanation: field("explanation"),
                change: field("change"),
            }
        }
        _ => Decision::Unclear {
            reason: "The check's decision was neither \"satisfied\" nor \"change\".".into(),
        },
    }
}

fn clip(text: &str, max: usize) -> String {
    let count = text.chars().count();
    if count <= max {
        return text.to_string();
    }
    let kept: String = text.chars().take(max).collect();
    format!("{kept}\n… [{} more characters not shown]", count - max)
}

fn quoted(items: &[RunFeedback]) -> String {
    items
        .iter()
        .enumerate()
        .map(|(index, item)| {
            let body = item.text.replace("\n", "\n   ");
            format!("{}. (feedback #{}) {body}", index + 1, item.id)
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// What a check is told: the step's instructions and latest result, the
/// feedback quoted as the person's words, and to change nothing.
pub struct CheckPrompt<'a> {
    pub step_label: &'a str,
    pub instructions: &'a str,
    pub latest_result: &'a str,
    /// When the feedback was written on a later step that uses this work.
    pub written_on: Option<(&'a str, &'a str)>,
    pub items: &'a [RunFeedback],
}

pub fn check_prompt(prompt: &CheckPrompt<'_>) -> String {
    let mut out = format!(
        "A person sent feedback about a workflow step while the workflow was running. \
Check whether the work already does what the feedback asks. This is a check only: \
do not edit, create or delete files, and do not run commands that change anything.\n\n\
## The step: {}\nIts instructions were:\n\n{}\n\n## Its latest result\n\n{}\n",
        prompt.step_label,
        clip(prompt.instructions, 6000),
        clip(prompt.latest_result, 6000),
    );
    if let Some((label, result)) = prompt.written_on {
        out.push_str(&format!(
            "\nThe feedback was written on the later step \"{label}\", which uses this step's work. Its latest result:\n\n{}\n",
            clip(result, 3000)
        ));
    }
    out.push_str(&format!(
        "\n## The feedback (the person's own words)\n\n{}\n\n\
Look at the files and the result as they are now. Explain briefly, then end your reply with \
exactly one block:\n\n```orchevia-feedback\n\
{{\"decision\": \"satisfied\" or \"change\", \"explanation\": \"one or two sentences for the person\", \
\"change\": \"what must change (only when the decision is change)\"}}\n```\n",
        quoted(prompt.items)
    ));
    out
}

/// Appended to a step's own prompt when it runs again as a correction.
pub fn correction_section(items: &[RunFeedback], previous_result: &str) -> String {
    let changes: Vec<String> = items
        .iter()
        .filter(|item| !item.decision.trim().is_empty())
        .map(|item| format!("- {}", item.decision.trim()))
        .collect();
    let mut out = format!(
        "\n\n## Feedback to apply\n\nWhile this workflow was running, the person sent feedback \
about this step's work. Apply it now: change what the feedback needs, keep everything else, and \
give your complete result in the form the instructions above ask for.\n\n\
Feedback (the person's own words):\n{}\n",
        quoted(items)
    );
    if !changes.is_empty() {
        out.push_str(&format!(
            "\nWhat the check said must change:\n{}\n",
            changes.join("\n")
        ));
    }
    out.push_str(&format!(
        "\nYour earlier result:\n\n{}\n",
        clip(previous_result, 6000)
    ));
    out
}

/// Which corrected steps run first (`roots`) and which steps a correction
/// reruns (`affected`): every step using the targets' work, directly or
/// through others. A target that uses another target's work reruns as part
/// of that correction, still with its own feedback.
pub fn correction_plan(workflow: &Workflow, targets: &[String]) -> (Vec<String>, Vec<String>) {
    let order = |id: &str| workflow.nodes.iter().position(|n| n.id == id);
    let mut roots: Vec<String> = targets
        .iter()
        .filter(|target| {
            let others: HashSet<String> = targets.iter().filter(|t| t != target).cloned().collect();
            !downstream_closure(workflow, &others).contains(*target)
        })
        .cloned()
        .collect();
    if roots.is_empty() {
        // Every target uses another's work (they share a loop): start with
        // the earliest defined.
        if let Some(first) = targets.iter().min_by_key(|t| order(t)) {
            roots.push(first.clone());
        }
    }
    let seeds: HashSet<String> = targets.iter().cloned().collect();
    let mut affected: Vec<String> = downstream_closure(workflow, &seeds)
        .into_iter()
        .chain(targets.iter().cloned())
        .filter(|id| !roots.contains(id))
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    affected.sort_by_key(|id| order(id));
    roots.sort_by_key(|id| order(id));
    (roots, affected)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workflow::{Edge, Node, NodeConfig, Position};

    fn node(id: &str, kind: NodeKind) -> Node {
        Node {
            id: id.into(),
            kind,
            label: None,
            position: Position::default(),
            config: NodeConfig::default(),
        }
    }

    fn edge(id: &str, source: &str, target: &str, label: Option<&str>) -> Edge {
        Edge {
            id: id.into(),
            source: source.into(),
            target: target.into(),
            label: label.map(str::to_string),
        }
    }

    /// start → impl → tests → review → gate -(true)→ push → end
    ///                  ↑                   └(false)→ fix ┘ (loop back to tests)
    /// plus a parallel lint branch from start.
    fn coding() -> Workflow {
        let mut push = node("push", NodeKind::Command);
        push.config.publishes = Some(true);
        let mut summary = node("summary", NodeKind::Command);
        summary.config.args = vec!["{{node.impl.output}}".into()];
        Workflow {
            schema_version: crate::workflow::CURRENT_SCHEMA_VERSION,
            id: "wf".into(),
            name: "W".into(),
            inputs: vec![],
            defaults: None,
            limits: None,
            nodes: vec![
                node("start", NodeKind::Start),
                node("impl", NodeKind::Agent),
                node("tests", NodeKind::Command),
                node("review", NodeKind::Agent),
                node("gate", NodeKind::Condition),
                node("fix", NodeKind::Agent),
                node("lint", NodeKind::Command),
                summary,
                push,
                node("end", NodeKind::End),
            ],
            edges: vec![
                edge("e1", "start", "impl", None),
                edge("e2", "impl", "tests", None),
                edge("e3", "tests", "review", None),
                edge("e4", "review", "gate", None),
                edge("e5", "gate", "push", Some("true")),
                edge("e6", "gate", "fix", Some("false")),
                edge("e7", "fix", "tests", None),
                edge("e8", "start", "lint", None),
                edge("e9", "lint", "push", None),
                edge("e10", "push", "end", None),
                edge("e11", "lint", "summary", None),
                edge("e12", "summary", "end", None),
            ],
        }
    }

    fn item(id: i64, text: &str, decision: &str) -> RunFeedback {
        RunFeedback {
            id,
            run_id: "r".into(),
            node_id: "impl".into(),
            result_id: None,
            text: text.into(),
            status: PENDING.into(),
            decision: decision.into(),
            target_node_id: None,
            check_result_id: None,
            correction_result_ids: vec![],
            round: None,
            carried_from: None,
            acknowledged: false,
            created_at: String::new(),
            updated_at: String::new(),
        }
    }

    #[test]
    fn an_ai_step_handles_its_own_feedback_and_others_go_to_the_nearest_one() {
        let wf = coding();
        assert_eq!(feedback_target(&wf, "impl").as_deref(), Some("impl"));
        // Tests use the implementation (ordinary edge) before the fix loop.
        assert_eq!(feedback_target(&wf, "tests").as_deref(), Some("impl"));
        // Past the review and the condition, the review is nearest.
        assert_eq!(feedback_target(&wf, "push").as_deref(), Some("review"));
        // A data reference counts like an edge.
        assert_eq!(feedback_target(&wf, "summary").as_deref(), Some("impl"));
        // Lint only follows Start: nothing can correct it.
        assert_eq!(feedback_target(&wf, "lint"), None);
        assert_eq!(feedback_target(&wf, "missing"), None);
    }

    #[test]
    fn decisions_need_the_block_and_unclear_is_never_satisfied() {
        let done = "Looks fine.\n```orchevia-feedback\n{\"decision\":\"satisfied\",\"explanation\":\"Old keys still load.\"}\n```";
        assert_eq!(
            parse_decision(done),
            Decision::Satisfied {
                explanation: "Old keys still load.".into()
            }
        );
        let change = "{\"decision\": \"change\", \"explanation\": \"x\", \"change\": \"Read old keys too.\"}";
        assert_eq!(
            parse_decision(change),
            Decision::Change {
                explanation: "x".into(),
                change: "Read old keys too.".into()
            }
        );
        // The last block wins over an earlier quoted one.
        let quoted = format!("{done}\nActually:\n```orchevia-feedback\n{change}\n```");
        assert_eq!(parse_decision(&quoted).kind(), "change");
        for unclear in [
            "It is satisfied.",
            "```orchevia-feedback\nnot json\n```",
            "{\"decision\":\"maybe\"}",
            "{\"decision\":\"change\"}",
        ] {
            assert_eq!(parse_decision(unclear).kind(), "unclear", "{unclear}");
        }
    }

    #[test]
    fn the_check_quotes_the_feedback_and_forbids_changes() {
        let items = [item(4, "Keep compatibility\nwith the old config.", "")];
        let prompt = check_prompt(&CheckPrompt {
            step_label: "Implement",
            instructions: "Fix the bug.",
            latest_result: &"x".repeat(7000),
            written_on: Some(("Run tests", "ok")),
            items: &items,
        });
        assert!(prompt.contains("do not edit"));
        assert!(prompt.contains("1. (feedback #4) Keep compatibility\n   with the old config."));
        assert!(prompt.contains("1000 more characters not shown"));
        assert!(prompt.contains("\"Run tests\""));
        assert!(prompt.ends_with("```\n"));
        let section = correction_section(
            &[item(
                4,
                "Keep old keys.",
                "Read the old keys as a fallback.",
            )],
            "Done.",
        );
        assert!(section.contains("- Read the old keys as a fallback."));
        assert!(section.contains("Your earlier result:\n\nDone."));
    }

    #[test]
    fn a_correction_reruns_what_uses_the_work_and_leaves_parallel_work() {
        let wf = coding();
        let (roots, affected) = correction_plan(&wf, &["impl".into()]);
        assert_eq!(roots, ["impl"]);
        assert_eq!(
            affected,
            ["tests", "review", "gate", "fix", "summary", "push", "end"]
        );
        assert!(
            !affected.contains(&"lint".to_string()),
            "parallel lint stays"
        );
        // A target downstream of another reruns inside its correction.
        let (roots, affected) = correction_plan(&wf, &["review".into(), "impl".into()]);
        assert_eq!(roots, ["impl"]);
        assert!(affected.contains(&"review".to_string()));
        // Targets sharing a loop: the earliest starts.
        let (roots, _) = correction_plan(&wf, &["fix".into(), "review".into()]);
        assert_eq!(roots, ["review"]);
    }

    #[test]
    fn feedback_text_is_trimmed_and_bounded() {
        assert_eq!(validate_text("  keep it  ").unwrap(), "keep it");
        assert!(validate_text("   ").is_err());
        assert!(validate_text(&"x".repeat(MAX_FEEDBACK_CHARS + 1)).is_err());
        assert!(validate_text(&"é".repeat(MAX_FEEDBACK_CHARS)).is_ok());
        assert!(validate_text("a\0b").is_err());
    }
}

#[cfg(test)]
mod parity_tests {
    use super::*;

    #[test]
    fn rules_match_the_shared_fixture() {
        let fixture: serde_json::Value =
            serde_json::from_str(include_str!("../../../src/test/feedback-parity.json"))
                .expect("fixture");
        let workflow: Workflow =
            serde_json::from_value(fixture["workflow"].clone()).expect("workflow");
        for case in fixture["targets"].as_array().expect("targets") {
            let node = case["node"].as_str().unwrap_or("");
            assert_eq!(
                feedback_target(&workflow, node).as_deref(),
                case["target"].as_str(),
                "{node}"
            );
        }
        for case in fixture["plans"].as_array().expect("plans") {
            let list = |key: &str| -> Vec<String> {
                case[key]
                    .as_array()
                    .expect("list")
                    .iter()
                    .map(|v| v.as_str().unwrap_or("").to_string())
                    .collect()
            };
            let (roots, affected) = correction_plan(&workflow, &list("targets"));
            assert_eq!(roots, list("roots"), "{case}");
            assert_eq!(affected, list("affected"), "{case}");
        }
        for case in fixture["decisions"].as_array().expect("decisions") {
            let decision = parse_decision(case["text"].as_str().unwrap_or(""));
            assert_eq!(decision.kind(), case["kind"], "{case}");
            match decision {
                Decision::Satisfied { explanation } => {
                    assert_eq!(explanation, case["explanation"]);
                }
                Decision::Change {
                    explanation,
                    change,
                } => {
                    assert_eq!(explanation, case["explanation"]);
                    assert_eq!(change, case["change"]);
                }
                Decision::Unclear { .. } => {}
            }
        }
    }
}
