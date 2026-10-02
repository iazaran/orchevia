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

pub const PROJECT_FIELDS: &[&str] = &[
    "testCommand",
    "lintCommand",
    "buildCommand",
    "conventions",
    "fastReviewProfile",
    "deepReviewProfile",
    "templateId",
];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectMemoryContext {
    pub scope: String,
    pub preferences: Vec<Preference>,
    pub text: String,
}

pub fn project_scope(repo_dir: &str) -> Result<String, String> {
    let path = std::fs::canonicalize(repo_dir.trim())
        .map_err(|e| format!("Cannot resolve repository directory: {e}"))?;
    if !path.is_dir() {
        return Err("Repository directory must be a directory.".into());
    }
    let scope = format!("repo:{}", path.to_string_lossy());
    validate_project_scope(&scope)?;
    Ok(scope)
}
fn validate_project_scope(scope: &str) -> Result<(), String> {
    let path = scope
        .strip_prefix("repo:")
        .ok_or("Invalid project scope.")?;
    // Imported Windows playbooks can be inspected on Unix and vice versa.
    let absolute = path.starts_with('/')
        || (path.as_bytes().get(1) == Some(&b':')
            && (path.as_bytes().get(2) == Some(&b'\\') || path.as_bytes().get(2) == Some(&b'/')));
    if !absolute || scope.chars().count() > 600 || scope.chars().any(char::is_control) {
        return Err("Invalid project scope (absolute path required, max 600 characters).".into());
    }
    Ok(())
}
pub fn project_key(scope: &str, field: &str) -> Result<String, String> {
    validate_project_scope(scope)?;
    if !PROJECT_FIELDS.contains(&field) {
        return Err(format!("Unknown project field '{field}'."));
    }
    let hash = scope.as_bytes().iter().fold(0xcbf29ce484222325u64, |h, b| {
        (h ^ u64::from(*b)).wrapping_mul(0x100000001b3)
    });
    Ok(format!("project.{hash:016x}.{field}"))
}
pub fn validate_preference(pref: &Preference) -> Result<(), String> {
    if pref.key.trim().is_empty()
        || pref.key.chars().count() > 120
        || pref.key.chars().any(char::is_control)
    {
        return Err("Preference key invalid (max 120 characters).".into());
    }
    if pref.scope.trim().is_empty()
        || pref.scope.chars().count() > 600
        || pref.scope.chars().any(char::is_control)
    {
        return Err("Preference scope invalid (max 600 characters).".into());
    }
    if !["accepted", "manual", "suggested", "rejected"].contains(&pref.source.as_str()) {
        return Err("Unknown preference source.".into());
    }
    if pref.value.is_array() || pref.value.is_object() {
        return Err("Preference value must be a scalar.".into());
    }
    if pref
        .value
        .as_str()
        .is_some_and(|v| v.chars().count() > 4000)
        || pref.note.chars().count() > 4000
    {
        return Err("Preference value and note must each be at most 4000 characters.".into());
    }
    if pref.scope.starts_with("repo:") || pref.key.starts_with("project.") {
        let field = pref
            .key
            .rsplit('.')
            .next()
            .ok_or("Missing project field.")?;
        if pref.key != project_key(&pref.scope, field)? {
            return Err("Project key does not match its repository scope.".into());
        }
        if !pref.value.is_string() {
            return Err("Project fields must be strings.".into());
        }
    }
    let flat = format!("{} {}", pref.value, pref.note).to_ascii_lowercase();
    for marker in ["api-key", "apikey", "bearer", "password", "secret", "token"] {
        if flat.contains(marker) {
            return Err(format!(
                "Preference '{}' looks credential-like; refused.",
                pref.key
            ));
        }
    }
    Ok(())
}
pub fn project_context(preferences: &[Preference], scope: Option<&str>) -> ProjectMemoryContext {
    let mut included: Vec<Preference> = preferences
        .iter()
        .filter(|p| {
            p.enabled
                && ["manual", "accepted"].contains(&p.source.as_str())
                && (p.scope == "*" || Some(p.scope.as_str()) == scope)
                && validate_preference(p).is_ok()
        })
        .cloned()
        .collect();
    included.sort_by(|a, b| a.key.cmp(&b.key));
    let text = included
        .iter()
        .map(|p| {
            format!(
                "{} = {} (evidence: {})",
                if p.key.starts_with("project.") {
                    p.key.rsplit('.').next().unwrap_or(&p.key)
                } else {
                    &p.key
                },
                p.value,
                p.note
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    ProjectMemoryContext {
        scope: scope.unwrap_or("*").into(),
        preferences: included,
        text: text.chars().take(16000).collect(),
    }
}
pub fn validate_observation(observation: &EditObservation) -> Result<(), String> {
    if observation.from == observation.to {
        return Err("Observation must describe a changed value.".into());
    }
    if observation.from.chars().count() > 4000 {
        return Err("Previous observed value is too long.".into());
    }
    let key = preference_key(&observation.scope, &observation.field);
    let pref = Preference {
        key,
        scope: observation.scope.clone(),
        value: serde_json::json!(observation.to),
        source: "suggested".into(),
        enabled: true,
        note: observation.from.clone(),
    };
    validate_preference(&pref)
}
pub fn observation_counter_key(observation: &EditObservation) -> String {
    // Length-prefixed components avoid delimiter collisions in command strings.
    format!(
        "{}:{}{}:{}{}:{}",
        observation.scope.len(),
        observation.scope,
        observation.field.len(),
        observation.field,
        observation.to.len(),
        observation.to
    )
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
    if validate_observation(observation).is_err() || !learning_enabled(existing) {
        return None;
    }
    let key = preference_key(&observation.scope, &observation.field);
    // Any existing record for this key (live, pending, or rejected) settles
    // it: keep counting, stay quiet. Rejected suggestions only return after
    // a memory reset — no nagging.
    if existing.iter().any(|p| p.key == key) {
        return None;
    }
    let counter_key = observation_counter_key(observation);
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
                "Suggested after {} saved edits to {}. Previous value: {}.",
                *count,
                observation.field,
                observation.from.chars().take(80).collect::<String>()
            ),
        })
    } else {
        None
    }
}

/// Map (scope, field) observations to preference keys. Unknown fields yield
/// a namespaced key rather than failing (forward-compatible).
pub fn preference_key(scope: &str, field: &str) -> String {
    if scope.starts_with("repo:") {
        return project_key(scope, field).unwrap_or_default();
    }
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
    for pref in preferences.iter().filter(|p| {
        p.enabled && p.scope == "*" && ["manual", "accepted"].contains(&p.source.as_str())
    }) {
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

pub fn resolve_role_defaults(
    profiles: &[crate::agents::AgentProfile],
    preferences: &[Preference],
) -> std::collections::HashMap<String, String> {
    let ids: std::collections::HashSet<_> = profiles.iter().map(|p| p.id.as_str()).collect();
    let valid: Vec<_> = preferences
        .iter()
        .filter(|p| p.value.as_str().is_some_and(|id| ids.contains(id)))
        .cloned()
        .collect();
    let mut map = apply_to_roles(&valid, std::collections::HashMap::new());
    for profile in profiles {
        if let Some(role) = profile.role.as_ref().filter(|r| !r.trim().is_empty()) {
            map.entry(role.clone()).or_insert(profile.id.clone());
        }
    }
    map
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
    let mut keys = std::collections::HashSet::new();
    for pref in &prefs {
        validate_preference(pref)?;
        if !keys.insert(&pref.key) {
            return Err("Duplicate preference key in import.".into());
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

    fn project_pref(scope: &str, field: &str, value: &str) -> Preference {
        Preference {
            key: project_key(scope, field).unwrap(),
            scope: scope.into(),
            value: serde_json::json!(value),
            source: "manual".into(),
            enabled: true,
            note: "Saved by user".into(),
        }
    }
    #[test]
    fn project_context_is_isolated_and_accepted_only() {
        let scope = "repo:/projects/alpha";
        assert_eq!(
            project_key(scope, "testCommand").unwrap(),
            "project.a4116f52f11d44d7.testCommand"
        );
        let mut preferences = vec![
            project_pref(scope, "testCommand", "make test"),
            project_pref("repo:/projects/beta", "testCommand", "make beta"),
        ];
        for source in ["suggested", "rejected"] {
            let mut p = project_pref(scope, "conventions", source);
            p.source = source.into();
            preferences.push(p);
        }
        let context = project_context(&preferences, Some(scope));
        assert_eq!(context.preferences.len(), 1);
        assert!(context.text.contains("make test") && !context.text.contains("make beta"));
        preferences[0].enabled = false;
        assert!(project_context(&preferences, Some(scope))
            .preferences
            .is_empty());
    }
    #[test]
    fn validates_project_memory_and_observations() {
        let mut p = project_pref("repo:/projects/alpha", "testCommand", "make test");
        assert!(validate_preference(&p).is_ok());
        p.value = serde_json::json!("password=hunter2");
        assert!(validate_preference(&p).is_err());
        p.value = serde_json::json!("x".repeat(4001));
        assert!(validate_preference(&p).is_err());
        p.value = serde_json::json!({"x":true});
        assert!(validate_preference(&p).is_err());
        p.value = serde_json::json!("make test");
        p.key.push('x');
        assert!(validate_preference(&p).is_err());
        assert!(project_key("repo:relative", "testCommand").is_err());
        assert!(project_key("repo:/a", "unknown").is_err());
        assert!(project_scope("/does/not/exist/orchevia").is_err());
        let scope = project_scope(".").unwrap();
        assert!(scope.starts_with("repo:/"));
    }
    #[test]
    fn project_suggestions_are_scoped_and_rejections_stay_quiet() {
        let mut counts = std::collections::HashMap::new();
        let observation = EditObservation {
            scope: "repo:/a".into(),
            field: "testCommand".into(),
            from: "make old".into(),
            to: "make test".into(),
        };
        assert!(observe(&mut counts, &[], &observation).is_none());
        assert!(observe(&mut counts, &[], &observation).is_none());
        let mut p = observe(&mut counts, &[], &observation).unwrap();
        assert_eq!(p.key, project_key("repo:/a", "testCommand").unwrap());
        assert!(p.note.contains('3'));
        p.source = "rejected".into();
        p.enabled = false;
        assert!(observe(&mut counts, &[p], &observation).is_none());
        let different = EditObservation {
            scope: "repo:/b".into(),
            ..observation
        };
        assert!(observe(&mut counts, &[], &different).is_none());
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
    fn accepted_reviewer_choice_beats_fallback_and_stale_choice_does_not_hide_it() {
        let profiles: Vec<crate::agents::AgentProfile> =
            serde_json::from_value(serde_json::json!([
              {"id":"claude","name":"Claude review","adapter":"claude","role":"deepReview"},
              {"id":"codex","name":"Codex review","adapter":"codex","role":"deepReview"}
            ]))
            .unwrap();
        let mut pref = Preference {
            key: keys::DEEP_REVIEW_PROFILE.into(),
            scope: "*".into(),
            value: serde_json::json!("codex"),
            source: "accepted".into(),
            enabled: true,
            note: String::new(),
        };
        assert_eq!(
            resolve_role_defaults(&profiles, &[pref.clone()])
                .get("deepReview")
                .map(String::as_str),
            Some("codex")
        );
        pref.value = serde_json::json!("missing");
        assert_eq!(
            resolve_role_defaults(&profiles, &[pref.clone()])
                .get("deepReview")
                .map(String::as_str),
            Some("claude")
        );
        pref.value = serde_json::json!("codex");
        pref.source = "rejected".into();
        assert_eq!(
            resolve_role_defaults(&profiles, &[pref])
                .get("deepReview")
                .map(String::as_str),
            Some("claude")
        );
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
