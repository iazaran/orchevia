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
    printf '%s\n' '{"type":"result","is_error":false,"result":"ORIGINAL","usage":{"input_tokens":1}}' ;;
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
