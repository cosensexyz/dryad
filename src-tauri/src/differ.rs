//! On-demand diff queries (DESIGN.md §3.2): cheap file lists first, one patch per selected file.

use crate::git::{parse, Git, GitError};
use crate::model::*;
use std::collections::HashMap;
use std::path::Path;

#[derive(Debug, thiserror::Error)]
pub enum DiffError {
    #[error(transparent)]
    Git(#[from] GitError),
    #[error("diff unavailable: {0}")]
    Unavailable(String),
}

#[derive(Debug, Clone, PartialEq)]
pub struct FileList { pub files: Vec<DiffFile>, pub truncated: bool }

const COMMON: &[&str] = &["--no-color", "--no-ext-diff", "--find-renames"];

fn change_of(status: char) -> Change {
    match status { 'A' => Change::Added, 'D' => Change::Deleted, 'R' | 'C' => Change::Renamed, _ => Change::Modified }
}

/// Run `git diff <scope> --name-status -z` and `--numstat -z`, merge by path.
async fn list(git: &Git, dir: &Path, scope: &[&str], staged: bool) -> Result<Vec<DiffFile>, DiffError> {
    let mut a: Vec<&str> = vec!["diff"]; a.extend(COMMON); a.extend(scope); a.extend(["--name-status", "-z"]);
    let names = parse::parse_name_status(&git.run_ok(dir, &a).await?);
    let mut b: Vec<&str> = vec!["diff"]; b.extend(COMMON); b.extend(scope); b.extend(["--numstat", "-z"]);
    let nums: HashMap<String, parse::NumStat> = parse::parse_numstat(&git.run_ok(dir, &b).await?)
        .into_iter().map(|n| (n.path.clone(), n)).collect();
    Ok(names.into_iter().map(|n| {
        let st = nums.get(&n.path);
        let binary = st.map(|s| s.added.is_none()).unwrap_or(false);
        DiffFile {
            path: n.path, old_path: n.old_path, change: change_of(n.status), staged,
            added: st.and_then(|s| s.added).unwrap_or(0), deleted: st.and_then(|s| s.deleted).unwrap_or(0), binary,
        }
    }).collect())
}

fn cap(mut files: Vec<DiffFile>, max: usize) -> FileList {
    let truncated = files.len() > max;
    files.truncate(max);
    FileList { files, truncated }
}

pub async fn working_tree_files(git: &Git, wt: &Path, untracked: &[String], max_files: usize) -> Result<FileList, DiffError> {
    let mut files = list(git, wt, &["--cached"], true).await?;
    files.extend(list(git, wt, &[], false).await?);
    files.extend(untracked.iter().map(|p| DiffFile {
        path: p.clone(), old_path: None, change: Change::Untracked, staged: false, added: 0, deleted: 0, binary: false,
    }));
    Ok(cap(files, max_files))
}

pub async fn branch_files(git: &Git, primary: &Path, main_ref: &str, head: &str, max_files: usize) -> Result<FileList, DiffError> {
    let range = format!("{main_ref}...{head}");
    Ok(cap(list(git, primary, &[range.as_str()], false).await?, max_files))
}

async fn patch(git: &Git, dir: &Path, scope: &[&str], path: &str, old_path: Option<&str>, max_lines: usize) -> Result<Patch, DiffError> {
    let mut a: Vec<&str> = vec!["diff"]; a.extend(COMMON); a.extend(scope); a.push("--");
    a.push(path);
    if let Some(o) = old_path { a.push(o); }
    let text = String::from_utf8_lossy(&git.run_ok(dir, &a).await?).into_owned();
    let (hunks, truncated) = parse::parse_patch(&text, max_lines);
    Ok(Patch { path: path.to_string(), hunks, truncated })
}

pub async fn working_tree_patch(git: &Git, wt: &Path, path: &str, old_path: Option<&str>, staged: bool, max_lines: usize) -> Result<Patch, DiffError> {
    let scope: &[&str] = if staged { &["--cached"] } else { &[] };
    patch(git, wt, scope, path, old_path, max_lines).await
}

pub async fn branch_patch(git: &Git, primary: &Path, main_ref: &str, head: &str, path: &str, old_path: Option<&str>, max_lines: usize) -> Result<Patch, DiffError> {
    let range = format!("{main_ref}...{head}");
    patch(git, primary, &[range.as_str()], path, old_path, max_lines).await
}
