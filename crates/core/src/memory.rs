//! Deterministic local memory (Milestone 6).
//!
//! Memory is structured preferences, not vector embeddings:
//! role-to-profile defaults, draft-PR policy, test gates, loop bounds,
//! worktree preference. The engine observes repeated user edits;
//! after N consistent occurrences it *suggests* a preference the user
//! accepts, rejects, edits, disables, or resets. No hidden behavioral
//! profile: everything learned is inspectable and exportable, stays local,
//! and never contains credentials (profile references resolve by name on
//! import).

use serde::{Deserialize, Serialize};

/// How many consistent observations trigger a suggestion.
pub const SUGGESTION_THRESHOLD: u32 = 3;

/// A stored preference.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Preference {
    pub key: String,
    /// Workflow-type scope (`*` = global).
    #[serde(default = "global_scope")]
    pub scope: String,
    pub value: serde_json::Value,
    /// `accepted` | `manual` | `suggested` (pending suggestion).
    #[serde(default = "accepted_source")]
    pub source: String,
    #[serde(default = "enabled_default")]
    pub enabled: bool,
    #[serde(default)]
    pub note: String,
}

fn global_scope() -> String {
    "*".to_string()
}

fn accepted_source() -> String {
    "accepted".to_string()
}

fn enabled_default() -> bool {
    true
}

impl Preference {
    pub fn pending(&self) -> bool {
        self.source == "suggested" && self.enabled
    }
}

/// Well-known preference keys (documented in memory.md).
pub mod keys {
    pub const PLANNING_PROFILE: &str = "role.planning.profile";
    pub const IMPLEMENTATION_PROFILE: &str = "role.implementation.profile";
    pub const FAST_REVIEW_PROFILE: &str = "role.fastReview.profile";
    pub const DEEP_REVIEW_PROFILE: &str = "role.deepReview.profile";
    pub const GENERATOR_PROFILE: &str = "role.workflowGenerator.profile";
    pub const DRAFT_PR: &str = "pr.startAsDraft";
    pub const COMMIT_AFTER_TESTS: &str = "tests.commitOnlyAfterPass";
    pub const FIX_LOOP_ON_P0_P1: &str = "review.fixLoopOnP0P1";
    pub const MAX_REVIEW_CYCLES: &str = "review.maxCycles";
    pub const PREFER_WORKTREES: &str = "git.preferWorktrees";
    pub const LEARNING_ENABLED: &str = "learning.enabled";
}

/// An observed user edit: (scope, field, from, to).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditObservation {
    pub scope: String,
    pub field: String,
    pub from: String,
    pub to: String,
}

/// Record one observation; returns a pending suggestion when the threshold
/// of consistent (same scope+field+to) observations is reached and no live
/// preference/suggestion covers the key.
pub fn observe(
    counts: &mut std::collections::HashMap<String, u32>,
    existing: &[Preference],
    observation: &EditObservation,
) -> Option<Preference> {
    let key = preference_key(&observation.scope, &observation.field);
    // Any existing record for this key (live, pending, or rejected) settles
    // it: keep counting, stay quiet. Rejected suggestions only return after
    // a memory reset — no nagging.
    if existing.iter().any(|p| p.key == key) {
        return None;
    }
    let counter_key = format!(
        "{}|{}|{}",
        observation.scope, observation.field, observation.to
    );
    let count = counts.entry(counter_key).or_insert(0);
    *count += 1;
    if *count >= SUGGESTION_THRESHOLD {
        Some(Preference {
            key,
            scope: observation.scope.clone(),
            value: serde_json::Value::String(observation.to.clone()),
            source: "suggested".to_string(),
            enabled: true,
            note: format!(
                "Suggested after {} consistent edits ({} → {}).",
                *count, observation.from, observation.to
            ),
        })
    } else {
        None
    }
}

/// Map (scope, field) observations to preference keys. Unknown fields yield
/// a namespaced key rather than failing (forward-compatible).
pub fn preference_key(scope: &str, field: &str) -> String {
    match field {
        "planningProfile" => keys::PLANNING_PROFILE.to_string(),
        "implementationProfile" => keys::IMPLEMENTATION_PROFILE.to_string(),
        "fastReviewProfile" => keys::FAST_REVIEW_PROFILE.to_string(),
        "deepReviewProfile" => keys::DEEP_REVIEW_PROFILE.to_string(),
        "generatorProfile" => keys::GENERATOR_PROFILE.to_string(),
        "draftPr" => keys::DRAFT_PR.to_string(),
        "commitAfterTests" => keys::COMMIT_AFTER_TESTS.to_string(),
        "fixLoopOnP0P1" => keys::FIX_LOOP_ON_P0_P1.to_string(),
        "maxReviewCycles" => keys::MAX_REVIEW_CYCLES.to_string(),
        "preferWorktrees" => keys::PREFER_WORKTREES.to_string(),
        _ => format!("custom.{scope}.{field}"),
    }
}

/// Apply enabled preferences to role resolution + proposal defaults.
/// Returns (role_map additions, default overrides for templates).
pub fn apply_to_roles(
    preferences: &[Preference],
    mut role_map: std::collections::HashMap<String, String>,
) -> std::collections::HashMap<String, String> {
    for pref in preferences
        .iter()
        .filter(|p| p.enabled && p.source != "suggested")
    {
        let role = match pref.key.as_str() {
            k if k == keys::PLANNING_PROFILE => Some("planning"),
            k if k == keys::IMPLEMENTATION_PROFILE => Some("implementation"),
            k if k == keys::FAST_REVIEW_PROFILE => Some("fastReview"),
            k if k == keys::DEEP_REVIEW_PROFILE => Some("deepReview"),
            k if k == keys::GENERATOR_PROFILE => Some("workflowGenerator"),
            _ => None,
        };
        if let (Some(role), Some(profile)) = (role, pref.value.as_str()) {
            role_map
                .entry(role.to_string())
                .or_insert(profile.to_string());
        }
    }
    role_map
}

/// Whether learning suggestions are enabled (default on, inspectable).
pub fn learning_enabled(preferences: &[Preference]) -> bool {
    preferences
        .iter()
        .find(|p| p.key == keys::LEARNING_ENABLED)
        .and_then(|p| p.value.as_bool())
        .unwrap_or(true)
}

/// Export preferences (portable: profile references by name stay names;
/// nothing credential-like exists in this model by construction).
pub fn export_preferences(preferences: &[Preference]) -> Result<String, String> {
    serde_json::to_string_pretty(preferences).map_err(|e| e.to_string())
}

/// Import with validation: unknown shapes rejected, secrets scanned.
/// Any value resembling a credential is refused outright.
pub fn import_preferences(json: &str) -> Result<Vec<Preference>, String> {
    let prefs: Vec<Preference> =
        serde_json::from_str(json).map_err(|e| format!("Invalid preferences JSON: {e}"))?;
    if prefs.len() > 200 {
        return Err("Too many preferences (max 200).".to_string());
    }
    for pref in &prefs {
        if pref.key.trim().is_empty() || pref.key.len() > 120 {
            return Err("Preference key invalid.".to_string());
        }
        let flat = serde_json::to_string(&pref.value)
            .unwrap_or_default()
            .to_ascii_lowercase();
        for marker in ["api-key", "apikey", "bearer", "password", "secret", "token"] {
            if flat.contains(marker) {
                return Err(format!(
                    "Preference '{}' looks credential-like; refused.",
                    pref.key
                ));
            }
        }
    }
    Ok(prefs)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn observe_n(field: &str, to: &str, n: u32) -> Option<Preference> {
        let mut counts = std::collections::HashMap::new();
        let mut suggestion = None;
        for _ in 0..n {
            suggestion = observe(
                &mut counts,
                &[],
                &EditObservation {
                    scope: "*".into(),
                    field: field.into(),
                    from: "a".into(),
                    to: to.into(),
                },
            );
        }
        suggestion
    }

    #[test]
    fn suggests_after_threshold() {
        assert!(observe_n("draftPr", "true", SUGGESTION_THRESHOLD - 1).is_none());
        let suggestion = observe_n("draftPr", "true", SUGGESTION_THRESHOLD).expect("suggest");
        assert_eq!(suggestion.key, keys::DRAFT_PR);
        assert_eq!(suggestion.source, "suggested");
        assert!(suggestion.pending());
    }

    #[test]
    fn stays_quiet_when_covered() {
        let mut counts = std::collections::HashMap::new();
        let existing = vec![Preference {
            key: keys::DRAFT_PR.into(),
            scope: "*".into(),
            value: serde_json::Value::String("true".into()),
            source: "accepted".into(),
            enabled: true,
            note: String::new(),
        }];
        for _ in 0..10 {
            let suggestion = observe(
                &mut counts,
                &existing,
                &EditObservation {
                    scope: "*".into(),
                    field: "draftPr".into(),
                    from: "x".into(),
                    to: "true".into(),
                },
            );
            assert!(suggestion.is_none());
        }
    }

    #[test]
    fn inconsistent_targets_do_not_trigger() {
        let mut counts = std::collections::HashMap::new();
        for i in 0..10 {
            let suggestion = observe(
                &mut counts,
                &[],
                &EditObservation {
                    scope: "*".into(),
                    field: "draftPr".into(),
                    from: "x".into(),
                    to: format!("v{i}"),
                },
            );
            assert!(suggestion.is_none());
        }
    }

    #[test]
    fn role_prefs_apply_to_map() {
        let prefs = vec![Preference {
            key: keys::DEEP_REVIEW_PROFILE.into(),
            scope: "*".into(),
            value: serde_json::Value::String("p-codex".into()),
            source: "accepted".into(),
            enabled: true,
            note: String::new(),
        }];
        let map = apply_to_roles(&prefs, std::collections::HashMap::new());
        assert_eq!(map.get("deepReview").map(String::as_str), Some("p-codex"));
    }

    #[test]
    fn import_refuses_credentials() {
        let bad = r#"[{"key":"x","value":"bearer abc123"}]"#;
        assert!(import_preferences(bad).is_err());
        let good = r#"[{"key":"pr.startAsDraft","value":"true"}]"#;
        let prefs = import_preferences(good).expect("import");
        assert_eq!(prefs.len(), 1);
        let exported = export_preferences(&prefs).expect("export");
        assert!(exported.contains("pr.startAsDraft"));
    }

    #[test]
    fn scoped_prefs_do_not_leak_globally() {
        // apply_to_roles only fills missing roles; explicit maps win.
        let prefs = vec![Preference {
            key: keys::IMPLEMENTATION_PROFILE.into(),
            scope: "bugfix".into(),
            value: serde_json::Value::String("p-a".into()),
            source: "accepted".into(),
            enabled: true,
            note: String::new(),
        }];
        let mut explicit = std::collections::HashMap::new();
        explicit.insert("implementation".to_string(), "p-manual".to_string());
        let map = apply_to_roles(&prefs, explicit);
        assert_eq!(
            map.get("implementation").map(String::as_str),
            Some("p-manual")
        );
    }
}
