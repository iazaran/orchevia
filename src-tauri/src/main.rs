//! Orchevia desktop entry point.

mod commands;

use commands::AppState;
use orchevia_core::db::SqliteDb;
use std::sync::Arc;
use tauri::Manager;

fn default_db_path(app_handle: &tauri::AppHandle) -> std::path::PathBuf {
    app_handle
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir().join("orchevia"))
        .join("orchevia.db")
}

/// Generate a small tray icon (accent dot on dark rounded square), so no
/// binary asset is needed for the tray.
fn tray_icon() -> tauri::image::Image<'static> {
    const SIZE: u32 = 32;
    let mut rgba = vec![0u8; (SIZE * SIZE * 4) as usize];
    for y in 0..SIZE {
        for x in 0..SIZE {
            let dx = x as f32 - 15.5;
            let dy = y as f32 - 15.5;
            let dist = (dx * dx + dy * dy).sqrt();
            let idx = ((y * SIZE + x) * 4) as usize;
            if dist <= 13.0 {
                // Warm accent dot.
                rgba[idx] = 0x60;
                rgba[idx + 1] = 0xa5;
                rgba[idx + 2] = 0xfa;
                rgba[idx + 3] = 0xff;
            } else {
                rgba[idx + 3] = 0x00;
            }
        }
    }
    tauri::image::Image::new_owned(rgba, SIZE, SIZE)
}

fn background_mode(db: &SqliteDb) -> bool {
    db.get_setting("background.mode")
        .ok()
        .flatten()
        .map(|v| v == "1")
        .unwrap_or(false)
}

/// Bring the main window back (relaunch, tray menu, macOS dock click).
fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn main() {
    let app = tauri::Builder::default()
        // First: a second launch (app menu, dock, desktop file) shows the
        // running window instead of starting another app and scheduler.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            show_main_window(app);
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let db_path = default_db_path(app.handle());
            let db = SqliteDb::open(&db_path).unwrap_or_else(|e| {
                eprintln!("Failed to open database at {}: {e}", db_path.display());
                std::process::exit(1);
            });
            // Runs left in `running` state by a previous session (crash or
            // quit mid-run) can never resume safely: the child processes are
            // gone. Mark them failed so history stays truthful.
            if let Ok(runs) = db.list_runs(1000) {
                for run in runs
                    .iter()
                    .filter(|r| matches!(r.status, orchevia_core::db::RunStatus::Running))
                {
                    let _ = db.fail_running_node_results(
                        &run.id,
                        "Application restarted while this node was in progress.",
                    );
                    let _ = db.record_node_result(orchevia_core::db::NewNodeResult::simple(
                        &run.id,
                        "run",
                        "failed",
                        None,
                        Some("Application restarted while this run was in progress."),
                    ));
                    let _ = db.finish_run(&run.id, orchevia_core::db::RunStatus::Failed);
                }
            }
            let db = Arc::new(db);
            // First-run onboarding: seed a safe sample workflow so a fresh
            // install opens with something runnable (uname/echo only).
            if let Ok(existing) = db.list_workflows() {
                if existing.is_empty() {
                    let _ = db.upsert_workflow(&orchevia_core::workflow::sample_workflow());
                }
            }
            let state = AppState::new(Arc::clone(&db));
            // Manual controls and automation must address the same active runs.
            let starter: Arc<dyn orchevia_core::scheduler::RunStarter> =
                Arc::new(state.scheduler_starter());
            let scheduler_wake = Arc::clone(&state.scheduler_wake);
            let tray_available = Arc::clone(&state.tray_available);
            app.manage(state);
            // The tray probe may wait on the session bus; keep it off the UI
            // thread.
            tauri::async_runtime::spawn_blocking(move || {
                let _ = tray_available.set(orchevia_core::desktop::tray_available());
            });

            // Background scheduler: schedules + watchers, conservative poll.
            let scheduler_db = Arc::clone(&db);
            tauri::async_runtime::spawn(async move {
                // Resolve the login shell PATH once, off the main thread, before
                // automation can start CLIs. Lookups made meanwhile use the
                // fallback PATH; tool detection waits for this resolution.
                let _ = tauri::async_runtime::spawn_blocking(
                    orchevia_core::tools::refresh_search_environment,
                )
                .await;
                let scheduler = orchevia_core::scheduler::Scheduler::new(scheduler_db);
                let mut previous: Option<(chrono::DateTime<chrono::Utc>, std::time::Instant)> =
                    None;
                loop {
                    // Evaluate persisted due slots before advancing them. This
                    // also checks enabled watchers immediately on launch/save.
                    // Slots that came due since the previous check run even if
                    // noticed late; the missed-run policy covers only time the
                    // app was closed or the computer slept.
                    let now = chrono::Utc::now();
                    let window = orchevia_core::schedule::check_window(
                        previous.map(|(wall, _)| wall),
                        previous
                            .map(|(_, instant)| instant.elapsed())
                            .unwrap_or_default(),
                        now,
                    );
                    previous = Some((now, std::time::Instant::now()));
                    let notes = scheduler.tick(&starter, now, window).await;
                    for note in notes {
                        eprintln!("[scheduler] {note}");
                    }
                    // Sleep until the next slot or watcher poll (at most a
                    // minute); saves wake the loop at once.
                    let wait = scheduler.next_wait(chrono::Utc::now());
                    tokio::select! {
                        _ = tokio::time::sleep(wait) => {},
                        _ = scheduler_wake.notified() => {},
                    }
                }
            });

            // System tray: explicit background presence with Show/Quit.
            // No hidden daemon is ever installed; the tray exists only while
            // the app runs, and closing the window quits unless the user
            // opted into background mode in Settings.
            let handle = app.handle();
            let show = tauri::menu::MenuItem::with_id(
                handle,
                "show",
                "Show Orchevia",
                true,
                None::<&str>,
            )?;
            let quit = tauri::menu::MenuItem::with_id(
                handle,
                "quit",
                "Quit Orchevia",
                true,
                None::<&str>,
            )?;
            let menu = tauri::menu::Menu::with_items(handle, &[&show, &quit])?;
            let _tray = tauri::tray::TrayIconBuilder::new()
                .icon(tray_icon())
                .tooltip("Orchevia — local workflow automation")
                .menu(&menu)
                .show_menu_on_left_click(true)
                .on_menu_event(|app_handle, event| match event.id.as_ref() {
                    "show" => show_main_window(app_handle),
                    "quit" => app_handle.exit(0),
                    _ => {}
                })
                .build(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let state = window.state::<AppState>();
                if background_mode(&state.db) {
                    // Background mode: hide instead of quitting so
                    // schedules/watchers keep running. Quit via the tray menu
                    // or Automations → Background mode.
                    api.prevent_close();
                    let _ = window.hide();
                    eprintln!("[orchevia] window hidden (background mode on)");
                    // Without a tray icon nothing shows the app is still
                    // running: say so once per session, and how to get back.
                    let no_tray = state.tray_available.get().copied().flatten() == Some(false);
                    if no_tray
                        && !state
                            .background_notice_shown
                            .swap(true, std::sync::atomic::Ordering::Relaxed)
                    {
                        std::thread::spawn(|| {
                            orchevia_core::notify::dispatch_os(
                                "Orchevia is still running",
                                "Schedules and watchers keep running. Open Orchevia from your app menu to show it again; quit from Automations → Background mode.",
                            );
                        });
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::encode_workflow_document,
            commands::decode_workflow_document,
            commands::list_workflows,
            commands::get_workflow,
            commands::save_workflow,
            commands::delete_workflow,
            commands::validate_workflow_cmd,
            commands::detect_tools,
            commands::run_workflow,
            commands::preview_recovery,
            commands::recover_run,
            commands::continue_spend_run,
            commands::continue_usage_run,
            commands::usage_summary,
            commands::adapter_capabilities,
            commands::approve_run,
            commands::cancel_run,
            commands::list_runs,
            commands::get_run,
            commands::get_run_workflow,
            commands::get_run_results,
            commands::delete_run,
            commands::clear_finished_runs,
            commands::preview_command,
            commands::list_adapters,
            commands::list_agent_profiles,
            commands::list_agent_skills,
            commands::save_agent_profile,
            commands::delete_agent_profile,
            commands::preview_agent_command,
            commands::check_agent_setup,
            commands::install_update,
            commands::list_known_folders,
            commands::git_current_branch,
            commands::git_branches,
            commands::github_state,
            commands::list_mcp_servers,
            commands::save_mcp_server,
            commands::delete_mcp_server,
            commands::mcp_list_tools,
            commands::mcp_env_present,
            commands::mcp_preview,
            commands::list_schedules,
            commands::save_schedule,
            commands::delete_schedule,
            commands::fire_schedule_now,
            commands::schedule_preview,
            commands::desktop_info,
            commands::quit_app,
            commands::open_external_url,
            commands::record_update_notice,
            commands::list_watchers,
            commands::save_watcher,
            commands::watcher_scope_issues,
            commands::delete_watcher,
            commands::workflow_risks,
            commands::get_run_findings,
            commands::list_notifications,
            commands::mark_notification_read,
            commands::mark_all_notifications_read,
            commands::get_notification_prefs,
            commands::set_notification_prefs,
            commands::list_custom_models,
            commands::save_custom_models,
            commands::get_setting,
            commands::set_setting,
            commands::diagnostics_bundle,
            commands::role_map_default,
            commands::list_templates,
            commands::save_user_template,
            commands::save_workflow_as_template,
            commands::delete_user_template,
            commands::export_template,
            commands::import_template,
            commands::instantiate_template,
            commands::generate_workflow,
            commands::mark_generation_status,
            commands::list_generations,
            commands::get_project_memory_context,
            commands::save_project_preference,
            commands::list_preferences,
            commands::save_preference,
            commands::delete_preference,
            commands::reset_memory,
            commands::export_memory,
            commands::import_memory,
            commands::observe_edits,
        ])
        .build(tauri::generate_context!());
    match app {
        Ok(app) => app.run(|_handle, event| match event {
            tauri::RunEvent::Exit => {
                // Stop CLI process trees that are still running on quit.
                orchevia_core::process::terminate_all_process_groups();
            }
            // Dock click while the window is hidden in background mode.
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Reopen {
                has_visible_windows: false,
                ..
            } => show_main_window(_handle),
            _ => {}
        }),
        Err(error) => {
            eprintln!("Failed to start Orchevia: {error}");
            std::process::exit(1);
        }
    }
}
