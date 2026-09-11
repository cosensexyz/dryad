//! Tauri command layer: thin argument validation + error-to-string mapping. No git logic here.

use crate::differ;
use crate::git::{parse, Git};
use crate::model::*;
use crate::registry::{toplevel, Registry};
use crate::scanner::{self, EventSink};
use crate::settings::Settings;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, State};

pub struct AppState {
    pub git: Arc<Git>,
    pub git_error: Option<String>,
    pub registry: Mutex<Registry>,
    pub registry_warning: Option<String>,
    pub settings: Mutex<Settings>,
    pub settings_file: PathBuf,
    pub generation: AtomicU64,
}

impl EventSink for AppHandle {
    fn emit(&self, event: &str, payload: serde_json::Value) { let _ = Emitter::emit(self, event, payload); }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartupInfo { pub git_error: Option<String>, pub registry_warning: Option<String>, pub stale_days: u32 }

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileListDto { pub files: Vec<DiffFile>, pub truncated: bool }

fn git_ready(state: &AppState) -> Result<Arc<Git>, String> {
    match &state.git_error { Some(e) => Err(e.clone()), None => Ok(state.git.clone()) }
}

/// A worktree may only be queried if its project is registered and git lists that path for it.
/// Returns the project's primary worktree path (first entry) for branch-level queries.
async fn ensure_worktree(state: &AppState, project: &str, worktree: &str) -> Result<PathBuf, String> {
    if !state.registry.lock().unwrap().contains(project) { return Err(format!("project not registered: {project}")); }
    let git = git_ready(state)?;
    let out = git.run_ok(Path::new(project), &["worktree", "list", "--porcelain"]).await.map_err(|e| e.to_string())?;
    let entries = parse::parse_worktree_list(&out);
    if !entries.iter().any(|e| e.path == worktree) { return Err(format!("not a worktree of {project}: {worktree}")); }
    entries.first().map(|e| PathBuf::from(&e.path)).ok_or_else(|| "project has no worktrees".to_string())
}

#[tauri::command]
pub async fn startup_info(state: State<'_, AppState>) -> Result<StartupInfo, String> {
    Ok(StartupInfo {
        git_error: state.git_error.clone(),
        registry_warning: state.registry_warning.clone(),
        stale_days: state.settings.lock().unwrap().stale_days,
    })
}

#[tauri::command]
pub async fn list_projects(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    Ok(state.registry.lock().unwrap().projects().to_vec())
}

fn spawn_scan(app: AppHandle, state: &AppState, projects: Vec<String>, full: bool) -> u64 {
    let generation = state.generation.fetch_add(1, Ordering::SeqCst) + 1;
    let git = state.git.clone();
    tauri::async_runtime::spawn(async move {
        scanner::scan(git, Arc::new(app), generation, projects, full).await;
    });
    generation
}

#[tauri::command]
pub async fn scan_all(app: AppHandle, state: State<'_, AppState>) -> Result<u64, String> {
    git_ready(&state)?;
    let projects = state.registry.lock().unwrap().projects().to_vec();
    Ok(spawn_scan(app, &state, projects, true))
}

#[tauri::command]
pub async fn add_project(app: AppHandle, state: State<'_, AppState>, dir: String) -> Result<String, String> {
    let git = git_ready(&state)?;
    let top = toplevel(&git, Path::new(&dir)).await.map_err(|e| e.to_string())?;
    state.registry.lock().unwrap().add(&top).map_err(|e| e.to_string())?;
    spawn_scan(app, &state, vec![top.clone()], false);
    Ok(top)
}

#[tauri::command]
pub async fn remove_project(state: State<'_, AppState>, path: String) -> Result<(), String> {
    state.registry.lock().unwrap().remove(&path).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn worktree_status_now(state: State<'_, AppState>, project: String, path: String) -> Result<WorktreeStatus, String> {
    ensure_worktree(&state, &project, &path).await?;
    scanner::worktree_status(&state.git, Path::new(&path)).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn diff_files(state: State<'_, AppState>, project: String, worktree: String, head: String, tab: DiffTab,
                        main_ref: Option<String>, untracked: Vec<String>) -> Result<FileListDto, String> {
    let primary = ensure_worktree(&state, &project, &worktree).await?;
    let max = state.settings.lock().unwrap().files_max;
    let l = match tab {
        DiffTab::WorkingTree => differ::working_tree_files(&state.git, Path::new(&worktree), &untracked, max).await,
        DiffTab::Branch => {
            let m = main_ref.ok_or("no main ref for this project")?;
            differ::branch_files(&state.git, &primary, &m, &head, max).await
        }
    }.map_err(|e| e.to_string())?;
    Ok(FileListDto { files: l.files, truncated: l.truncated })
}

#[tauri::command]
pub async fn diff_patch(state: State<'_, AppState>, project: String, worktree: String, head: String, tab: DiffTab,
                        main_ref: Option<String>, path: String, old_path: Option<String>, staged: bool) -> Result<Patch, String> {
    let primary = ensure_worktree(&state, &project, &worktree).await?;
    let max = state.settings.lock().unwrap().patch_max_lines;
    match tab {
        DiffTab::WorkingTree => differ::working_tree_patch(&state.git, Path::new(&worktree), &path, old_path.as_deref(), staged, max).await,
        DiffTab::Branch => {
            let m = main_ref.ok_or("no main ref for this project")?;
            differ::branch_patch(&state.git, &primary, &m, &head, &path, old_path.as_deref(), max).await
        }
    }.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn set_stale_days(state: State<'_, AppState>, days: u32) -> Result<u32, String> {
    let mut s = state.settings.lock().unwrap();
    s.stale_days = days.max(1);
    s.save(&state.settings_file).map_err(|e| e.to_string())?;
    Ok(s.stale_days)
}
