use crate::{
    db::RunStatus,
    engine::{CancellationRegistry, Engine},
    run_controls::{RecoveryChoice, RunOptions},
    SqliteDb, Workflow,
};
use serde_json::json;
use std::{collections::HashMap, sync::Arc};

fn setup() -> (Arc<SqliteDb>, Engine, Workflow) {
    let db = Arc::new(SqliteDb::open_in_memory().unwrap());
    let wf = Workflow::from_json(&json!({"schemaVersion":6,"id":"test-controls","name":"Controls",
        "inputs":[{"name":"name","default":"saved"}],
        "nodes":[{"id":"s","type":"start"},{"id":"a","type":"command","config":{"executable":"must-never-run-v011"}},
        {"id":"b","type":"command","config":{"executable":"must-never-run-v011"}},{"id":"e","type":"end"}],
        "edges":[{"id":"sa","source":"s","target":"a"},{"id":"ab","source":"a","target":"b"},{"id":"be","source":"b","target":"e"}]}).to_string()).unwrap();
    db.upsert_workflow(&wf).unwrap();
    let engine = Engine::new(db.clone(), CancellationRegistry::default());
    (db, engine, wf)
}

fn options(value: serde_json::Value) -> RunOptions {
    serde_json::from_value(value).unwrap()
}

#[tokio::test]
async fn recovered_agent_output_does_not_import_sessions_or_cost() {
    let (db, engine, mut wf) = setup();
    wf.nodes[1].kind = crate::NodeKind::Agent;
    wf.nodes[1].config.agent_profile_id = Some("unavailable".into());
    wf.nodes[1].config.prompt = Some("test".into());
    db.create_run_with_workflow("session-source", &wf, &Default::default())
        .unwrap();
    db.record_node_result(crate::db::NewNodeResult {
        stdout: "retained",
        structured_json: r#"{"agentSession":{"id":"original","usable":true},"agentUsage":{"reported_cost_usd":10},"agentActivity":"historical activity"}"#,
        ..crate::db::NewNodeResult::simple("session-source", "a", "succeeded", Some(0), None)
    }).unwrap();
    db.record_node_result(crate::db::NewNodeResult::simple(
        "session-source",
        "b",
        "failed",
        Some(1),
        None,
    ))
    .unwrap();
    db.finish_run("session-source", RunStatus::Failed).unwrap();
    let plan = engine.preview_recovery("session-source").unwrap();
    engine
        .recover_run(
            "session-source",
            "session-child",
            &HashMap::from([
                ("a".into(), RecoveryChoice::Reuse),
                ("b".into(), RecoveryChoice::Skip),
            ]),
            &plan.fingerprint,
            "session-request",
        )
        .unwrap();
    engine.execute(wf.clone(), "session-child".into()).await;
    let rows = db.list_node_results("session-child").unwrap();
    let row = rows.iter().find(|r| r.node_id == "a").unwrap();
    assert_eq!(row.stdout, "retained");
    let metadata: serde_json::Value = serde_json::from_str(&row.structured_json).unwrap();
    assert!(metadata.get("reusedFrom").is_some());
    for key in ["agentSession", "agentUsage", "agentActivity"] {
        assert!(metadata.get(key).is_none());
    }
    assert_eq!(
        crate::run_controls::reported_spend(&wf, &rows, false).reported_usd,
        0.0
    );
    assert_eq!(
        db.get_run("session-child").unwrap().unwrap().status,
        RunStatus::Succeeded
    );
}

#[tokio::test]
async fn spend_pause_survives_reopen_and_cancellation_prevents_continuation() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("spend.sqlite");
    let (_, _, wf) = setup();
    let pause_id;
    {
        let db = SqliteDb::open(&path).unwrap();
        db.upsert_workflow(&wf).unwrap();
        db.create_run_with_execution(
            "persisted-guard",
            &wf,
            &Default::default(),
            &crate::run_controls::RunExecution {
                options: options(json!({"spendLimitUsd":1})),
                ..Default::default()
            },
        )
        .unwrap();
        db.pause_for_spend("persisted-guard", 2.0).unwrap();
        pause_id = db
            .get_run("persisted-guard")
            .unwrap()
            .unwrap()
            .execution
            .spend_pause
            .unwrap()
            .id;
    }
    let db = Arc::new(SqliteDb::open(&path).unwrap());
    let engine = Engine::new(db.clone(), Default::default());
    let run = db.get_run("persisted-guard").unwrap().unwrap();
    assert_eq!(run.execution.spend_pause.unwrap().id, pause_id);
    assert_eq!(run.execution.options.spend_limit_usd, Some(1.0));
    assert!(!db
        .decide_paused_run("persisted-guard", true, "", None)
        .unwrap());
    assert!(engine.cancel_run("persisted-guard").unwrap());
    assert!(engine
        .continue_spend_run("persisted-guard", pause_id, None)
        .await
        .is_err());
    assert_eq!(
        db.get_run("persisted-guard").unwrap().unwrap().status,
        RunStatus::Cancelled
    );
}

#[tokio::test]
async fn dry_run_loops_use_each_visit_and_never_write_a_sentinel() {
    let (db, engine, mut wf) = setup();
    let dir = tempfile::tempdir().unwrap();
    let sentinel = dir.path().join("sentinel");
    wf.nodes.remove(2);
    wf.nodes[1].config.executable = Some("sh".into());
    wf.nodes[1].config.args = vec!["-c".into(), format!("touch '{}'", sentinel.display())];
    wf.nodes[1].config.max_visits = Some(3);
    let condition=serde_json::from_value(json!({"id":"c","type":"condition","config":{"maxVisits":3,"condition":{"logic":"and","clauses":[{"left":"node.a.output","op":"equals","right":"again"}]}}})).unwrap();
    wf.nodes.insert(2, condition);
    wf.edges=serde_json::from_value(json!([{"id":"sa","source":"s","target":"a"},{"id":"ac","source":"a","target":"c"},{"id":"ca","source":"c","target":"a","label":"true"},{"id":"ce","source":"c","target":"e","label":"false"}])).unwrap();
    engine.start_run_with_options(&wf,"loop",&HashMap::new(),&options(json!({"dryRun":true,"fixtures":{"a":[{"status":"succeeded","stdout":"again"},{"status":"succeeded","stdout":"done"}]}}))).unwrap();
    engine.execute(wf, "loop".into()).await;
    assert!(!sentinel.exists());
    assert_eq!(
        db.get_run("loop").unwrap().unwrap().status,
        RunStatus::Succeeded
    );
    assert_eq!(
        db.list_node_results("loop")
            .unwrap()
            .iter()
            .filter(|r| r.node_id == "a")
            .count(),
        2
    );
}

#[tokio::test]
async fn dry_run_snapshot_and_mode_survive_database_reopen_at_approval() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("runs.sqlite");
    let (_, _, mut wf) = setup();
    wf.nodes[2].kind = crate::NodeKind::Approval;
    {
        let db = Arc::new(SqliteDb::open(&path).unwrap());
        db.upsert_workflow(&wf).unwrap();
        let engine = Engine::new(db.clone(), CancellationRegistry::default());
        engine
            .start_run_with_options(
                &wf,
                "restart",
                &HashMap::new(),
                &options(json!({"dryRun":true,"fixtures":{"a":[{"status":"succeeded"}]}})),
            )
            .unwrap();
        engine.execute(wf.clone(), "restart".into()).await;
        assert_eq!(
            db.get_run("restart").unwrap().unwrap().status,
            RunStatus::Paused
        );
    }
    let db = Arc::new(SqliteDb::open(&path).unwrap());
    let engine = Engine::new(db.clone(), CancellationRegistry::default());
    wf.nodes[1].config.executable = Some("changed".into());
    engine.approve_run("restart", true, None, wf).await.unwrap();
    assert_eq!(
        db.get_run("restart").unwrap().unwrap().status,
        RunStatus::Succeeded
    );
    assert!(
        db.get_run("restart")
            .unwrap()
            .unwrap()
            .execution
            .options
            .dry_run
    );
}

#[test]
fn recovery_invalidates_selected_context_handoffs_without_graph_edges() {
    let (db, engine, mut wf) = setup();
    wf.nodes[2].kind = crate::NodeKind::Agent;
    wf.nodes[2].config.context_refs = vec!["a".into()];
    wf.edges=serde_json::from_value(json!([{"id":"sa","source":"s","target":"a"},{"id":"sb","source":"s","target":"b"},{"id":"ae","source":"a","target":"e"},{"id":"be","source":"b","target":"e"}])).unwrap();
    db.create_run_with_workflow("context-source", &wf, &HashMap::new())
        .unwrap();
    for (id, status) in [("s", "succeeded"), ("a", "failed"), ("b", "succeeded")] {
        db.record_node_result(crate::db::NewNodeResult::simple(
            "context-source",
            id,
            status,
            None,
            None,
        ))
        .unwrap();
    }
    db.finish_run("context-source", RunStatus::Failed).unwrap();
    assert!(
        engine
            .preview_recovery("context-source")
            .unwrap()
            .nodes
            .iter()
            .find(|n| n.node_id == "b")
            .unwrap()
            .affected
    );
}

#[tokio::test]
async fn recovery_retains_unaffected_approval_decisions_without_reprompting() {
    let (db, engine, mut wf) = setup();
    wf.nodes.insert(
        1,
        serde_json::from_value(json!({"id":"gate","type":"approval"})).unwrap(),
    );
    wf.edges[0].target = "gate".into();
    wf.edges.insert(
        1,
        serde_json::from_value(json!({"id":"ga","source":"gate","target":"a"})).unwrap(),
    );
    db.create_run_with_workflow("approved-source", &wf, &HashMap::new())
        .unwrap();
    for (id, status) in [
        ("s", "succeeded"),
        ("gate", "approved"),
        ("a", "succeeded"),
        ("b", "failed"),
    ] {
        db.record_node_result(crate::db::NewNodeResult::simple(
            "approved-source",
            id,
            status,
            None,
            None,
        ))
        .unwrap();
    }
    db.finish_run("approved-source", RunStatus::Failed).unwrap();
    let plan = engine.preview_recovery("approved-source").unwrap();
    let choices = HashMap::from([
        ("a".into(), RecoveryChoice::Reuse),
        ("b".into(), RecoveryChoice::Skip),
    ]);
    engine
        .recover_run(
            "approved-source",
            "approved-child",
            &choices,
            &plan.fingerprint,
            "approved-request",
        )
        .unwrap();
    engine.execute(wf, "approved-child".into()).await;
    assert_eq!(
        db.get_run("approved-child").unwrap().unwrap().status,
        RunStatus::Succeeded
    );
    assert!(db
        .list_node_results("approved-child")
        .unwrap()
        .iter()
        .any(|r| r.node_id == "gate"
            && r.status == "approved"
            && r.structured_json.contains("reusedFrom")));
}

#[tokio::test]
async fn spend_guard_pauses_before_dispatch_and_rejects_stale_continuation() {
    let (db, engine, mut wf) = setup();
    for node in &mut wf.nodes[1..3] {
        node.kind = crate::NodeKind::Agent;
        node.config.agent_profile_id = Some("unavailable".into());
        node.config.prompt = Some("test".into());
    }
    let execution = crate::run_controls::RunExecution {
        options: options(json!({"spendLimitUsd":1})),
        ..Default::default()
    };
    db.create_run_with_execution("guard", &wf, &HashMap::new(), &execution)
        .unwrap();
    db.record_node_result(crate::db::NewNodeResult {
        run_id: "guard",
        node_id: "a",
        status: "succeeded",
        exit_code: Some(0),
        stdout: "result",
        stderr: "",
        error: None,
        attempt: 1,
        duration_ms: 1,
        structured_json: r#"{"agentUsage":{"reported_cost_usd":1.5}}"#,
    })
    .unwrap();
    engine.execute(wf, "guard".into()).await;
    let run = db.get_run("guard").unwrap().unwrap();
    assert_eq!(run.status, RunStatus::Paused);
    let pause = run.execution.spend_pause.unwrap();
    assert_eq!(pause.reported_usd, 1.5);
    assert!(!db
        .list_node_results("guard")
        .unwrap()
        .iter()
        .any(|r| r.node_id == "b"));
    assert!(!db.continue_spend_run("guard", pause.id + 1, None).unwrap());
    assert!(db.continue_spend_run("guard", pause.id, Some(1.0)).is_err());
    assert!(!db.decide_paused_run("guard", true, "", None).unwrap());
    assert!(db.continue_spend_run("guard", pause.id, Some(3.0)).unwrap());
    assert!(!db.continue_spend_run("guard", pause.id, None).unwrap());
    assert_eq!(
        db.get_run("guard")
            .unwrap()
            .unwrap()
            .execution
            .options
            .spend_limit_usd,
        Some(3.0)
    );
}

#[tokio::test]
async fn guard_allows_pure_graph_completion_after_last_effect() {
    let (db, engine, mut wf) = setup();
    wf.nodes.remove(2);
    wf.edges.remove(1);
    wf.edges[1].source = "a".into();
    wf.nodes[1].kind = crate::NodeKind::Agent;
    let execution = crate::run_controls::RunExecution {
        options: options(json!({"spendLimitUsd":1})),
        ..Default::default()
    };
    db.create_run_with_execution("complete", &wf, &HashMap::new(), &execution)
        .unwrap();
    db.record_node_result(crate::db::NewNodeResult {
        run_id: "complete",
        node_id: "a",
        status: "succeeded",
        exit_code: Some(0),
        stdout: "",
        stderr: "",
        error: None,
        attempt: 1,
        duration_ms: 1,
        structured_json: r#"{"agentUsage":{"reported_cost_usd":2}}"#,
    })
    .unwrap();
    engine.execute(wf, "complete".into()).await;
    assert_eq!(
        db.get_run("complete").unwrap().unwrap().status,
        RunStatus::Succeeded
    );
}

#[tokio::test]
async fn every_effectful_kind_is_stubbed_before_profiles_directories_and_integrations() {
    for (kind, config) in [
        (
            "command",
            json!({"executable":"forbidden","workingDir":"/does-not-exist"}),
        ),
        (
            "agent",
            json!({"agentProfileId":"missing","prompt":"test","workingDir":"/does-not-exist"}),
        ),
        (
            "git",
            json!({"gitOp":{"op":"status"},"workingDir":"/does-not-exist"}),
        ),
        (
            "github",
            json!({"githubOp":{"op":"prStatus"},"workingDir":"/does-not-exist"}),
        ),
        (
            "ticket",
            json!({"ticketKey":"ABC-1","mcpServerId":"missing"}),
        ),
        ("mcp", json!({"mcpServerId":"missing","mcpTool":"write"})),
    ] {
        let (db, engine, mut wf) = setup();
        wf.nodes[1] =
            serde_json::from_value(json!({"id":"a","type":kind,"config":config})).unwrap();
        engine.start_run_with_options(&wf,"isolated",&HashMap::new(),&options(json!({"dryRun":true,"fixtures":{"a":[{"status":"succeeded"}],"b":[{"status":"succeeded"}]}}))).unwrap();
        engine.execute(wf, "isolated".into()).await;
        assert_eq!(
            db.get_run("isolated").unwrap().unwrap().status,
            RunStatus::Succeeded,
            "{kind}"
        );
        assert!(db.list_known_folders(100).unwrap().is_empty());
    }
}

#[tokio::test]
async fn dry_run_uses_fixtures_without_executables_and_fails_on_exhaustion() {
    let (db, engine, wf) = setup();
    engine
        .start_run_with_options(
            &wf,
            "dry",
            &HashMap::new(),
            &options(
                json!({"dryRun":true,"fixtures":{"a":[{"status":"succeeded","stdout":"fixture"}]}}),
            ),
        )
        .unwrap();
    engine.execute(wf, "dry".into()).await;
    assert_eq!(
        db.get_run("dry").unwrap().unwrap().status,
        RunStatus::Failed
    );
    let rows = db.list_node_results("dry").unwrap();
    assert_eq!(
        rows.iter().find(|r| r.node_id == "a").unwrap().stdout,
        "fixture"
    );
    assert!(rows
        .iter()
        .find(|r| r.node_id == "b")
        .unwrap()
        .error
        .as_ref()
        .unwrap()
        .contains("fixture"));
    assert!(
        db.get_run("dry")
            .unwrap()
            .unwrap()
            .execution
            .options
            .dry_run
    );
    assert!(db.list_notifications(100, false).unwrap().is_empty());
}

#[tokio::test]
async fn dry_run_retries_consume_successive_fixtures() {
    let (db, engine, mut wf) = setup();
    wf.nodes[1].config.retry = Some(crate::workflow::RetryPolicy {
        max_attempts: 2,
        delay_ms: 0,
        backoff: false,
    });
    engine.start_run_with_options(&wf,"retry",&HashMap::new(),&options(json!({"dryRun":true,"fixtures":{"a":[{"status":"failed"},{"status":"succeeded","stdout":"second"}],"b":[{"status":"succeeded"}]}}))).unwrap();
    engine.execute(wf, "retry".into()).await;
    assert_eq!(
        db.get_run("retry").unwrap().unwrap().status,
        RunStatus::Succeeded
    );
    let rows = db.list_node_results("retry").unwrap();
    let attempts: Vec<_> = rows
        .iter()
        .filter(|r| r.node_id == "a")
        .map(|r| (r.status.as_str(), r.attempt))
        .collect();
    assert_eq!(attempts, vec![("retrying", 1), ("succeeded", 2)]);
}

#[test]
fn run_options_reject_invalid_limits_fixture_statuses_and_live_fixtures() {
    let (_, engine, wf) = setup();
    for value in [
        json!({"spendLimitUsd":0}),
        json!({"spendLimitUsd":-2}),
        json!({"fixtures":{"a":[{"status":"succeeded"}]}}),
        json!({"dryRun":true,"fixtures":{"a":[{"status":"running"}]}}),
    ] {
        assert!(engine
            .start_run_with_options(&wf, "invalid", &HashMap::new(), &options(value))
            .is_err());
    }
}

#[tokio::test]
async fn recovery_requires_choices_and_preserves_snapshot_inputs_and_source() {
    let (db, engine, mut wf) = setup();
    engine.start_run_with_options(&wf,"source",&HashMap::new(),&options(json!({"dryRun":true,"fixtures":{"a":[{"status":"succeeded","stdout":"retained"}],"b":[{"status":"failed"}]}}))).unwrap();
    engine.execute(wf.clone(), "source".into()).await;
    wf.name = "edited".into();
    db.upsert_workflow(&wf).unwrap();
    let plan = engine.preview_recovery("source").unwrap();
    assert!(engine
        .recover_run(
            "source",
            "bad",
            &HashMap::new(),
            &plan.fingerprint,
            "request-bad"
        )
        .is_err());
    let choices = HashMap::from([
        ("a".into(), RecoveryChoice::Reuse),
        ("b".into(), RecoveryChoice::Skip),
    ]);
    let id = engine
        .recover_run(
            "source",
            "child",
            &choices,
            &plan.fingerprint,
            "request-child",
        )
        .unwrap();
    assert_eq!(id, "child");
    assert_eq!(
        db.get_run_workflow("child").unwrap().unwrap().name,
        "Controls"
    );
    assert_eq!(
        db.get_run("child").unwrap().unwrap().inputs["name"],
        "saved"
    );
    assert_eq!(
        db.get_run("source").unwrap().unwrap().status,
        RunStatus::Failed
    );
    assert_eq!(
        engine
            .recover_run(
                "source",
                "different",
                &choices,
                &plan.fingerprint,
                "request-child"
            )
            .unwrap(),
        "child"
    );
    engine.execute(wf, "child".into()).await;
    let rows = db.list_node_results("child").unwrap();
    assert_eq!(
        rows.iter().find(|r| r.node_id == "a").unwrap().stdout,
        "retained"
    );
    assert!(rows
        .iter()
        .find(|r| r.node_id == "a")
        .unwrap()
        .structured_json
        .contains("reusedFrom"));
    assert_eq!(
        rows.iter().find(|r| r.node_id == "b").unwrap().status,
        "skipped"
    );
}

#[tokio::test]
async fn recovery_rejects_reuse_of_failed_and_data_dependent_outputs() {
    let (db, engine, mut wf) = setup();
    wf.edges = vec![
        crate::Edge {
            id: "sa".into(),
            source: "s".into(),
            target: "a".into(),
            label: None,
        },
        crate::Edge {
            id: "sb".into(),
            source: "s".into(),
            target: "b".into(),
            label: None,
        },
    ];
    wf.nodes[2].config.args = vec!["{{node.a.output}}".into()];
    engine.start_run_with_options(&wf,"source-data",&HashMap::new(),&options(json!({"dryRun":true,"fixtures":{"a":[{"status":"failed"}],"b":[{"status":"succeeded"}]}}))).unwrap();
    engine.execute(wf, "source-data".into()).await;
    let plan = engine.preview_recovery("source-data").unwrap();
    assert!(
        plan.nodes
            .iter()
            .find(|n| n.node_id == "b")
            .unwrap()
            .affected
    );
    let choices = HashMap::from([
        ("a".into(), RecoveryChoice::Reuse),
        ("b".into(), RecoveryChoice::Replay),
    ]);
    assert!(engine
        .recover_run(
            "source-data",
            "bad-data",
            &choices,
            &plan.fingerprint,
            "bad-data"
        )
        .is_err());
    assert!(db.get_run("bad-data").unwrap().is_none());
}

#[test]
fn run_options_reject_absent_null_zero_negative_and_out_of_range_usage_limits() {
    let (_, engine, wf) = setup();
    // Zero, negative (via serde f64 for spend; u32 rejects negative at parse),
    // non-finite and out-of-range values are all rejected.
    for value in [
        json!({"spendLimitUsd": 0}),
        json!({"spendLimitUsd": -2}),
        json!({"maxAgentAttempts": 0}),
        json!({"maxAgentAttempts": 10_001}),
        json!({"maxToolCalls": 0}),
        json!({"maxToolCalls": 100_001}),
        json!({"maxSubagents": 0}),
        json!({"maxSubagents": 1_001}),
    ] {
        assert!(
            engine
                .start_run_with_options(
                    &wf,
                    "invalid-usage",
                    &HashMap::new(),
                    &options(value.clone())
                )
                .is_err(),
            "{value}"
        );
    }
    // Non-finite spend cannot arrive as JSON; the struct validator still
    // rejects it (mirrors the TypeScript Number.isFinite check).
    assert!(RunOptions {
        spend_limit_usd: Some(f64::INFINITY),
        ..RunOptions::default()
    }
    .validate(&wf)
    .is_err());
    // Unknown option keys are still rejected (deny_unknown_fields).
    assert!(serde_json::from_value::<RunOptions>(json!({"maxTokens": 5})).is_err());
    // Boundary values are accepted.
    for (index, value) in [
        json!({"maxAgentAttempts": 1}),
        json!({"maxAgentAttempts": 10_000}),
        json!({"maxToolCalls": 100_000}),
        json!({"maxSubagents": 1_000}),
    ]
    .into_iter()
    .enumerate()
    {
        assert!(
            engine
                .start_run_with_options(
                    &wf,
                    &format!("valid-usage-{index}"),
                    &HashMap::new(),
                    &options(value.clone())
                )
                .is_ok(),
            "{value}"
        );
    }
}

#[test]
fn workflow_and_node_allowances_reject_zero_and_out_of_range() {
    let (_, _, mut wf) = setup();
    wf.limits = Some(crate::run_controls::WorkflowLimits {
        max_agent_attempts: Some(0),
        max_tool_calls: None,
        max_subagents: None,
        spend_limit_usd: None,
    });
    assert!(crate::workflow::validate_workflow(&wf)
        .iter()
        .any(|i| i.code == "workflow-limits-invalid"
            && i.severity == crate::workflow::ValidationSeverity::Error));
    wf.limits = None;
    // Node "a" is a command node: allowances there are misplaced, never silent.
    wf.nodes[1].config.max_tool_calls = Some(10);
    assert!(crate::workflow::validate_workflow(&wf)
        .iter()
        .any(|i| i.code == "agent-allowance-misplaced"));
    wf.nodes[1].config.max_tool_calls = None;
    // Range checks apply on agent nodes.
    wf.nodes[1].kind = crate::NodeKind::Agent;
    wf.nodes[1].config.agent_profile_id = Some("p".into());
    wf.nodes[1].config.prompt = Some("x".into());
    wf.nodes[1].config.max_tool_calls = Some(100_001);
    wf.nodes[1].config.max_subagents = Some(0);
    let codes: Vec<_> = crate::workflow::validate_workflow(&wf)
        .iter()
        .map(|i| i.code.clone())
        .collect();
    assert!(codes.contains(&"agent-tool-allowance-invalid".to_string()));
    assert!(codes.contains(&"agent-subagent-allowance-invalid".to_string()));
    // Legacy workflows without any limits stay valid.
    wf.nodes[1].config.max_tool_calls = None;
    wf.nodes[1].config.max_subagents = None;
    assert!(crate::workflow::validate_workflow(&wf).is_empty());
}

#[test]
fn usage_summary_scans_all_history_with_honest_unknowns() {
    use crate::db::NewNodeResult;
    use crate::usage::{usage_summary, UsageFilter};
    let (db, _, wf) = setup();
    // 60 runs: proves analytics never comes from a capped recent-50 list.
    for n in 0..60 {
        let run_id = format!("usage-{n:02}");
        db.create_run_with_execution(
            &run_id,
            &wf,
            &Default::default(),
            &crate::run_controls::RunExecution::default(),
        )
        .unwrap();
        // Command-node rows carry no agent envelope; one run also holds a
        // simulated fixture row. Only real agent work counts as attempts.
        let structured = if n == 1 {
            r#"{"simulated":true}"#
        } else {
            "{}"
        };
        db.record_node_result(NewNodeResult {
            stdout: "ok",
            structured_json: structured,
            ..NewNodeResult::simple(&run_id, "a", "succeeded", Some(0), None)
        })
        .unwrap();
    }
    let summary = usage_summary(&db, &UsageFilter::default()).unwrap();
    assert_eq!(summary.runs_scanned, 60);
    assert_eq!(summary.totals.runs, 60);
    // Node "a" is a command node in this fixture: no agent attempts counted.
    assert_eq!(summary.totals.agent_attempts, 0);
    assert_eq!(summary.totals.simulated_results, 1);
    // Date boundaries are inclusive start / exclusive end.
    let first = db.get_run("usage-00").unwrap().unwrap();
    let filtered = usage_summary(
        &db,
        &UsageFilter {
            from: Some(first.started_at.to_rfc3339()),
            to: Some(first.started_at.to_rfc3339()),
            ..UsageFilter::default()
        },
    )
    .unwrap();
    assert_eq!(filtered.totals.runs, 0);
    assert!(usage_summary(
        &db,
        &UsageFilter {
            from: Some("not-a-date".into()),
            ..UsageFilter::default()
        }
    )
    .is_err());
}

#[test]
fn usage_summary_counts_agent_attempts_with_execution_identity() {
    use crate::db::NewNodeResult;
    use crate::usage::{usage_summary, UsageFilter};
    let (db, _, mut wf) = setup();
    wf.nodes[1].kind = crate::NodeKind::Agent;
    wf.nodes[1].config.agent_profile_id = Some("p".into());
    wf.nodes[1].config.prompt = Some("x".into());
    let run_id = "usage-agent";
    db.create_run_with_execution(
        run_id,
        &wf,
        &Default::default(),
        &crate::run_controls::RunExecution::default(),
    )
    .unwrap();
    db.record_node_result(NewNodeResult {
        stdout: "done",
        structured_json: r#"{"agentUsage":{"adapter":"claude","model":"sonnet","input_tokens":10,"output_tokens":4,"reported_cost_usd":0.5,"observed_tool_calls":6,"observed_subagents":1}}"#,
        attempt: 2,
        ..NewNodeResult::simple(run_id, "a", "succeeded", Some(0), None)
    })
    .unwrap();
    // A second loop visit can have the same node/attempt/status while its
    // distinct durable result id represents new consumption. Process completion
    // updates an existing live row rather than inserting another terminal event.
    db.record_node_result(NewNodeResult {
        stdout: "done",
        structured_json: r#"{"agentUsage":{"adapter":"claude","model":"sonnet","input_tokens":10,"reported_cost_usd":0.5}}"#,
        attempt: 2,
        ..NewNodeResult::simple(run_id, "a", "succeeded", Some(0), None)
    })
    .unwrap();
    // Legacy row without identity stays unknown, not zero.
    db.record_node_result(NewNodeResult {
        stdout: "old",
        structured_json: r#"{"agentUsage":{"input_tokens":2}}"#,
        attempt: 1,
        ..NewNodeResult::simple(run_id, "a", "failed", Some(1), None)
    })
    .unwrap();
    let summary = usage_summary(&db, &UsageFilter::default()).unwrap();
    assert_eq!(summary.totals.agent_attempts, 3);
    assert_eq!(summary.totals.failed_attempts, 1);
    assert_eq!(summary.totals.reported_usd_attempts, 2);
    assert_eq!(summary.totals.unknown_usd_attempts, 1);
    assert_eq!(summary.totals.unknown_model_attempts, 1);
    assert_eq!(summary.totals.observed_tool_calls, 6);
    assert_eq!(summary.totals.observed_subagents, 1);
    assert_eq!(summary.by_model.len(), 2);
    // Model filter narrows to the identified row only.
    let filtered = usage_summary(
        &db,
        &UsageFilter {
            models: vec!["sonnet".into()],
            ..UsageFilter::default()
        },
    )
    .unwrap();
    assert_eq!(filtered.totals.agent_attempts, 2);
    assert_eq!(filtered.days.len(), 1);
    assert_eq!(filtered.by_workflow.len(), 1);
    assert_eq!(filtered.by_workflow[0].workflow_name, "Controls");
}

#[tokio::test]
async fn reuse_finds_a_branch_result_after_an_earlier_pass_skipped_it() {
    // x sits on g1's true branch inside a loop: skipped on pass 1, run on
    // pass 2. Recovering with Reuse must find that run for x's first real
    // visit, not count the skip as a visit and fail.
    let db = Arc::new(SqliteDb::open_in_memory().unwrap());
    let engine = Engine::new(db.clone(), CancellationRegistry::default());
    let command = |id: &str| json!({"id":id,"type":"command","config":{"executable":"must-never-run-v011","maxVisits":3}});
    let condition = |id: &str, right: &str| json!({"id":id,"type":"condition","config":{"maxVisits":3,"condition":{"logic":"and","clauses":[{"left":"node.a.output","op":"equals","right":right}]}}});
    let wf = Workflow::from_json(&json!({"schemaVersion":6,"id":"reuse-loop","name":"Reuse loop",
        "nodes":[{"id":"s","type":"start"},command("a"),condition("g1","x"),command("x"),command("j"),condition("g2","again"),command("b"),{"id":"e","type":"end"}],
        "edges":[{"id":"sa","source":"s","target":"a"},{"id":"ag1","source":"a","target":"g1"},
            {"id":"g1x","source":"g1","target":"x","label":"true"},{"id":"g1j","source":"g1","target":"j","label":"false"},
            {"id":"xj","source":"x","target":"j"},{"id":"jg2","source":"j","target":"g2"},
            {"id":"g2a","source":"g2","target":"a","label":"true"},{"id":"g2b","source":"g2","target":"b","label":"false"},
            {"id":"be","source":"b","target":"e"}]}).to_string()).unwrap();
    db.upsert_workflow(&wf).unwrap();
    let fixtures = json!({"dryRun":true,"fixtures":{
        "a":[{"status":"succeeded","stdout":"again"},{"status":"succeeded","stdout":"x"}],
        "x":[{"status":"succeeded","stdout":"from-x"}],
        "j":[{"status":"succeeded"},{"status":"succeeded"}],
        "b":[{"status":"failed"}]}});
    engine
        .start_run_with_options(&wf, "reuse-source", &HashMap::new(), &options(fixtures))
        .unwrap();
    engine.execute(wf.clone(), "reuse-source".into()).await;
    assert_eq!(
        db.get_run("reuse-source").unwrap().unwrap().status,
        RunStatus::Failed
    );
    let plan = engine.preview_recovery("reuse-source").unwrap();
    let choices = HashMap::from([
        ("a".into(), RecoveryChoice::Reuse),
        ("x".into(), RecoveryChoice::Reuse),
        ("j".into(), RecoveryChoice::Reuse),
        ("b".into(), RecoveryChoice::Skip),
    ]);
    engine
        .recover_run(
            "reuse-source",
            "reuse-child",
            &choices,
            &plan.fingerprint,
            "reuse-request",
        )
        .unwrap();
    engine.execute(wf, "reuse-child".into()).await;
    let rows = db.list_node_results("reuse-child").unwrap();
    let x: Vec<(&str, &str)> = rows
        .iter()
        .filter(|r| r.node_id == "x")
        .map(|r| (r.status.as_str(), r.stdout.as_str()))
        .collect();
    assert_eq!(
        x,
        vec![("skipped", ""), ("succeeded", "from-x")],
        "{rows:?}"
    );
    assert_eq!(
        db.get_run("reuse-child").unwrap().unwrap().status,
        RunStatus::Succeeded,
        "{rows:?}"
    );
}

#[tokio::test]
async fn dry_runs_show_the_script_command_they_would_run_without_looking_it_up() {
    let (db, engine, mut wf) = setup();
    wf.defaults = Some(crate::workflow::WorkflowDefaults {
        repo_dir: Some("/no/such/repo".into()),
        branch: None,
    });
    wf.nodes[1].config.executable = None;
    wf.nodes[1].config.script_file = Some("scripts/ci.sh".into());
    wf.nodes[1].config.args = vec!["--name".into(), "{{input.name}}".into()];
    let fixtures = json!({"dryRun":true,"fixtures":{
        "a":[{"status":"succeeded"}],"b":[{"status":"succeeded"}]}});
    engine
        .start_run_with_options(&wf, "dry-script", &HashMap::new(), &options(fixtures))
        .unwrap();
    engine.execute(wf.clone(), "dry-script".into()).await;
    let rows = db.list_node_results("dry-script").unwrap();
    let row = rows.iter().find(|r| r.node_id == "a").unwrap();
    assert_eq!(row.status, "succeeded", "{rows:?}");
    let meta: serde_json::Value = serde_json::from_str(&row.structured_json).unwrap();
    assert_eq!(meta["simulated"], true);
    assert_eq!(
        meta["command"],
        "bash /no/such/repo/scripts/ci.sh --name saved"
    );
    // Only the engine writes the command; fixtures cannot fake one.
    let faked = json!({"dryRun":true,"fixtures":{
        "a":[{"status":"succeeded","structured":{"command":"rm -rf /"}}]}});
    assert!(engine
        .start_run_with_options(&wf, "faked", &HashMap::new(), &options(faked))
        .is_err());
}
