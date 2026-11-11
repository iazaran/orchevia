//! Feedback during a run, end to end through the real engine: a fake Claude
//! CLI answers ordinary prompts, feedback checks and corrections, and real
//! commands stand in for tests and a push.
use crate::{
    agents::{AdapterKind, AgentProfile},
    db::{RunStatus, StoredNodeResult},
    engine::{CancellationRegistry, Engine},
    feedback,
    run_controls::RunOptions,
    SqliteDb, Workflow,
};
use serde_json::{json, Value};
use std::{
    sync::Arc,
    time::{Duration, Instant},
};

struct Harness {
    db: Arc<SqliteDb>,
    engine: Arc<Engine>,
    dir: tempfile::TempDir,
}

/// The fake CLI's reply to a check, as one Claude result line.
fn check_reply(decision: &str) -> String {
    let text = match decision {
        "satisfied" => "The old keys still load.\n```orchevia-feedback\n{\"decision\":\"satisfied\",\"explanation\":\"Old config keys are still read.\"}\n```",
        "change" => "They are not read.\n```orchevia-feedback\n{\"decision\":\"change\",\"explanation\":\"Old keys are ignored.\",\"change\":\"Read the old config keys as a fallback.\"}\n```",
        _ => "I am not sure.",
    };
    json!({"type":"result","is_error":false,"result":text,"usage":{"input_tokens":1}}).to_string()
}

fn harness(decision: &str) -> Harness {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path();
    std::fs::write(
        path.join("check.jsonl"),
        format!("{}\n", check_reply(decision)),
    )
    .expect("check reply");
    // Ordinary prompts answer ORIGINAL, corrections CORRECTED; every prompt
    // is logged. CHECK_DELAY lets a test cancel during a check.
    let script = r#"#!/bin/sh
dir=@DIR@
input=$(cat)
printf '%s\n----\n' "$input" >> "$dir/prompts.log"
case "$input" in
  *"This is a check only"*)
    sleep "$(cat "$dir/check-delay" 2>/dev/null || echo 0)"
    cat "$dir/check.jsonl" ;;
  *"Feedback to apply"*)
    printf '%s\n' '{"type":"result","is_error":false,"result":"CORRECTED","usage":{"input_tokens":1}}' ;;
  *)
    sleep "$(cat "$dir/original-delay" 2>/dev/null || echo 0)"
    printf '%s\n' '{"type":"result","is_error":false,"result":"ORIGINAL","total_cost_usd":0.01,"usage":{"input_tokens":1}}' ;;
esac
"#
    .replace("@DIR@", &shell_escape::escape(path.to_string_lossy()));
    let cli = path.join("fake-claude");
    std::fs::write(&cli, script).expect("script");
    std::fs::set_permissions(&cli, std::fs::Permissions::from_mode(0o700)).expect("chmod");
    let db = Arc::new(SqliteDb::open_in_memory().expect("db"));
    db.upsert_agent_profile(&AgentProfile {
        id: "fake".into(),
        name: "Fake Claude".into(),
        adapter: AdapterKind::Claude,
        executable: Some(cli.to_string_lossy().into_owned()),
        model: None,
        effort: None,
        extra_args: vec![],
        skills: vec![],
        working_dir_mode: crate::agents::WorkingDirMode::Inherit,
        working_dir: None,
        default_timeout_secs: 60,
        role: None,
        permission_level: Default::default(),
        allowed_tools: vec![],
    })
    .expect("profile");
    let engine = Arc::new(Engine::new(
        Arc::clone(&db),
        CancellationRegistry::default(),
    ));
    Harness { db, engine, dir }
}

/// start → impl (AI) → tests (sleeps) → push (publishes) → end, and a
/// parallel lint step that also leads to push.
fn coding_workflow(test_delay: &str, push_delay: &str) -> Workflow {
    Workflow::from_json(
        &json!({"schemaVersion":6,"id":"wf-feedback","name":"Feedback",
        "nodes":[
          {"id":"start","type":"start"},
          {"id":"impl","type":"agent","label":"Implement","config":{"agentProfileId":"fake","prompt":"Change the config loader."}},
          {"id":"tests","type":"command","label":"Run tests","config":{"executable":"sh","args":["-c",format!("sleep {test_delay}; echo tests ok")]}},
          {"id":"lint","type":"command","label":"Lint","config":{"executable":"echo","args":["lint ok"]}},
          {"id":"push","type":"command","label":"Push branch","config":{"executable":"sh","args":["-c",format!("sleep {push_delay}; echo pushed")],"publishes":true}},
          {"id":"end","type":"end"}],
        "edges":[
          {"id":"e1","source":"start","target":"impl"},
          {"id":"e2","source":"impl","target":"tests"},
          {"id":"e3","source":"tests","target":"push"},
          {"id":"e4","source":"start","target":"lint"},
          {"id":"e5","source":"lint","target":"push"},
          {"id":"e6","source":"push","target":"end"}]})
        .to_string(),
    )
    .expect("workflow")
}

fn start(
    h: &Harness,
    wf: &Workflow,
    run_id: &str,
    options: RunOptions,
) -> tokio::task::JoinHandle<()> {
    h.db.upsert_workflow(wf).expect("upsert");
    h.engine
        .start_run_with_options(wf, run_id, &Default::default(), &options)
        .expect("start");
    let engine = Arc::clone(&h.engine);
    let wf = wf.clone();
    let id = run_id.to_string();
    tokio::spawn(async move { engine.execute(wf, id).await })
}

async fn wait_until(
    h: &Harness,
    run_id: &str,
    what: &str,
    check: impl Fn(&[StoredNodeResult]) -> bool,
) {
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        let rows = h.db.list_node_results(run_id).expect("rows");
        if check(&rows) {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "timed out waiting for {what}: {rows:#?}"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

fn status_of(rows: &[StoredNodeResult], node: &str) -> Option<String> {
    rows.iter()
        .rev()
        .find(|r| r.node_id == node)
        .map(|r| r.status.clone())
}

fn outputs(h: &Harness, run_id: &str, node: &str) -> Vec<String> {
    h.db.list_node_results(run_id)
        .expect("rows")
        .into_iter()
        .filter(|r| r.node_id == node && r.status == "succeeded")
        .map(|r| r.stdout.trim().to_string())
        .collect()
}

fn metadata(row: &StoredNodeResult) -> Value {
    serde_json::from_str(&row.structured_json).unwrap_or(Value::Null)
}

fn run_status(h: &Harness, run_id: &str) -> RunStatus {
    h.db.get_run(run_id).expect("get").expect("run").status
}

/// Wait for the implementation to finish and the tests to be running, then
/// send feedback on the implementation.
async fn feedback_while_testing(h: &Harness, run_id: &str, on: &str) -> feedback::RunFeedback {
    wait_until(h, run_id, "tests running", |rows| {
        status_of(rows, "impl").as_deref() == Some("succeeded")
            && status_of(rows, "tests").as_deref() == Some("running")
    })
    .await;
    h.engine
        .submit_feedback(
            run_id,
            on,
            None,
            "Keep compatibility with the old configuration.",
        )
        .expect("submit")
}

#[tokio::test]
async fn feedback_that_needs_a_change_corrects_the_step_and_reruns_what_uses_it() {
    let h = harness("change");
    let wf = coding_workflow("0.6", "0");
    let run = start(&h, &wf, "fb-change", RunOptions::default());
    let item = feedback_while_testing(&h, "fb-change", "impl").await;
    assert_eq!(item.status, feedback::PENDING);
    run.await.expect("run");
    assert_eq!(run_status(&h, "fb-change"), RunStatus::Succeeded);
    let items = h.db.list_feedback("fb-change").expect("feedback");
    assert_eq!(items[0].status, feedback::ADDRESSED, "{items:#?}");
    assert_eq!(items[0].target_node_id.as_deref(), Some("impl"));
    assert_eq!(items[0].round, Some(1));
    assert_eq!(items[0].correction_result_ids.len(), 1);
    // The original result stays; the correction is a new, labelled result.
    assert_eq!(outputs(&h, "fb-change", "impl"), ["ORIGINAL", "CORRECTED"]);
    assert_eq!(outputs(&h, "fb-change", "tests").len(), 2, "tests reran");
    assert_eq!(
        outputs(&h, "fb-change", "lint").len(),
        1,
        "parallel lint was not rerun"
    );
    assert_eq!(outputs(&h, "fb-change", "push").len(), 1, "published once");
    let rows = h.db.list_node_results("fb-change").expect("rows");
    let check = rows
        .iter()
        .find(|r| r.status == "checked")
        .expect("check row");
    assert_eq!(check.node_id, "impl");
    assert_eq!(metadata(check)["feedbackCheck"]["decision"], "change");
    assert_eq!(items[0].check_result_id, Some(check.id));
    let correction = rows
        .iter()
        .find(|r| r.node_id == "impl" && r.stdout.trim() == "CORRECTED")
        .expect("correction");
    assert_eq!(
        metadata(correction)["correction"]["feedbackIds"],
        json!([item.id])
    );
    let marker = rows
        .iter()
        .find(|r| r.node_id == feedback::ROUND_NODE)
        .expect("round marker");
    assert_eq!(metadata(marker)["feedbackRound"]["roots"], json!(["impl"]));
    // Push ran after the corrected tests, never before the correction.
    let push = rows.iter().find(|r| r.node_id == "push").expect("push");
    let last_tests = rows
        .iter()
        .rev()
        .find(|r| r.node_id == "tests")
        .expect("tests");
    assert!(push.id > last_tests.id && push.id > correction.id);
    // The correction prompt carried the feedback and the check's change.
    let prompts = std::fs::read_to_string(h.dir.path().join("prompts.log")).expect("log");
    assert!(prompts.contains("Keep compatibility with the old configuration."));
    assert!(prompts.contains("- Read the old config keys as a fallback."));
    // Checks and corrections are agent attempts like any other.
    assert_eq!(
        crate::run_controls::count_agent_attempts(&wf, &rows),
        3,
        "original, check and correction"
    );
    let execution =
        h.db.get_run("fb-change")
            .expect("get")
            .expect("run")
            .execution;
    assert_eq!(execution.feedback.rounds, 1);
    assert_eq!(
        execution.feedback.publication_started.map(|p| p.node_id),
        Some("push".into())
    );
}

#[tokio::test]
async fn satisfied_feedback_is_explained_and_reruns_nothing() {
    let h = harness("satisfied");
    let wf = coding_workflow("0.6", "0");
    let run = start(&h, &wf, "fb-ok", RunOptions::default());
    feedback_while_testing(&h, "fb-ok", "impl").await;
    run.await.expect("run");
    assert_eq!(run_status(&h, "fb-ok"), RunStatus::Succeeded);
    let items = h.db.list_feedback("fb-ok").expect("feedback");
    assert_eq!(items[0].status, feedback::SATISFIED);
    assert_eq!(items[0].decision, "Old config keys are still read.");
    assert_eq!(outputs(&h, "fb-ok", "impl"), ["ORIGINAL"]);
    assert_eq!(outputs(&h, "fb-ok", "tests").len(), 1);
    assert!(h
        .db
        .list_node_results("fb-ok")
        .expect("rows")
        .iter()
        .all(|r| r.node_id != feedback::ROUND_NODE));
}

#[tokio::test]
async fn feedback_on_a_command_goes_to_the_ai_step_whose_work_it_uses() {
    let h = harness("change");
    let wf = coding_workflow("0.6", "0");
    let run = start(&h, &wf, "fb-cmd", RunOptions::default());
    // The tests step is running: feedback on it is allowed and goes to impl.
    feedback_while_testing(&h, "fb-cmd", "tests").await;
    run.await.expect("run");
    let items = h.db.list_feedback("fb-cmd").expect("feedback");
    assert_eq!(items[0].target_node_id.as_deref(), Some("impl"));
    assert_eq!(items[0].status, feedback::ADDRESSED);
    let prompts = std::fs::read_to_string(h.dir.path().join("prompts.log")).expect("log");
    assert!(prompts.contains("The feedback was written on the later step \"Run tests\""));
    assert_eq!(outputs(&h, "fb-cmd", "impl"), ["ORIGINAL", "CORRECTED"]);
}

#[tokio::test]
async fn feedback_after_publishing_started_is_recorded_but_never_applied() {
    let h = harness("change");
    let wf = coding_workflow("0", "0.6");
    let run = start(&h, &wf, "fb-late", RunOptions::default());
    wait_until(&h, "fb-late", "push running", |rows| {
        status_of(rows, "push").as_deref() == Some("running")
    })
    .await;
    let item = h
        .engine
        .submit_feedback("fb-late", "impl", None, "Too late?")
        .expect("submit");
    assert_eq!(item.status, feedback::LATE);
    assert!(item.decision.contains("\"Push branch\" started publishing"));
    run.await.expect("run");
    assert_eq!(run_status(&h, "fb-late"), RunStatus::Succeeded);
    assert_eq!(outputs(&h, "fb-late", "impl"), ["ORIGINAL"]);
    assert_eq!(
        h.db.list_feedback("fb-late").expect("feedback")[0].status,
        feedback::LATE
    );
    // A finished run takes no more feedback.
    assert!(h
        .engine
        .submit_feedback("fb-late", "impl", None, "x")
        .is_err());
}

#[tokio::test]
async fn an_unclear_check_pauses_before_publishing_until_the_person_continues() {
    let h = harness("unclear");
    let wf = coding_workflow("0.6", "0");
    let run = start(&h, &wf, "fb-unclear", RunOptions::default());
    feedback_while_testing(&h, "fb-unclear", "impl").await;
    run.await.expect("run");
    assert_eq!(run_status(&h, "fb-unclear"), RunStatus::Paused);
    let items = h.db.list_feedback("fb-unclear").expect("feedback");
    assert_eq!(items[0].status, feedback::NEEDS_ATTENTION);
    assert!(items[0].decision.contains("decision block"));
    assert!(
        outputs(&h, "fb-unclear", "push").is_empty(),
        "nothing published"
    );
    let pause =
        h.db.get_run("fb-unclear")
            .expect("get")
            .expect("run")
            .execution
            .feedback
            .pause
            .expect("feedback pause");
    // An approval cannot clear it; continuing does, and the run publishes.
    assert!(h
        .engine
        .claim_approval("fb-unclear", true, None, None, wf.clone())
        .is_err());
    h.engine
        .continue_feedback_run("fb-unclear", pause.id)
        .await
        .expect("continue");
    assert_eq!(run_status(&h, "fb-unclear"), RunStatus::Succeeded);
    assert_eq!(outputs(&h, "fb-unclear", "push").len(), 1);
    assert!(h.db.list_feedback("fb-unclear").expect("feedback")[0].acknowledged);
}

#[tokio::test]
async fn feedback_no_ai_step_can_handle_pauses_for_the_person() {
    let h = harness("change");
    let wf = coding_workflow("0.6", "0");
    let run = start(&h, &wf, "fb-lint", RunOptions::default());
    wait_until(&h, "fb-lint", "lint done, tests running", |rows| {
        status_of(rows, "lint").as_deref() == Some("succeeded")
            && status_of(rows, "tests").as_deref() == Some("running")
    })
    .await;
    h.engine
        .submit_feedback("fb-lint", "lint", None, "Use the strict lint profile.")
        .expect("submit");
    run.await.expect("run");
    assert_eq!(run_status(&h, "fb-lint"), RunStatus::Paused);
    let items = h.db.list_feedback("fb-lint").expect("feedback");
    assert_eq!(items[0].status, feedback::NEEDS_ATTENTION);
    assert!(items[0].decision.contains("No AI step"));
}

#[tokio::test]
async fn cancelling_during_a_check_leaves_its_feedback_not_processed() {
    let h = harness("change");
    std::fs::write(h.dir.path().join("check-delay"), "5").expect("delay");
    let wf = coding_workflow("0.4", "0");
    let run = start(&h, &wf, "fb-cancel", RunOptions::default());
    feedback_while_testing(&h, "fb-cancel", "impl").await;
    wait_until(&h, "fb-cancel", "check running", |rows| {
        rows.iter()
            .any(|r| r.node_id == "impl" && r.status == "running")
    })
    .await;
    assert!(h.engine.cancel_run("fb-cancel").expect("cancel"));
    run.await.expect("run");
    assert_eq!(run_status(&h, "fb-cancel"), RunStatus::Cancelled);
    let items = h.db.list_feedback("fb-cancel").expect("feedback");
    assert_eq!(items[0].status, feedback::NOT_PROCESSED);
    let rows = h.db.list_node_results("fb-cancel").expect("rows");
    // The interrupted check closed as a check, not as a cancelled visit.
    assert!(rows.iter().any(|r| r.status == "checked"));
    assert_eq!(outputs(&h, "fb-cancel", "impl"), ["ORIGINAL"]);
    assert!(outputs(&h, "fb-cancel", "push").is_empty());
}

/// Dry runs: fixtures drive every step and check, and an Approval step
/// pauses the run so feedback arrives at a known point.
fn approval_workflow(max_rounds: Option<u32>) -> Workflow {
    let mut wf = Workflow::from_json(
        &json!({"schemaVersion":6,"id":"wf-approve","name":"Approve",
        "nodes":[
          {"id":"start","type":"start"},
          {"id":"impl","type":"agent","label":"Implement","config":{"agentProfileId":"fake","prompt":"Change it."}},
          {"id":"tests","type":"command","label":"Run tests","config":{"executable":"never-runs","args":[]}},
          {"id":"approve","type":"approval","label":"Approve"},
          {"id":"push","type":"command","label":"Push branch","config":{"executable":"never-runs","args":[],"publishes":true}},
          {"id":"end","type":"end"}],
        "edges":[
          {"id":"e1","source":"start","target":"impl"},
          {"id":"e2","source":"impl","target":"tests"},
          {"id":"e3","source":"tests","target":"approve"},
          {"id":"e4","source":"approve","target":"push"},
          {"id":"e5","source":"push","target":"end"}]})
        .to_string(),
    )
    .expect("workflow");
    if let Some(n) = max_rounds {
        wf.limits = Some(crate::run_controls::WorkflowLimits {
            max_correction_rounds: Some(n),
            ..Default::default()
        });
    }
    wf
}

fn fixtures() -> RunOptions {
    serde_json::from_value(json!({"dryRun": true, "fixtures": {
        "impl": [{"status":"succeeded","stdout":"v1"},{"status":"succeeded","stdout":"v2"}],
        "tests": [{"status":"succeeded","stdout":"ok 1"},{"status":"succeeded","stdout":"ok 2"}],
        "push": [{"status":"succeeded","stdout":"pushed"}],
        "feedback:impl": [{"status":"succeeded","stdout":check_reply_text("change")},
                          {"status":"succeeded","stdout":check_reply_text("change")}]
    }}))
    .expect("options")
}

fn check_reply_text(decision: &str) -> String {
    let line: Value = serde_json::from_str(&check_reply(decision)).expect("reply");
    line["result"].as_str().unwrap_or("").to_string()
}

#[tokio::test]
async fn an_approval_inside_the_correction_is_asked_again_and_resume_replays_the_round() {
    let h = harness("change");
    let wf = approval_workflow(None);
    start(&h, &wf, "fb-approve", fixtures()).await.expect("run");
    assert_eq!(run_status(&h, "fb-approve"), RunStatus::Paused);
    h.engine
        .submit_feedback("fb-approve", "impl", None, "Keep old keys.")
        .expect("submit");
    h.engine
        .approve_run("fb-approve", true, None, wf.clone())
        .await
        .expect("approve");
    // The approval depends on the corrected work, so it is asked again,
    // after the feedback was addressed.
    assert_eq!(run_status(&h, "fb-approve"), RunStatus::Paused);
    assert_eq!(
        h.db.list_feedback("fb-approve").expect("feedback")[0].status,
        feedback::ADDRESSED
    );
    assert_eq!(outputs(&h, "fb-approve", "impl"), ["v1", "v2"]);
    assert_eq!(outputs(&h, "fb-approve", "tests"), ["ok 1", "ok 2"]);
    assert!(outputs(&h, "fb-approve", "push").is_empty());
    // Resuming replays the round from history and publishes once.
    h.engine
        .approve_run("fb-approve", true, None, wf.clone())
        .await
        .expect("approve again");
    assert_eq!(run_status(&h, "fb-approve"), RunStatus::Succeeded);
    assert_eq!(outputs(&h, "fb-approve", "push"), ["pushed"]);
    let rows = h.db.list_node_results("fb-approve").expect("rows");
    let correction = rows.iter().find(|r| r.stdout == "v2").expect("v2");
    assert_eq!(metadata(correction)["simulated"], true);
    assert!(metadata(correction)["correction"]["feedbackIds"].is_array());
    assert_eq!(
        rows.iter()
            .filter(|r| r.node_id == "approve" && r.status == "approved")
            .count(),
        2
    );
}

#[tokio::test]
async fn the_round_limit_pauses_before_publishing_and_continue_publishes_as_it_is() {
    let h = harness("change");
    let wf = approval_workflow(Some(1));
    start(&h, &wf, "fb-limit", fixtures()).await.expect("run");
    h.engine
        .submit_feedback("fb-limit", "impl", None, "First.")
        .expect("first");
    h.engine
        .approve_run("fb-limit", true, None, wf.clone())
        .await
        .expect("approve");
    // Paused at the re-asked approval after round 1; more feedback arrives.
    let second = h
        .engine
        .submit_feedback("fb-limit", "impl", None, "Second.")
        .expect("second");
    h.engine
        .approve_run("fb-limit", true, None, wf.clone())
        .await
        .expect("approve again");
    assert_eq!(run_status(&h, "fb-limit"), RunStatus::Paused);
    let items = h.db.list_feedback("fb-limit").expect("feedback");
    let second = items.iter().find(|i| i.id == second.id).expect("second");
    assert_eq!(second.status, feedback::NEEDS_ATTENTION);
    assert!(second.decision.contains("1 correction round"));
    assert!(outputs(&h, "fb-limit", "push").is_empty());
    let pause =
        h.db.get_run("fb-limit")
            .expect("get")
            .expect("run")
            .execution
            .feedback
            .pause
            .expect("pause");
    h.engine
        .continue_feedback_run("fb-limit", pause.id)
        .await
        .expect("continue");
    assert_eq!(run_status(&h, "fb-limit"), RunStatus::Succeeded);
    assert_eq!(outputs(&h, "fb-limit", "push"), ["pushed"]);
    assert_eq!(
        outputs(&h, "fb-limit", "impl"),
        ["v1", "v2"],
        "no second correction"
    );
}

#[tokio::test]
async fn a_missing_check_fixture_needs_attention_and_runs_nothing_real() {
    let h = harness("change");
    let wf = approval_workflow(None);
    let mut options = fixtures();
    options.fixtures.remove("feedback:impl");
    start(&h, &wf, "fb-nofix", options).await.expect("run");
    h.engine
        .submit_feedback("fb-nofix", "impl", None, "x")
        .expect("submit");
    h.engine
        .approve_run("fb-nofix", true, None, wf.clone())
        .await
        .expect("approve");
    assert_eq!(run_status(&h, "fb-nofix"), RunStatus::Paused);
    let items = h.db.list_feedback("fb-nofix").expect("feedback");
    assert_eq!(items[0].status, feedback::NEEDS_ATTENTION);
    assert!(!h.dir.path().join("prompts.log").exists(), "no CLI ran");
}

#[tokio::test]
async fn a_correction_gives_a_fix_loop_fresh_passes() {
    let h = harness("change");
    let wf = Workflow::from_json(
        &json!({"schemaVersion":6,"id":"wf-loop","name":"Loop",
        "nodes":[
          {"id":"start","type":"start"},
          {"id":"impl","type":"agent","config":{"agentProfileId":"fake","prompt":"Change it."}},
          {"id":"tests","type":"command","config":{"executable":"never-runs","args":[],"maxVisits":2}},
          {"id":"gate","type":"condition","config":{"maxVisits":2,"condition":{"logic":"and","clauses":[{"left":"node.tests.output","op":"contains","right":"FAIL"}]}}},
          {"id":"fix","type":"agent","config":{"agentProfileId":"fake","prompt":"Fix the tests.","maxVisits":2}},
          {"id":"approve","type":"approval"},
          {"id":"push","type":"command","config":{"executable":"never-runs","args":[],"publishes":true}},
          {"id":"end","type":"end"}],
        "edges":[
          {"id":"e1","source":"start","target":"impl"},
          {"id":"e2","source":"impl","target":"tests"},
          {"id":"e3","source":"tests","target":"gate"},
          {"id":"e4","source":"gate","target":"fix","label":"true"},
          {"id":"e5","source":"fix","target":"tests"},
          {"id":"e6","source":"gate","target":"approve","label":"false"},
          {"id":"e7","source":"approve","target":"push"},
          {"id":"e8","source":"push","target":"end"}]})
        .to_string(),
    )
    .expect("workflow");
    let options: RunOptions = serde_json::from_value(json!({"dryRun": true, "fixtures": {
        "impl": [{"status":"succeeded","stdout":"v1"},{"status":"succeeded","stdout":"v2"}],
        "tests": [{"status":"succeeded","stdout":"FAIL"},{"status":"succeeded","stdout":"ok"},
                  {"status":"succeeded","stdout":"FAIL"},{"status":"succeeded","stdout":"ok"}],
        "fix": [{"status":"succeeded","stdout":"fixed 1"},{"status":"succeeded","stdout":"fixed 2"}],
        "push": [{"status":"succeeded","stdout":"pushed"}],
        "feedback:impl": [{"status":"succeeded","stdout":check_reply_text("change")}]
    }}))
    .expect("options");
    start(&h, &wf, "fb-loop", options).await.expect("run");
    assert_eq!(
        run_status(&h, "fb-loop"),
        RunStatus::Paused,
        "at the approval"
    );
    h.engine
        .submit_feedback("fb-loop", "impl", None, "Keep old keys.")
        .expect("submit");
    h.engine
        .approve_run("fb-loop", true, None, wf.clone())
        .await
        .expect("approve");
    // The tests already used both visits; the correction gave the loop a new
    // allowance, so it went round again instead of hitting its limit.
    assert_eq!(
        run_status(&h, "fb-loop"),
        RunStatus::Paused,
        "approval asked again"
    );
    assert_eq!(
        outputs(&h, "fb-loop", "tests"),
        ["FAIL", "ok", "FAIL", "ok"]
    );
    assert_eq!(outputs(&h, "fb-loop", "fix"), ["fixed 1", "fixed 2"]);
    h.engine
        .approve_run("fb-loop", true, None, wf.clone())
        .await
        .expect("approve again");
    assert_eq!(run_status(&h, "fb-loop"), RunStatus::Succeeded);
    assert_eq!(outputs(&h, "fb-loop", "push"), ["pushed"]);
    assert_eq!(
        h.db.list_feedback("fb-loop").expect("feedback")[0].status,
        feedback::ADDRESSED
    );
}

#[tokio::test]
async fn a_reached_spend_target_pauses_before_a_feedback_check() {
    let h = harness("change");
    std::fs::write(h.dir.path().join("original-delay"), "0.6").expect("delay");
    let wf = Workflow::from_json(
        &json!({"schemaVersion":6,"id":"wf-spend","name":"Spend",
        "nodes":[
          {"id":"start","type":"start"},
          {"id":"impl","type":"agent","config":{"agentProfileId":"fake","prompt":"Change it."}},
          {"id":"end","type":"end"}],
        "edges":[{"id":"e1","source":"start","target":"impl"},{"id":"e2","source":"impl","target":"end"}]})
        .to_string(),
    )
    .expect("workflow");
    let options: RunOptions =
        serde_json::from_value(json!({"spendLimitUsd": 0.005})).expect("options");
    let run = start(&h, &wf, "fb-spend", options);
    wait_until(&h, "fb-spend", "impl running", |rows| {
        status_of(rows, "impl").as_deref() == Some("running")
    })
    .await;
    h.engine
        .submit_feedback("fb-spend", "impl", None, "Keep old keys.")
        .expect("submit");
    run.await.expect("run");
    let run = h.db.get_run("fb-spend").expect("get").expect("run");
    assert_eq!(run.status, RunStatus::Paused);
    assert!(
        run.execution.spend_pause.is_some(),
        "paused at the spend target"
    );
    let rows = h.db.list_node_results("fb-spend").expect("rows");
    assert!(rows.iter().all(|r| r.status != "checked"), "no check ran");
    assert_eq!(
        h.db.list_feedback("fb-spend").expect("feedback")[0].status,
        feedback::PENDING
    );
}

#[tokio::test]
async fn recovering_after_a_correction_reuses_the_corrected_result() {
    let h = harness("change");
    let wf = approval_workflow(None);
    start(&h, &wf, "fb-recover", fixtures()).await.expect("run");
    h.engine
        .submit_feedback("fb-recover", "impl", None, "Keep old keys.")
        .expect("submit");
    h.engine
        .approve_run("fb-recover", true, None, wf.clone())
        .await
        .expect("approve");
    // Asked again after the correction; rejecting fails the run.
    h.engine
        .approve_run("fb-recover", false, None, wf.clone())
        .await
        .expect("reject");
    assert_eq!(run_status(&h, "fb-recover"), RunStatus::Failed);
    let plan = h.engine.preview_recovery("fb-recover").expect("plan");
    let choices: std::collections::HashMap<String, crate::run_controls::RecoveryChoice> = plan
        .nodes
        .iter()
        .map(|n| {
            (
                n.node_id.clone(),
                if n.choices
                    .contains(&crate::run_controls::RecoveryChoice::Reuse)
                {
                    crate::run_controls::RecoveryChoice::Reuse
                } else {
                    crate::run_controls::RecoveryChoice::Replay
                },
            )
        })
        .collect();
    let id = h
        .engine
        .recover_run(
            "fb-recover",
            "fb-recovered",
            &choices,
            &plan.fingerprint,
            "req-1",
        )
        .expect("recover");
    let wf_run = h.db.get_run_workflow(&id).expect("wf").expect("snapshot");
    let engine = Arc::clone(&h.engine);
    engine.execute(wf_run, id.clone()).await;
    // The first visit reuses what the correction produced, not the
    // superseded first result.
    assert_eq!(
        outputs(&h, &id, "impl").first().map(String::as_str),
        Some("v2")
    );
    assert_eq!(
        outputs(&h, &id, "tests").first().map(String::as_str),
        Some("ok 2")
    );
}

#[tokio::test]
async fn correcting_a_review_inside_a_fix_loop_reruns_what_follows_it_in_order() {
    let h = harness("change");
    let wf = Workflow::from_json(
        &json!({"schemaVersion":6,"id":"wf-review-loop","name":"Review loop",
        "nodes":[
          {"id":"start","type":"start"},
          {"id":"impl","type":"agent","config":{"agentProfileId":"fake","prompt":"Change it."}},
          {"id":"tests","type":"command","config":{"executable":"never-runs","args":[],"maxVisits":3}},
          {"id":"review","type":"agent","config":{"agentProfileId":"fake","prompt":"Review it.","maxVisits":3}},
          {"id":"gate","type":"condition","config":{"maxVisits":3,"condition":{"logic":"and","clauses":[{"left":"node.review.output","op":"contains","right":"CHANGES"}]}}},
          {"id":"fix","type":"agent","config":{"agentProfileId":"fake","prompt":"Fix it.","maxVisits":3}},
          {"id":"approve","type":"approval"},
          {"id":"push","type":"command","config":{"executable":"never-runs","args":[],"publishes":true}},
          {"id":"end","type":"end"}],
        "edges":[
          {"id":"e1","source":"start","target":"impl"},
          {"id":"e2","source":"impl","target":"tests"},
          {"id":"e3","source":"tests","target":"review"},
          {"id":"e4","source":"review","target":"gate"},
          {"id":"e5","source":"gate","target":"fix","label":"true"},
          {"id":"e6","source":"fix","target":"tests"},
          {"id":"e7","source":"gate","target":"approve","label":"false"},
          {"id":"e8","source":"approve","target":"push"},
          {"id":"e9","source":"push","target":"end"}]})
        .to_string(),
    )
    .expect("workflow");
    let ok = |s: &str| json!({"status":"succeeded","stdout":s});
    let options: RunOptions = serde_json::from_value(json!({"dryRun": true, "fixtures": {
        "impl": [ok("v1")],
        "tests": [ok("ok 1"), ok("ok 2")],
        "review": [ok("clean 1"), ok("CHANGES needed"), ok("clean 2")],
        "fix": [ok("fixed")],
        "push": [ok("pushed")],
        "feedback:review": [ok(&check_reply_text("change"))]
    }}))
    .expect("options");
    start(&h, &wf, "fb-review-loop", options)
        .await
        .expect("run");
    assert_eq!(run_status(&h, "fb-review-loop"), RunStatus::Paused);
    h.engine
        .submit_feedback(
            "fb-review-loop",
            "review",
            None,
            "Check the old config path too.",
        )
        .expect("submit");
    h.engine
        .approve_run("fb-review-loop", true, None, wf.clone())
        .await
        .expect("approve");
    let rows = h.db.list_node_results("fb-review-loop").expect("rows");
    let marker = rows
        .iter()
        .find(|r| r.node_id == feedback::ROUND_NODE)
        .expect("round marker");
    assert_eq!(
        metadata(marker)["feedbackRound"]["refreshed"],
        json!(["tests"])
    );
    let after: Vec<String> = rows
        .iter()
        .filter(|r| r.id > marker.id && matches!(r.status.as_str(), "succeeded" | "approved"))
        .map(|r| match r.stdout.trim() {
            "true" | "false" => format!("{}:{}", r.node_id, r.stdout.trim()),
            _ => r.node_id.clone(),
        })
        .collect();
    // The tests rerun only after the fix, as the loop sends them round.
    assert_eq!(
        after,
        [
            "review",
            "gate:true",
            "fix",
            "tests",
            "review",
            "gate:false"
        ],
        "{rows:#?}"
    );
    assert_eq!(
        run_status(&h, "fb-review-loop"),
        RunStatus::Paused,
        "approval asked again"
    );
    h.engine
        .approve_run("fb-review-loop", true, None, wf.clone())
        .await
        .expect("approve again");
    assert_eq!(run_status(&h, "fb-review-loop"), RunStatus::Succeeded);
    assert_eq!(outputs(&h, "fb-review-loop", "push"), ["pushed"]);
}

#[tokio::test]
async fn carried_feedback_corrects_a_step_the_recovery_reused() {
    let h = harness("change");
    let wf = approval_workflow(None);
    start(&h, &wf, "fb-carry", fixtures()).await.expect("run");
    h.engine
        .submit_feedback("fb-carry", "impl", None, "Keep old keys.")
        .expect("submit");
    // Rejecting fails the run; its waiting feedback is not processed.
    h.engine
        .approve_run("fb-carry", false, None, wf.clone())
        .await
        .expect("reject");
    assert_eq!(run_status(&h, "fb-carry"), RunStatus::Failed);
    assert_eq!(
        h.db.list_feedback("fb-carry").expect("feedback")[0].status,
        feedback::NOT_PROCESSED
    );
    let plan = h.engine.preview_recovery("fb-carry").expect("plan");
    let choices: std::collections::HashMap<String, crate::run_controls::RecoveryChoice> = plan
        .nodes
        .iter()
        .map(|n| {
            (
                n.node_id.clone(),
                if n.choices
                    .contains(&crate::run_controls::RecoveryChoice::Reuse)
                {
                    crate::run_controls::RecoveryChoice::Reuse
                } else {
                    crate::run_controls::RecoveryChoice::Replay
                },
            )
        })
        .collect();
    let id = h
        .engine
        .recover_run(
            "fb-carry",
            "fb-carried",
            &choices,
            &plan.fingerprint,
            "req-carry",
        )
        .expect("recover");
    let snapshot = h.db.get_run_workflow(&id).expect("wf").expect("snapshot");
    Arc::clone(&h.engine).execute(snapshot, id.clone()).await;
    // The carried feedback was checked at the approval; the reused step then
    // ran for real (its next fixture), not from the failed run's history.
    let carried = h.db.list_feedback(&id).expect("feedback");
    assert_eq!(carried[0].status, feedback::ADDRESSED, "{carried:#?}");
    assert_eq!(outputs(&h, &id, "impl"), ["v1", "v2"]);
    assert_eq!(
        run_status(&h, &id),
        RunStatus::Paused,
        "the approval is asked"
    );
}

#[tokio::test]
async fn feedback_landing_just_before_the_publishing_claim_is_handled_first() {
    let h = harness("satisfied");
    let wf = coding_workflow("0", "0");
    let db = Arc::clone(&h.db);
    // Lands after the tick saw no waiting feedback, right before the claim.
    h.engine
        .before_publication_claim
        .lock()
        .expect("hook")
        .replace(Box::new(move || {
            db.submit_feedback("fb-race", "impl", None, "Just in time.")
                .expect("submit");
        }));
    start(&h, &wf, "fb-race", RunOptions::default())
        .await
        .expect("run");
    assert_eq!(run_status(&h, "fb-race"), RunStatus::Succeeded);
    let items = h.db.list_feedback("fb-race").expect("feedback");
    assert_eq!(items[0].status, feedback::SATISFIED, "{items:#?}");
    let rows = h.db.list_node_results("fb-race").expect("rows");
    let check = rows.iter().find(|r| r.status == "checked").expect("check");
    let push = rows.iter().find(|r| r.node_id == "push").expect("push");
    assert!(check.id < push.id, "checked before publishing");
}

#[tokio::test]
async fn feedback_sent_during_a_check_waits_for_the_next_pass_without_pausing() {
    let h = harness("satisfied");
    std::fs::write(h.dir.path().join("check-delay"), "1").expect("delay");
    let wf = coding_workflow("0.4", "0");
    let run = start(&h, &wf, "fb-during", RunOptions::default());
    feedback_while_testing(&h, "fb-during", "impl").await;
    wait_until(&h, "fb-during", "check running", |rows| {
        rows.iter()
            .any(|r| r.node_id == "impl" && r.status == "running")
    })
    .await;
    h.engine
        .submit_feedback("fb-during", "tests", None, "And the old env var name?")
        .expect("second");
    run.await.expect("run");
    assert_eq!(run_status(&h, "fb-during"), RunStatus::Succeeded);
    let items = h.db.list_feedback("fb-during").expect("feedback");
    assert!(
        items.iter().all(|i| i.status == feedback::SATISFIED),
        "{items:#?}"
    );
    let checks =
        h.db.list_node_results("fb-during")
            .expect("rows")
            .into_iter()
            .filter(|r| r.status == "checked")
            .count();
    assert_eq!(checks, 2, "each message checked in its own pass");
}

#[tokio::test]
async fn a_feedback_check_never_becomes_the_steps_output_for_later_steps() {
    let h = harness("satisfied");
    let wf = Workflow::from_json(
        &json!({"schemaVersion":6,"id":"wf-vars","name":"Vars",
        "nodes":[
          {"id":"start","type":"start"},
          {"id":"impl","type":"agent","config":{"agentProfileId":"fake","prompt":"Change it."}},
          {"id":"tests","type":"command","config":{"executable":"sh","args":["-c","sleep 0.6; echo ok"]}},
          {"id":"push","type":"command","config":{"executable":"echo","args":["pushed"],"publishes":true}},
          {"id":"summary","type":"agent","config":{"agentProfileId":"fake","prompt":"Summarize: {{node.impl.output}} status {{node.impl.status}}","contextRefs":["impl"]}},
          {"id":"end","type":"end"}],
        "edges":[
          {"id":"e1","source":"start","target":"impl"},
          {"id":"e2","source":"impl","target":"tests"},
          {"id":"e3","source":"tests","target":"push"},
          {"id":"e4","source":"push","target":"summary"},
          {"id":"e5","source":"summary","target":"end"}]})
        .to_string(),
    )
    .expect("workflow");
    let run = start(&h, &wf, "fb-vars", RunOptions::default());
    feedback_while_testing(&h, "fb-vars", "impl").await;
    run.await.expect("run");
    assert_eq!(run_status(&h, "fb-vars"), RunStatus::Succeeded);
    let prompts = std::fs::read_to_string(h.dir.path().join("prompts.log")).expect("log");
    let summary = prompts
        .split("----\n")
        .filter(|p| p.contains("Summarize:"))
        .last()
        .expect("summary prompt");
    assert!(
        summary.contains("Summarize: ORIGINAL status succeeded"),
        "{summary}"
    );
    assert!(
        !summary.contains("Old config keys are still read."),
        "{summary}"
    );
}

/// start → a (AI) → first (approval) → b (AI) → second (approval) → push → end
fn two_approvals() -> Workflow {
    Workflow::from_json(
        &json!({"schemaVersion":6,"id":"wf-two","name":"Two approvals",
        "nodes":[
          {"id":"start","type":"start"},
          {"id":"a","type":"agent","config":{"agentProfileId":"fake","prompt":"Do A."}},
          {"id":"first","type":"approval"},
          {"id":"b","type":"agent","config":{"agentProfileId":"fake","prompt":"Do B."}},
          {"id":"second","type":"approval"},
          {"id":"push","type":"command","config":{"executable":"never-runs","args":[],"publishes":true}},
          {"id":"end","type":"end"}],
        "edges":[
          {"id":"e1","source":"start","target":"a"},
          {"id":"e2","source":"a","target":"first"},
          {"id":"e3","source":"first","target":"b"},
          {"id":"e4","source":"b","target":"second"},
          {"id":"e5","source":"second","target":"push"},
          {"id":"e6","source":"push","target":"end"}]})
        .to_string(),
    )
    .expect("workflow")
}

#[tokio::test]
async fn an_approval_between_two_corrections_keeps_the_later_one_open() {
    let h = harness("change");
    let wf = two_approvals();
    let ok = |s: &str| json!({"status":"succeeded","stdout":s});
    let change = check_reply_text("change");
    let options: RunOptions = serde_json::from_value(json!({"dryRun": true, "fixtures": {
        "a": [ok("a1"), ok("a2")],
        "b": [ok("b1"), ok("b2")],
        "push": [ok("pushed")],
        "feedback:a": [ok(&change)],
        "feedback:b": [ok(&change)]
    }}))
    .expect("options");
    start(&h, &wf, "fb-two", options).await.expect("run");
    h.engine
        .approve_run("fb-two", true, None, wf.clone())
        .await
        .expect("first");
    assert_eq!(
        run_status(&h, "fb-two"),
        RunStatus::Paused,
        "at the second approval"
    );
    let on_a = h
        .engine
        .submit_feedback("fb-two", "a", None, "Fix A.")
        .expect("a");
    let on_b = h
        .engine
        .submit_feedback("fb-two", "b", None, "Fix B.")
        .expect("b");
    h.engine
        .approve_run("fb-two", true, None, wf.clone())
        .await
        .expect("second");
    // A was corrected; B cannot rerun before the first approval is asked
    // again, so its feedback stays being addressed, not "never ran".
    assert_eq!(run_status(&h, "fb-two"), RunStatus::Paused);
    let status = |id: i64| {
        h.db.list_feedback("fb-two")
            .expect("feedback")
            .into_iter()
            .find(|i| i.id == id)
            .map(|i| i.status)
    };
    assert_eq!(status(on_a.id).as_deref(), Some(feedback::ADDRESSED));
    assert_eq!(status(on_b.id).as_deref(), Some(feedback::CORRECTING));
    h.engine
        .approve_run("fb-two", true, None, wf.clone())
        .await
        .expect("first again");
    assert_eq!(status(on_b.id).as_deref(), Some(feedback::ADDRESSED));
    let rows = h.db.list_node_results("fb-two").expect("rows");
    let b2 = rows.iter().find(|r| r.stdout == "b2").expect("b corrected");
    assert_eq!(metadata(b2)["correction"]["feedbackIds"], json!([on_b.id]));
    h.engine
        .approve_run("fb-two", true, None, wf.clone())
        .await
        .expect("second again");
    assert_eq!(run_status(&h, "fb-two"), RunStatus::Succeeded);
    assert_eq!(outputs(&h, "fb-two", "push"), ["pushed"]);
}

#[tokio::test]
async fn a_skipped_publishing_step_does_not_close_the_feedback_window() {
    let h = harness("change");
    let mut wf = approval_workflow(None);
    // push before the approval, and a parallel lint branch that keeps the
    // approval reachable when the push is skipped.
    wf.nodes.push(
        serde_json::from_value(json!({"id":"lint","type":"command","position":{"x":0,"y":0},"config":{"executable":"never-runs","args":[]}}))
            .expect("lint"),
    );
    wf.edges = serde_json::from_value(json!([
        {"id":"e1","source":"start","target":"impl"},
        {"id":"e2","source":"impl","target":"tests"},
        {"id":"e3","source":"tests","target":"push"},
        {"id":"e4","source":"push","target":"approve"},
        {"id":"e5","source":"approve","target":"end"},
        {"id":"e6","source":"start","target":"lint"},
        {"id":"e7","source":"lint","target":"approve"}]))
    .expect("edges");
    let mut options = fixtures();
    options.fixtures.insert(
        "lint".into(),
        serde_json::from_value(json!([{"status":"succeeded","stdout":"lint ok"}])).expect("lint"),
    );
    start(&h, &wf, "fb-skip", options).await.expect("run");
    h.engine
        .approve_run("fb-skip", false, None, wf.clone())
        .await
        .expect("reject");
    let plan = h.engine.preview_recovery("fb-skip").expect("plan");
    let choices: std::collections::HashMap<String, crate::run_controls::RecoveryChoice> = plan
        .nodes
        .iter()
        .map(|n| {
            let choice = if n.node_id == "push" {
                crate::run_controls::RecoveryChoice::Skip
            } else if n
                .choices
                .contains(&crate::run_controls::RecoveryChoice::Reuse)
            {
                crate::run_controls::RecoveryChoice::Reuse
            } else {
                crate::run_controls::RecoveryChoice::Replay
            };
            (n.node_id.clone(), choice)
        })
        .collect();
    let id = h
        .engine
        .recover_run(
            "fb-skip",
            "fb-skipped",
            &choices,
            &plan.fingerprint,
            "req-skip",
        )
        .expect("recover");
    let snapshot = h.db.get_run_workflow(&id).expect("wf").expect("snapshot");
    Arc::clone(&h.engine).execute(snapshot, id.clone()).await;
    assert_eq!(run_status(&h, &id), RunStatus::Paused, "at the approval");
    let run = h.db.get_run(&id).expect("get").expect("run");
    assert!(run.execution.feedback.publication_started.is_none());
    let item = h
        .engine
        .submit_feedback(&id, "impl", None, "Still in time.")
        .expect("submit");
    assert_eq!(item.status, feedback::PENDING, "nothing was published");
}

#[tokio::test]
async fn a_round_stopped_by_the_attempt_budget_keeps_the_changes_it_decided() {
    let h = harness("change");
    std::fs::write(h.dir.path().join("original-delay"), "0.5").expect("delay");
    let wf = Workflow::from_json(
        &json!({"schemaVersion":6,"id":"wf-budget","name":"Budget",
        "nodes":[
          {"id":"start","type":"start"},
          {"id":"a","type":"agent","config":{"agentProfileId":"fake","prompt":"Do A."}},
          {"id":"b","type":"agent","config":{"agentProfileId":"fake","prompt":"Do B."}},
          {"id":"push","type":"command","config":{"executable":"echo","args":["pushed"],"publishes":true}},
          {"id":"end","type":"end"}],
        "edges":[
          {"id":"e1","source":"start","target":"a"},
          {"id":"e2","source":"a","target":"b"},
          {"id":"e3","source":"b","target":"push"},
          {"id":"e4","source":"push","target":"end"}]})
        .to_string(),
    )
    .expect("workflow");
    let options: RunOptions =
        serde_json::from_value(json!({"maxAgentAttempts": 3})).expect("options");
    let run = start(&h, &wf, "fb-budget", options);
    wait_until(&h, "fb-budget", "b running", |rows| {
        status_of(rows, "a").as_deref() == Some("succeeded")
            && status_of(rows, "b").as_deref() == Some("running")
    })
    .await;
    let on_a = h
        .engine
        .submit_feedback("fb-budget", "a", None, "Fix A.")
        .expect("a");
    let on_b = h
        .engine
        .submit_feedback("fb-budget", "b", None, "Fix B.")
        .expect("b");
    run.await.expect("run");
    // The third attempt checked A; checking B hit the budget. A's change
    // still started its round, recorded before the pause.
    let paused = h.db.get_run("fb-budget").expect("get").expect("run");
    assert!(
        paused.execution.usage_pause.is_some(),
        "paused at the budget"
    );
    let items = h.db.list_feedback("fb-budget").expect("feedback");
    let status = |id: i64| items.iter().find(|i| i.id == id).map(|i| i.status.clone());
    assert_eq!(status(on_a.id).as_deref(), Some(feedback::CORRECTING));
    assert_eq!(status(on_b.id).as_deref(), Some(feedback::PENDING));
    let rows = h.db.list_node_results("fb-budget").expect("rows");
    assert!(rows.iter().any(|r| r.node_id == feedback::ROUND_NODE));
    let pause = paused.execution.usage_pause.expect("pause");
    h.engine
        .continue_usage_run("fb-budget", pause.id, Some(20))
        .await
        .expect("continue");
    assert_eq!(run_status(&h, "fb-budget"), RunStatus::Succeeded);
    let items = h.db.list_feedback("fb-budget").expect("feedback");
    assert!(
        items.iter().all(|i| i.status == feedback::ADDRESSED),
        "{items:#?}"
    );
    assert_eq!(outputs(&h, "fb-budget", "a"), ["ORIGINAL", "CORRECTED"]);
    assert_eq!(outputs(&h, "fb-budget", "push").len(), 1);
}

#[tokio::test]
async fn a_check_that_reaches_the_spend_target_stops_the_round_there() {
    let h = harness("change");
    std::fs::write(h.dir.path().join("original-delay"), "0.5").expect("delay");
    // Each check reports USD 1, past the 0.5 target.
    let reply: Value = serde_json::from_str(&check_reply("change")).expect("reply");
    let mut costly = reply.clone();
    costly["total_cost_usd"] = json!(1.0);
    std::fs::write(h.dir.path().join("check.jsonl"), format!("{costly}\n")).expect("reply");
    let wf = Workflow::from_json(
        &json!({"schemaVersion":6,"id":"wf-spend2","name":"Spend",
        "nodes":[
          {"id":"start","type":"start"},
          {"id":"a","type":"agent","config":{"agentProfileId":"fake","prompt":"Do A."}},
          {"id":"b","type":"agent","config":{"agentProfileId":"fake","prompt":"Do B."}},
          {"id":"end","type":"end"}],
        "edges":[
          {"id":"e1","source":"start","target":"a"},
          {"id":"e2","source":"a","target":"b"},
          {"id":"e3","source":"b","target":"end"}]})
        .to_string(),
    )
    .expect("workflow");
    let options: RunOptions =
        serde_json::from_value(json!({"spendLimitUsd": 0.5})).expect("options");
    let run = start(&h, &wf, "fb-spend2", options);
    wait_until(&h, "fb-spend2", "b running", |rows| {
        status_of(rows, "a").as_deref() == Some("succeeded")
            && status_of(rows, "b").as_deref() == Some("running")
    })
    .await;
    let on_a = h
        .engine
        .submit_feedback("fb-spend2", "a", None, "Fix A.")
        .expect("a");
    let on_b = h
        .engine
        .submit_feedback("fb-spend2", "b", None, "Fix B.")
        .expect("b");
    run.await.expect("run");
    let paused = h.db.get_run("fb-spend2").expect("get").expect("run");
    assert!(
        paused.execution.spend_pause.is_some(),
        "paused at the spend target"
    );
    let rows = h.db.list_node_results("fb-spend2").expect("rows");
    assert_eq!(
        rows.iter().filter(|r| r.status == "checked").count(),
        1,
        "one check only"
    );
    let items = h.db.list_feedback("fb-spend2").expect("feedback");
    let status = |id: i64| items.iter().find(|i| i.id == id).map(|i| i.status.clone());
    assert_eq!(status(on_a.id).as_deref(), Some(feedback::CORRECTING));
    assert_eq!(status(on_b.id).as_deref(), Some(feedback::PENDING));
}

#[tokio::test]
async fn a_loop_step_a_correction_sends_round_runs_for_real_in_a_recovered_run() {
    let h = harness("change");
    let wf = Workflow::from_json(
        &json!({"schemaVersion":6,"id":"wf-loop-recover","name":"Loop recover",
        "nodes":[
          {"id":"start","type":"start"},
          {"id":"impl","type":"agent","config":{"agentProfileId":"fake","prompt":"Change it."}},
          {"id":"tests","type":"command","config":{"executable":"never-runs","args":[],"maxVisits":3}},
          {"id":"review","type":"agent","config":{"agentProfileId":"fake","prompt":"Review it.","maxVisits":3}},
          {"id":"gate","type":"condition","config":{"maxVisits":3,"condition":{"logic":"and","clauses":[{"left":"node.review.output","op":"contains","right":"CHANGES"}]}}},
          {"id":"fix","type":"agent","config":{"agentProfileId":"fake","prompt":"Fix it.","maxVisits":3}},
          {"id":"approve","type":"approval"},
          {"id":"push","type":"command","config":{"executable":"never-runs","args":[],"publishes":true}},
          {"id":"end","type":"end"}],
        "edges":[
          {"id":"e1","source":"start","target":"impl"},
          {"id":"e2","source":"impl","target":"tests"},
          {"id":"e3","source":"tests","target":"review"},
          {"id":"e4","source":"review","target":"gate"},
          {"id":"e5","source":"gate","target":"fix","label":"true"},
          {"id":"e6","source":"fix","target":"tests"},
          {"id":"e7","source":"gate","target":"approve","label":"false"},
          {"id":"e8","source":"approve","target":"push"},
          {"id":"e9","source":"push","target":"end"}]})
        .to_string(),
    )
    .expect("workflow");
    let ok = |s: &str| json!({"status":"succeeded","stdout":s});
    // The source run goes round the fix loop once, so every step can be
    // reused; its approval is rejected.
    let options: RunOptions = serde_json::from_value(json!({"dryRun": true, "fixtures": {
        "impl": [ok("v1")],
        "tests": [ok("ok 1"), ok("ok 2"), ok("ok 3")],
        "review": [ok("CHANGES 1"), ok("clean 1"), ok("CHANGES 2"), ok("clean 2")],
        "fix": [ok("fixed 1"), ok("fixed 2")],
        "push": [ok("pushed")],
        "feedback:review": [ok(&check_reply_text("change"))]
    }}))
    .expect("options");
    start(&h, &wf, "fb-lr", options).await.expect("run");
    h.engine
        .approve_run("fb-lr", false, None, wf.clone())
        .await
        .expect("reject");
    // Reuse the implementation, tests and review, as recovery does once
    // its choices are validated (created directly: the dialog refuses to
    // reuse tests while the fix step, skipped on the last pass, replays).
    let source = h.db.get_run("fb-lr").expect("get").expect("run");
    let reuse = ["impl", "tests", "review"];
    let seeds: Vec<StoredNodeResult> =
        h.db.list_node_results("fb-lr")
            .expect("rows")
            .into_iter()
            .filter(|r| r.status == "succeeded" && reuse.contains(&r.node_id.as_str()))
            .collect();
    let execution = crate::run_controls::RunExecution {
        options: source.execution.options.clone(),
        recovered_from: Some("fb-lr".into()),
        recovery_choices: reuse
            .iter()
            .map(|id| (id.to_string(), crate::run_controls::RecoveryChoice::Reuse))
            .collect(),
        ..Default::default()
    };
    let id =
        h.db.create_recovery_run("fb-lr-2", &source, &wf, &execution, &seeds, "req-lr")
            .expect("recover");
    let snapshot = h.db.get_run_workflow(&id).expect("wf").expect("snapshot");
    Arc::clone(&h.engine).execute(snapshot, id.clone()).await;
    assert_eq!(run_status(&h, &id), RunStatus::Paused, "at the approval");
    h.engine
        .submit_feedback(&id, "review", None, "Check the old path.")
        .expect("submit");
    h.engine
        .approve_run(&id, true, None, wf.clone())
        .await
        .expect("approve");
    // The tests were reused for both earlier passes; after the corrected
    // review's fix the loop sends them round and they run for real (their
    // next fixture) instead of asking for a third reused result.
    assert_eq!(outputs(&h, &id, "tests"), ["ok 1", "ok 2", "ok 3"]);
    let rows = h.db.list_node_results(&id).expect("rows");
    let last_tests = rows
        .iter()
        .rev()
        .find(|r| r.node_id == "tests")
        .expect("tests");
    assert!(
        metadata(last_tests).get("reusedFrom").is_none(),
        "{last_tests:#?}"
    );
    assert_eq!(
        run_status(&h, &id),
        RunStatus::Paused,
        "approval asked again"
    );
}

/// start → impl → tests → approve → review → gate; gate true (review found
/// a problem) → fix → back to tests; gate false → push → end.
fn review_loop_workflow() -> Workflow {
    Workflow::from_json(
        &json!({"schemaVersion":6,"id":"wf-review-loop","name":"Review loop",
        "nodes":[
          {"id":"start","type":"start"},
          {"id":"impl","type":"agent","config":{"agentProfileId":"fake","prompt":"Change it."}},
          {"id":"tests","type":"command","config":{"executable":"never-runs","args":[],"maxVisits":3}},
          {"id":"approve","type":"approval","config":{"maxVisits":3}},
          {"id":"review","type":"command","config":{"executable":"never-runs","args":[],"maxVisits":3}},
          {"id":"gate","type":"condition","config":{"maxVisits":3,"condition":{"logic":"and","clauses":[{"left":"node.review.output","op":"contains","right":"FAIL"}]}}},
          {"id":"fix","type":"agent","config":{"agentProfileId":"fake","prompt":"Fix it.","maxVisits":3}},
          {"id":"push","type":"command","config":{"executable":"never-runs","args":[],"publishes":true}},
          {"id":"end","type":"end"}],
        "edges":[
          {"id":"e1","source":"start","target":"impl"},
          {"id":"e2","source":"impl","target":"tests"},
          {"id":"e3","source":"tests","target":"approve"},
          {"id":"e4","source":"approve","target":"review"},
          {"id":"e5","source":"review","target":"gate"},
          {"id":"e6","source":"gate","target":"fix","label":"true"},
          {"id":"e7","source":"fix","target":"tests"},
          {"id":"e8","source":"gate","target":"push","label":"false"},
          {"id":"e9","source":"push","target":"end"}]})
        .to_string(),
    )
    .expect("workflow")
}

#[tokio::test]
async fn correcting_a_fix_step_after_its_loop_exited_waits_for_the_loop_to_decide_again() {
    let h = harness("change");
    let wf = review_loop_workflow();
    let options: RunOptions = serde_json::from_value(json!({"dryRun": true, "fixtures": {
        "impl": [{"status":"succeeded","stdout":"v1"}],
        "tests": [{"status":"succeeded","stdout":"ok 1"},{"status":"succeeded","stdout":"ok 2"},
                  {"status":"succeeded","stdout":"ok 3"},{"status":"succeeded","stdout":"ok 4"}],
        "review": [{"status":"succeeded","stdout":"FAIL"},{"status":"succeeded","stdout":"fine"},
                   {"status":"succeeded","stdout":"FAIL"},{"status":"succeeded","stdout":"fine"}],
        "fix": [{"status":"succeeded","stdout":"fixed 1"},{"status":"succeeded","stdout":"fixed 2"},
                {"status":"succeeded","stdout":"fixed 3"}],
        "push": [{"status":"succeeded","stdout":"pushed"}],
        "feedback:fix": [{"status":"succeeded","stdout":check_reply_text("change")}]
    }}))
    .expect("options");
    let id = "fb-fix-exit";
    start(&h, &wf, id, options).await.expect("run");
    h.engine
        .approve_run(id, true, None, wf.clone())
        .await
        .expect("first approval");
    assert_eq!(run_status(&h, id), RunStatus::Paused, "second approval");
    h.engine
        .submit_feedback(id, "fix", None, "Keep the old function name.")
        .expect("submit");
    // The review passes and the push waits for the feedback: the fix is
    // corrected, the loop goes round again and the approval is asked again.
    h.engine
        .approve_run(id, true, None, wf.clone())
        .await
        .expect("second approval");
    assert_eq!(run_status(&h, id), RunStatus::Paused, "third approval");
    assert_eq!(outputs(&h, id, "fix"), ["fixed 1", "fixed 2"]);
    assert!(outputs(&h, id, "push").is_empty());
    // The earlier review's pass no longer decides the push: the review runs
    // again first, finds a problem, and the loop goes round once more.
    h.engine
        .approve_run(id, true, None, wf.clone())
        .await
        .expect("third approval");
    assert!(
        outputs(&h, id, "push").is_empty(),
        "published before the review decided again"
    );
    assert_eq!(run_status(&h, id), RunStatus::Paused, "fourth approval");
    assert_eq!(outputs(&h, id, "fix"), ["fixed 1", "fixed 2", "fixed 3"]);
    h.engine
        .approve_run(id, true, None, wf.clone())
        .await
        .expect("fourth approval");
    assert_eq!(run_status(&h, id), RunStatus::Succeeded);
    assert_eq!(outputs(&h, id, "push"), ["pushed"]);
    let rows = h.db.list_node_results(id).expect("rows");
    assert_eq!(
        rows.iter().filter(|r| r.node_id == "end").count(),
        1,
        "the end ran once, after the loop: {rows:#?}"
    );
}

#[tokio::test]
async fn a_skipped_step_that_only_reads_the_corrected_work_stays_skipped() {
    let h = harness("change");
    let wf = Workflow::from_json(
        &json!({"schemaVersion":6,"id":"wf-notes","name":"Notes",
        "nodes":[
          {"id":"start","type":"start"},
          {"id":"impl","type":"agent","config":{"agentProfileId":"fake","prompt":"Change it."}},
          {"id":"tests","type":"command","config":{"executable":"never-runs","args":[]}},
          {"id":"approve","type":"approval"},
          {"id":"push","type":"command","config":{"executable":"never-runs","args":[],"publishes":true}},
          {"id":"lint","type":"command","config":{"executable":"never-runs","args":[]}},
          {"id":"cond","type":"condition","config":{"condition":{"logic":"and","clauses":[{"left":"node.lint.output","op":"contains","right":"DIRTY"}]}}},
          {"id":"notes","type":"command","config":{"executable":"never-runs","args":["{{node.impl.output}}"]}},
          {"id":"end","type":"end"}],
        "edges":[
          {"id":"e1","source":"start","target":"impl"},
          {"id":"e2","source":"impl","target":"tests"},
          {"id":"e3","source":"tests","target":"approve"},
          {"id":"e4","source":"approve","target":"push"},
          {"id":"e5","source":"push","target":"end"},
          {"id":"e6","source":"start","target":"lint"},
          {"id":"e7","source":"lint","target":"cond"},
          {"id":"e8","source":"cond","target":"notes","label":"true"},
          {"id":"e9","source":"notes","target":"end"},
          {"id":"e10","source":"cond","target":"end","label":"false"}]})
        .to_string(),
    )
    .expect("workflow");
    let options: RunOptions = serde_json::from_value(json!({"dryRun": true, "fixtures": {
        "impl": [{"status":"succeeded","stdout":"v1"},{"status":"succeeded","stdout":"v2"}],
        "tests": [{"status":"succeeded","stdout":"ok 1"},{"status":"succeeded","stdout":"ok 2"}],
        "lint": [{"status":"succeeded","stdout":"clean"}],
        "notes": [{"status":"succeeded","stdout":"notes"}],
        "push": [{"status":"succeeded","stdout":"pushed"}],
        "feedback:impl": [{"status":"succeeded","stdout":check_reply_text("change")}]
    }}))
    .expect("options");
    let id = "fb-notes";
    start(&h, &wf, id, options).await.expect("run");
    assert_eq!(run_status(&h, id), RunStatus::Paused, "at the approval");
    assert_eq!(
        status_of(&h.db.list_node_results(id).expect("rows"), "notes").as_deref(),
        Some("skipped")
    );
    h.engine
        .submit_feedback(id, "impl", None, "Keep old keys.")
        .expect("submit");
    h.engine
        .approve_run(id, true, None, wf.clone())
        .await
        .expect("approve");
    assert_eq!(
        run_status(&h, id),
        RunStatus::Paused,
        "approval asked again"
    );
    h.engine
        .approve_run(id, true, None, wf.clone())
        .await
        .expect("approve again");
    let rows = h.db.list_node_results(id).expect("rows");
    assert_eq!(run_status(&h, id), RunStatus::Succeeded, "{rows:#?}");
    assert_eq!(outputs(&h, id, "impl"), ["v1", "v2"]);
    assert_eq!(outputs(&h, id, "push"), ["pushed"]);
    assert!(outputs(&h, id, "notes").is_empty());
}

#[tokio::test]
async fn a_recovered_run_that_reuses_a_publication_starts_past_its_cutoff() {
    let h = harness("change");
    let flag = h.dir.path().join("check-passes");
    let wf = Workflow::from_json(
        &json!({"schemaVersion":6,"id":"wf-post","name":"Post",
        "nodes":[
          {"id":"start","type":"start"},
          {"id":"a","type":"agent","label":"Review","config":{"agentProfileId":"fake","prompt":"Review it."}},
          {"id":"post","type":"command","label":"Post comment","config":{"executable":"echo","args":["posted"],"publishes":true}},
          {"id":"c","type":"command","label":"Check","config":{"executable":"sh","args":["-c",format!("test -f '{}' && sleep 1", flag.display())]}},
          {"id":"end","type":"end"}],
        "edges":[
          {"id":"e1","source":"start","target":"a"},
          {"id":"e2","source":"a","target":"post"},
          {"id":"e3","source":"post","target":"c"},
          {"id":"e4","source":"c","target":"end"}]})
        .to_string(),
    )
    .expect("workflow");
    start(&h, &wf, "fb-post", RunOptions::default())
        .await
        .expect("run");
    assert_eq!(run_status(&h, "fb-post"), RunStatus::Failed);
    std::fs::write(&flag, "").expect("flag");
    let reuse = crate::run_controls::RecoveryChoice::Reuse;
    let choices: std::collections::HashMap<String, crate::run_controls::RecoveryChoice> = [
        ("a".to_string(), reuse),
        ("post".to_string(), reuse),
        ("c".to_string(), crate::run_controls::RecoveryChoice::Replay),
    ]
    .into_iter()
    .collect();
    let plan = h.engine.preview_recovery("fb-post").expect("plan");
    let id = h
        .engine
        .recover_run(
            "fb-post",
            "fb-post-2",
            &choices,
            &plan.fingerprint,
            "req-post",
        )
        .expect("recover");
    // The failed run already posted: feedback on the recovered run can no
    // longer change what was published.
    let started = h.db.get_run(&id).expect("get").expect("run");
    assert_eq!(
        started
            .execution
            .feedback
            .publication_started
            .map(|p| p.node_id)
            .as_deref(),
        Some("post")
    );
    let snapshot = h.db.get_run_workflow(&id).expect("wf").expect("snapshot");
    let engine = Arc::clone(&h.engine);
    let task = tokio::spawn({
        let id = id.clone();
        async move { engine.execute(snapshot, id).await }
    });
    wait_until(&h, &id, "the check running", |rows| {
        status_of(rows, "c").as_deref() == Some("running")
    })
    .await;
    let item = h
        .engine
        .submit_feedback(&id, "a", None, "Mention the old path.")
        .expect("submit");
    assert_eq!(item.status, feedback::LATE);
    task.await.expect("run");
    assert_eq!(run_status(&h, &id), RunStatus::Succeeded);
    let rows = h.db.list_node_results(&id).expect("rows");
    let posts: Vec<_> = rows.iter().filter(|r| r.node_id == "post").collect();
    assert_eq!(posts.len(), 1, "{rows:#?}");
    assert!(metadata(posts[0]).get("reusedFrom").is_some());
}

#[tokio::test]
async fn held_publishing_steps_never_crowd_out_the_correction_they_wait_for() {
    let h = harness("change");
    // Four publishing steps, listed first, are ready together with the
    // corrected step; they fill the four parallel slots if counted first.
    let mut nodes = vec![json!({"id":"start","type":"start"})];
    let mut edges = vec![
        json!({"id":"sa","source":"start","target":"a"}),
        json!({"id":"sb","source":"start","target":"b"}),
        json!({"id":"aq","source":"a","target":"approve"}),
        json!({"id":"qe","source":"approve","target":"end"}),
    ];
    for n in 1..=4 {
        nodes.push(json!({"id":format!("p{n}"),"type":"command","config":{"executable":"never-runs","args":[],"publishes":true}}));
        edges.push(json!({"id":format!("bp{n}"),"source":"b","target":format!("p{n}")}));
        edges.push(json!({"id":format!("pe{n}"),"source":format!("p{n}"),"target":"end"}));
    }
    nodes.extend([
        json!({"id":"a","type":"agent","config":{"agentProfileId":"fake","prompt":"A"}}),
        json!({"id":"b","type":"command","config":{"executable":"never-runs","args":[]}}),
        json!({"id":"approve","type":"approval"}),
        json!({"id":"end","type":"end"}),
    ]);
    let wf = Workflow::from_json(
        &json!({"schemaVersion":6,"id":"wf-crowd","name":"Crowd","nodes":nodes,"edges":edges})
            .to_string(),
    )
    .expect("workflow");
    let ok = |s: &str| json!({"status":"succeeded","stdout":s});
    let options: RunOptions = serde_json::from_value(json!({"dryRun": true, "fixtures": {
        "a": [ok("v1"), ok("v2")],
        "b": [ok("b")],
        "p1": [ok("1")], "p2": [ok("2")], "p3": [ok("3")], "p4": [ok("4")],
        "feedback:a": [ok(&check_reply_text("change"))]
    }}))
    .expect("options");
    let id = "fb-crowd";
    start(&h, &wf, id, options).await.expect("run");
    assert_eq!(run_status(&h, id), RunStatus::Paused, "at the approval");
    h.engine
        .submit_feedback(id, "a", None, "Keep old keys.")
        .expect("submit");
    h.engine
        .approve_run(id, true, None, wf.clone())
        .await
        .expect("approve");
    let items = h.db.list_feedback(id).expect("feedback");
    assert_eq!(items[0].status, feedback::ADDRESSED, "{items:#?}");
    assert_eq!(outputs(&h, id, "a"), ["v1", "v2"]);
    let rows = h.db.list_node_results(id).expect("rows");
    let corrected = rows.iter().find(|r| r.stdout == "v2").expect("v2");
    assert!(metadata(corrected)["correction"]["feedbackIds"].is_array());
    assert!(
        outputs(&h, id, "p1").is_empty(),
        "published before the correction"
    );
    assert_eq!(
        run_status(&h, id),
        RunStatus::Paused,
        "the approval is asked again"
    );
}
