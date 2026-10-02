//! Lossless developer documents over the existing runtime workflow model.
use crate::{
    agents::{resolve_profile_name, AgentProfile},
    workflow::*,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentSession {
    pub json: String,
    pub node_ids: HashMap<String, String>,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeveloperWorkflow {
    pub version: u32,
    pub name: String,
    pub nodes: Vec<DeveloperNode>,
    pub edges: Vec<DeveloperEdge>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub inputs: Vec<WorkflowInput>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub defaults: Option<WorkflowDefaults>,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeveloperNode {
    pub key: String,
    #[serde(rename = "type")]
    pub kind: NodeKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile_name: Option<String>,
    #[serde(default)]
    pub config: Value,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DeveloperEdge {
    pub from: String,
    pub to: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}
const CONFIG_KEYS: &[&str] = &[
    "executable",
    "args",
    "workingDir",
    "message",
    "prompt",
    "inputRefs",
    "timeoutSecs",
    "extendOnOutput",
    "retry",
    "maxVisits",
    "condition",
    "gitOp",
    "githubOp",
    "ticketKey",
    "mcpServerId",
    "mcpTool",
    "mcpArgs",
];
fn readable_key(node: &Node) -> String {
    if !node.id.starts_with("node-") && is_valid_input_name(&node.id) {
        return node.id.clone();
    }
    let label = node.label.as_deref().unwrap_or("step");
    let mut key = String::new();
    for c in label.chars() {
        if c.is_ascii_alphanumeric() {
            key.push(c.to_ascii_lowercase());
        } else if !key.ends_with('-') {
            key.push('-');
        }
    }
    let key = key.trim_matches('-');
    if key.is_empty() {
        "step".into()
    } else if !key.starts_with(|c: char| c.is_ascii_alphabetic()) {
        format!("step-{key}")
    } else {
        key.chars().take(55).collect()
    }
}
fn reference(text: &str, map: &HashMap<String, String>) -> Result<String, String> {
    if let Some(rest) = text.strip_prefix("node.") {
        let mut keys: Vec<_> = map.keys().collect();
        keys.sort_by_key(|k| std::cmp::Reverse(k.len()));
        for key in keys {
            if rest == key
                || rest
                    .strip_prefix(key.as_str())
                    .is_some_and(|tail| tail.starts_with('.'))
            {
                return Ok(format!("node.{}{}", map[key], &rest[key.len()..]));
            }
        }
        return Err(format!(
            "Unknown node reference '{text}'. Update references when renaming keys."
        ));
    }
    Ok(text.into())
}
fn rewrite(value: &mut Value, map: &HashMap<String, String>, bare: bool) -> Result<(), String> {
    match value {
        Value::String(s) => {
            if bare && s.starts_with("node.") {
                *s = reference(s, map)?;
                return Ok(());
            }
            let mut out = String::new();
            let mut start = 0;
            while let Some(offset) = s[start..].find("{{") {
                let at = start + offset;
                out.push_str(&s[start..at]);
                if at > 0 && s.as_bytes()[at - 1] == b'\\' {
                    out.push_str("{{");
                    start = at + 2;
                    continue;
                }
                let Some(end) = s[at + 2..].find("}}") else {
                    out.push_str(&s[at..]);
                    start = s.len();
                    break;
                };
                let end = at + 2 + end;
                let token = &s[at + 2..end];
                out.push_str("{{");
                out.push_str(&reference(token, map)?);
                out.push_str("}}");
                start = end + 2;
            }
            out.push_str(&s[start..]);
            *s = out;
        }
        Value::Array(values) => {
            for item in values {
                rewrite(item, map, bare)?;
            }
        }
        Value::Object(values) => {
            for (key, item) in values {
                if key == "inputRefs" {
                    if let Some(refs) = item.as_array_mut() {
                        for r in refs {
                            if let Some(id) = r.as_str() {
                                let target = map
                                    .get(id)
                                    .ok_or_else(|| format!("Unknown inputRefs node '{id}'."))?
                                    .clone();
                                *r = Value::String(target);
                            }
                        }
                    }
                } else {
                    rewrite(item, map, key == "left" || key == "right")?;
                }
            }
        }
        _ => {}
    };
    Ok(())
}
pub fn remap_config_references(
    config: &mut NodeConfig,
    map: &HashMap<String, String>,
) -> Result<(), String> {
    let mut value = serde_json::to_value(&*config).map_err(|e| e.to_string())?;
    rewrite(&mut value, map, false)?;
    *config = serde_json::from_value(value).map_err(|e| e.to_string())?;
    Ok(())
}

pub fn export_document(
    workflow: &Workflow,
    profiles: &[AgentProfile],
) -> Result<DocumentSession, String> {
    let mut aliases = HashMap::new();
    let mut used = HashSet::new();
    for node in &workflow.nodes {
        let base = readable_key(node);
        let mut key = base.clone();
        let mut n = 2;
        while !used.insert(key.clone()) {
            key = format!("{base}-{n}");
            n += 1;
        }
        aliases.insert(node.id.clone(), key);
    }
    let mut nodes = Vec::new();
    for node in &workflow.nodes {
        let mut config = serde_json::to_value(&node.config).map_err(|e| e.to_string())?;
        if let Some(object) = config.as_object_mut() {
            object.remove("agentProfileId");
            object.remove("agentRole");
            if object
                .get("args")
                .is_some_and(|v| v.as_array().is_some_and(Vec::is_empty))
            {
                object.remove("args");
            }
            if object.get("extendOnOutput") == Some(&Value::Bool(false)) {
                object.remove("extendOnOutput");
            }
        }
        rewrite(&mut config, &aliases, false)?;
        let profile = match node.config.agent_profile_id.as_ref() {
            Some(id) => Some(profiles.iter().find(|p| &p.id == id).ok_or_else(|| {
                format!(
                    "Agent Profile '{id}' is missing. Use Advanced JSON or configure it in Agents."
                )
            })?),
            None => None,
        };
        nodes.push(DeveloperNode {
            key: aliases[&node.id].clone(),
            kind: node.kind,
            label: node.label.clone(),
            role: node
                .config
                .agent_role
                .clone()
                .or_else(|| profile.and_then(|p| p.role.clone())),
            profile_name: profile.map(|p| p.name.clone()),
            config,
        });
    }
    let edges = workflow
        .edges
        .iter()
        .map(|e| {
            Ok(DeveloperEdge {
                from: aliases
                    .get(&e.source)
                    .ok_or("Edge source is missing")?
                    .clone(),
                to: aliases
                    .get(&e.target)
                    .ok_or("Edge target is missing")?
                    .clone(),
                label: e.label.clone(),
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    let document = DeveloperWorkflow {
        version: 1,
        name: workflow.name.clone(),
        nodes,
        edges,
        inputs: workflow.inputs.clone(),
        defaults: workflow.defaults.clone(),
    };
    Ok(DocumentSession {
        json: serde_json::to_string_pretty(&document).map_err(|e| e.to_string())?,
        node_ids: aliases.into_iter().map(|(id, key)| (key, id)).collect(),
    })
}
pub fn import_document(
    json: &str,
    base: Option<&Workflow>,
    node_ids: &HashMap<String, String>,
    profiles: &[AgentProfile],
    role_map: &HashMap<String, String>,
    workflow_id: &str,
) -> Result<Workflow, String> {
    let value: Value =
        serde_json::from_str(json).map_err(|e| format!("Invalid workflow JSON: {e}"))?;
    if value.get("schemaVersion").is_some() {
        return Workflow::from_json(json).map_err(|e| e.to_string());
    }
    let document: DeveloperWorkflow =
        serde_json::from_value(value).map_err(|e| format!("Invalid developer workflow: {e}"))?;
    if document.version != 1 {
        return Err("Unsupported developer workflow version (expected 1).".into());
    }
    let mut ids = HashMap::new();
    let mut unique_ids = HashSet::new();
    for n in &document.nodes {
        if !is_valid_input_name(&n.key) {
            return Err(format!(
                "Invalid node key '{}'. Use letters, digits, _ or -, starting with a letter.",
                n.key
            ));
        }
        if ids.contains_key(&n.key) {
            return Err(format!("Duplicate node key '{}'.", n.key));
        }
        let id = node_ids
            .get(&n.key)
            .filter(|id| base.is_some_and(|wf| wf.nodes.iter().any(|n| &n.id == *id)))
            .cloned()
            .unwrap_or_else(|| n.key.clone());
        if !unique_ids.insert(id.clone()) {
            return Err("Node keys resolve to duplicate IDs.".into());
        }
        ids.insert(n.key.clone(), id);
    }
    let mut nodes = Vec::new();
    let max_y = base
        .map(|wf| wf.nodes.iter().map(|n| n.position.y).fold(0.0, f64::max))
        .unwrap_or(-100.0);
    let mut added = 0;
    for n in document.nodes {
        let mut config = n.config;
        let object = config.as_object().ok_or("Node config must be an object.")?;
        for key in object.keys() {
            if !CONFIG_KEYS.contains(&key.as_str()) {
                return Err(format!("Unknown config field '{key}'."));
            }
        }
        rewrite(&mut config, &ids, false)?;
        let mut config: NodeConfig =
            serde_json::from_value(config).map_err(|e| format!("Invalid node config: {e}"))?;
        if n.kind != NodeKind::Agent && (n.role.is_some() || n.profile_name.is_some()) {
            return Err("Profile/role selection is only valid on Agent nodes.".into());
        }
        if let Some(name) = n.profile_name {
            config.agent_profile_id = Some(resolve_profile_name(&name, profiles)?);
        } else if let Some(role) = n.role {
            if !is_known_role(&role) {
                return Err(format!("Unknown agent role '{role}'."));
            }
            if let Some(id) = role_map.get(&role) {
                config.agent_profile_id = Some(id.clone());
            } else {
                config.agent_role = Some(role);
            }
        }
        let id = ids[&n.key].clone();
        let position = match base.and_then(|wf| wf.nodes.iter().find(|n| n.id == id)) {
            Some(old) => old.position,
            None => {
                added += 1;
                Position {
                    x: 80.0,
                    y: max_y + added as f64 * 180.0,
                }
            }
        };
        nodes.push(Node {
            id,
            kind: n.kind,
            position,
            config,
            label: n.label,
        });
    }
    let mut edges = Vec::new();
    let mut used = HashSet::new();
    for e in document.edges {
        let source = ids
            .get(&e.from)
            .ok_or_else(|| format!("Unknown edge source '{}'.", e.from))?
            .clone();
        let target = ids
            .get(&e.to)
            .ok_or_else(|| format!("Unknown edge target '{}'.", e.to))?
            .clone();
        let old = base.and_then(|wf| {
            wf.edges.iter().find(|old| {
                old.source == source
                    && old.target == target
                    && old.label == e.label
                    && !used.contains(&old.id)
            })
        });
        let id = old
            .map(|e| e.id.clone())
            .unwrap_or_else(|| format!("edge-{}", uuid::Uuid::new_v4().simple()));
        used.insert(id.clone());
        edges.push(Edge {
            id,
            source,
            target,
            label: e.label,
        });
    }
    Ok(Workflow {
        schema_version: CURRENT_SCHEMA_VERSION,
        id: base
            .map(|wf| wf.id.clone())
            .unwrap_or_else(|| workflow_id.into()),
        name: document.name,
        nodes,
        edges,
        inputs: document.inputs,
        defaults: document.defaults,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn every_supported_config_field_and_profile_round_trips() {
        let mut wf = crate::workflow::sample_workflow();
        let old_start = wf.nodes[0].id.clone();
        wf.nodes[0].id = "start".into();
        for edge in &mut wf.edges {
            if edge.source == old_start {
                edge.source = "start".into();
            }
        }
        let profile:AgentProfile=serde_json::from_value(serde_json::json!({"id":"p","name":"Exact reviewer","adapter":"codex","role":"deepReview"})).unwrap();
        let config:NodeConfig=serde_json::from_value(serde_json::json!({"executable":"sh","args":["-c","echo {{node.start.output}}"],"workingDir":"/tmp","message":"literal node.start.output","prompt":"Read {{node.start.output}}","inputRefs":["start"],"agentProfileId":"p","timeoutSecs":3600,"extendOnOutput":true,"retry":{"maxAttempts":3,"delayMs":10,"backoff":true},"maxVisits":2,"condition":{"logic":"and","clauses":[{"left":"node.start.output","op":"equals","right":"yes"}]},"gitOp":{"op":"checkout","name":"branch","allowDirty":true},"githubOp":{"op":"createPr","title":"Title","body":"Body","base":"main","head":"branch","draft":true},"ticketKey":"KEY-1","mcpServerId":"server","mcpTool":"tool","mcpArgs":{"query":"{{node.start.output}}"}})).unwrap();
        for (i, kind) in [
            NodeKind::Start,
            NodeKind::Command,
            NodeKind::Approval,
            NodeKind::Agent,
            NodeKind::Condition,
            NodeKind::Git,
            NodeKind::GitHub,
            NodeKind::Ticket,
            NodeKind::Mcp,
            NodeKind::End,
        ]
        .iter()
        .enumerate()
        {
            let mut cfg = config.clone();
            if *kind != NodeKind::Agent {
                cfg.agent_profile_id = None;
            }
            wf.nodes.push(Node {
                id: format!("node-opaque-{i}"),
                kind: *kind,
                position: Position {
                    x: 30.0,
                    y: 44.0 + i as f64 * 120.0,
                },
                config: cfg,
                label: Some("Repeated label".into()),
            });
        }
        let exported = export_document(&wf, &[profile.clone()]).unwrap();
        let decoded = import_document(
            &exported.json,
            Some(&wf),
            &exported.node_ids,
            &[profile],
            &HashMap::new(),
            &wf.id,
        )
        .unwrap();
        assert_eq!(decoded, wf);
    }
    #[test]
    fn developer_github_kind_matches_typescript() {
        let mut wf = crate::workflow::sample_workflow();
        wf.nodes[1].kind = NodeKind::GitHub;
        let session = export_document(&wf, &[]).unwrap();
        assert!(session.json.contains("\"type\": \"github\""));
    }
    #[test]
    fn developer_document_round_trips_all_config() {
        let wf = crate::workflow::sample_workflow();
        let exported = export_document(&wf, &[]).unwrap();
        assert!(!exported.json.contains("position"));
        let decoded = import_document(
            &exported.json,
            Some(&wf),
            &exported.node_ids,
            &[],
            &HashMap::new(),
            &wf.id,
        )
        .unwrap();
        assert_eq!(decoded, wf);
    }
    #[test]
    fn rejects_duplicate_keys_unknown_fields_and_dangling_references() {
        for nodes in [
            json!([{"key":"a","type":"start","config":{"mystery":true}}]),
            json!([{"key":"a","type":"start","config":{}},{"key":"a","type":"end","config":{}}]),
            json!([{"key":"a","type":"command","config":{"executable":"echo","args":["{{node.missing.output}}"]}}]),
        ] {
            let text = json!({"version":1,"name":"Test","nodes":nodes,"edges":[]}).to_string();
            assert!(
                import_document(&text, None, &HashMap::new(), &[], &HashMap::new(), "wf").is_err()
            );
        }
    }
}
