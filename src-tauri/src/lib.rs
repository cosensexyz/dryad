pub mod commands;
pub mod differ;
pub mod git;
pub mod model;
pub mod registry;
pub mod scanner;
pub mod settings;

use std::sync::atomic::AtomicU64;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let config_dir = app.path().app_config_dir()?;
            let settings_file = config_dir.join("settings.json");
            let settings = settings::Settings::load(&settings_file);
            let (registry, registry_warning) = registry::Registry::load(config_dir.join("projects.json"));
            let (exe, git_error) = match git::locate() {
                Ok(p) => (p, None),
                Err(e) => (std::path::PathBuf::from("git"), Some(e.to_string())),
            };
            let git = Arc::new(git::Git::new(exe, Duration::from_secs(settings.timeout_secs), settings.concurrency));
            app.manage(commands::AppState {
                git, git_error,
                registry: Mutex::new(registry), registry_warning,
                settings: Mutex::new(settings), settings_file,
                generation: AtomicU64::new(0),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::startup_info, commands::list_projects, commands::add_project, commands::remove_project,
            commands::scan_all, commands::worktree_status_now, commands::diff_files, commands::diff_patch,
            commands::set_stale_days,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
