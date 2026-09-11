//! Two-level scan (DESIGN.md §3.1): repository-level queries answer everything that only
//! depends on refs; one status query per worktree answers the rest.

use crate::git::{parse, Git, GitError};
use crate::model::*;
use std::collections::{HashMap, HashSet};
use std::path::Path;

pub struct RepoScan { pub project: Project, pub worktrees: Vec<Worktree> }

pub async fn resolve_main_ref(git: &Git, repo: &Path) -> Option<String> {
    if let Ok(out) = git.run(repo, &["symbolic-ref", "-q", "refs/remotes/origin/HEAD"]).await {
        if out.code == 0 {
            let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
            return Some(s.strip_prefix("refs/remotes/").unwrap_or(&s).to_string());
        }
    }
    for name in ["main", "master"] {
        if let Ok(out) = git.run(repo, &["rev-parse", "--verify", "-q", &format!("refs/heads/{name}")]).await {
            if out.code == 0 { return Some(name.to_string()); }
        }
    }
    None
}

/// Local branch name that the main ref points at ("origin/master" -> "master").
fn main_local_name(main_ref: &str) -> &str {
    main_ref.strip_prefix("origin/").unwrap_or(main_ref)
}

pub async fn scan_repo(git: &Git, repo: &Path) -> Result<RepoScan, GitError> {
    let entries = parse::parse_worktree_list(&git.run_ok(repo, &["worktree", "list", "--porcelain"]).await?);
    let main_ref = resolve_main_ref(git, repo).await;
    let refs: HashMap<String, parse::RefInfo> = parse::parse_ref_info(
        &git.run_ok(repo, &["for-each-ref", "--format=%(refname:short)%09%(committerdate:unix)%09%(upstream:short)%09%(upstream:track)", "refs/heads/"]).await?);
    let merged: HashSet<String> = match &main_ref {
        Some(m) => parse::parse_ref_names(
            &git.run_ok(repo, &["for-each-ref", "--merged", m, "--format=%(refname:short)", "refs/heads/"]).await?),
        None => HashSet::new(),
    };
    let repo_str = repo.to_string_lossy().into_owned();
    let mut worktrees = Vec::new();
    for (i, e) in entries.into_iter().enumerate() {
        if e.bare { continue; }
        let (merged_flag, last_commit, upstream) = match &e.branch {
            Some(b) => {
                let is_main = main_ref.as_deref().map(|m| main_local_name(m) == b).unwrap_or(false);
                let m = if is_main { None } else { main_ref.as_ref().map(|_| merged.contains(b)) };
                let info = refs.get(b);
                (m, info.map(|i| i.time), info.map(|i| i.upstream.clone()).unwrap_or(Upstream::None))
            }
            None => (detached_merged(git, repo, &e.head, main_ref.as_deref()).await, detached_time(git, repo, &e.head).await, Upstream::None),
        };
        worktrees.push(Worktree {
            project: repo_str.clone(), path: e.path, primary: i == 0, branch: e.branch, head: e.head, upstream,
            locked: e.locked, prunable: e.prunable, merged: merged_flag, last_commit,
        });
    }
    let name = repo.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| repo_str.clone());
    Ok(RepoScan { project: Project { path: repo_str, name, main_ref }, worktrees })
}

async fn detached_time(git: &Git, repo: &Path, head: &str) -> Option<i64> {
    let out = git.run(repo, &["log", "-1", "--format=%ct", head]).await.ok()?;
    if out.code != 0 { return None; }
    String::from_utf8_lossy(&out.stdout).trim().parse().ok()
}

async fn detached_merged(git: &Git, repo: &Path, head: &str, main_ref: Option<&str>) -> Option<bool> {
    let m = main_ref?;
    let out = git.run(repo, &["merge-base", "--is-ancestor", head, m]).await.ok()?;
    match out.code { 0 => Some(true), 1 => Some(false), _ => None }
}

pub async fn worktree_status(git: &Git, wt: &Path) -> Result<WorktreeStatus, GitError> {
    let out = git.run_ok(wt, &["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=normal"]).await?;
    let s = parse::parse_status_v2(&out);
    Ok(WorktreeStatus { counts: s.counts, untracked: s.untracked })
}
