//! On-demand diff queries (DESIGN.md §3.2): cheap file lists first, one patch per selected file.

use crate::git::{parse, Git, GitError};
use crate::model::*;
use std::collections::HashMap;
use std::io::Read;
use std::path::{Component, Path};

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
    Ok(Patch { path: path.to_string(), hunks, truncated, binary: false })
}

pub async fn working_tree_patch(git: &Git, wt: &Path, path: &str, old_path: Option<&str>, staged: bool, max_lines: usize) -> Result<Patch, DiffError> {
    let scope: &[&str] = if staged { &["--cached"] } else { &[] };
    patch(git, wt, scope, path, old_path, max_lines).await
}

pub async fn branch_patch(git: &Git, primary: &Path, main_ref: &str, head: &str, path: &str, old_path: Option<&str>, max_lines: usize) -> Result<Patch, DiffError> {
    let range = format!("{main_ref}...{head}");
    patch(git, primary, &[range.as_str()], path, old_path, max_lines).await
}

/// Read a worktree file with the untracked-patch safety checks; at most `max_bytes + 1` bytes
/// so callers can tell whether the file was cut off.
fn read_worktree_file(wt: &Path, path: &str, max_bytes: u64) -> Result<(Vec<u8>, bool), DiffError> {
    let rel = Path::new(path);
    if rel.is_absolute() || rel.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err(DiffError::Unavailable(format!("path outside the worktree: {path}")));
    }
    let abs = wt.join(rel);
    let meta = std::fs::symlink_metadata(&abs).map_err(|e| DiffError::Unavailable(e.to_string()))?;
    if !meta.is_file() { return Err(DiffError::Unavailable(format!("not a regular file: {path}"))); }
    let root = wt.canonicalize().map_err(|e| DiffError::Unavailable(e.to_string()))?;
    let real = abs.canonicalize().map_err(|e| DiffError::Unavailable(e.to_string()))?;
    if !real.starts_with(&root) { return Err(DiffError::Unavailable(format!("path outside the worktree: {path}"))); }
    let mut bytes = Vec::new();
    std::fs::File::open(&real).map_err(|e| DiffError::Unavailable(e.to_string()))?
        .take(max_bytes + 1).read_to_end(&mut bytes).map_err(|e| DiffError::Unavailable(e.to_string()))?;
    let truncated = bytes.len() as u64 > max_bytes;
    bytes.truncate(max_bytes as usize);
    Ok((bytes, truncated))
}

/// Untracked files have no git diff: read the worktree file and render its lines as additions.
pub fn untracked_patch(wt: &Path, path: &str, max_lines: usize) -> Result<Patch, DiffError> {
    const MAX_BYTES: u64 = 1 << 20;
    let (bytes, byte_truncated) = read_worktree_file(wt, path, MAX_BYTES)?;
    if bytes.contains(&0) {
        return Ok(Patch { path: path.to_string(), hunks: vec![], truncated: byte_truncated, binary: true });
    }
    let text = String::from_utf8_lossy(&bytes);
    let mut lines: Vec<&str> = text.lines().collect();
    if byte_truncated && !text.ends_with('\n') { lines.pop(); }
    let truncated = byte_truncated || lines.len() > max_lines;
    lines.truncate(max_lines);
    let hunks = if lines.is_empty() { vec![] } else {
        vec![Hunk { header: format!("@@ -0,0 +1,{} @@", lines.len()), old_start: 0, old_count: 0, new_start: 1, new_count: lines.len() as u32,
            lines: lines.into_iter().map(|t| DiffLine { sign: '+', text: t.to_string() }).collect() }]
    };
    Ok(Patch { path: path.to_string(), hunks, truncated, binary: false })
}

/// Gap lines are unchanged, so the new side alone supplies them.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum ContextSource<'a> {
    /// The worktree file itself (unstaged changes).
    Worktree,
    /// The staged index blob (`:path`).
    Index,
    /// A blob in a commit (`rev:path`), e.g. the worktree HEAD for branch diffs.
    Commit(&'a str),
}

pub const MAX_CONTEXT_BYTES: u64 = 8 << 20;

fn relative(path: &str) -> bool {
    let p = Path::new(path);
    !p.is_absolute() && !p.components().any(|c| matches!(c, Component::ParentDir))
}

async fn blob_bytes(git: &Git, dir: &Path, spec: &str, max_bytes: u64) -> Result<Vec<u8>, DiffError> {
    let size = String::from_utf8_lossy(&git.run_ok(dir, &["cat-file", "-s", spec]).await?)
        .trim().parse::<u64>().map_err(|_| DiffError::Unavailable(format!("cannot size blob: {spec}")))?;
    if size > max_bytes { return Err(DiffError::Unavailable(format!("file too large to expand context: {spec}"))); }
    Ok(git.run_ok(dir, &["show", spec]).await?)
}

/// Read the requested 1-based line range of the new side, up to `max_lines` lines per response.
pub async fn context_lines(git: &Git, dir: &Path, source: ContextSource<'_>, path: &str,
                           start: u32, count: Option<u32>, max_lines: usize) -> Result<ContextLines, DiffError> {
    if !relative(path) { return Err(DiffError::Unavailable(format!("path outside the worktree: {path}"))); }
    let bytes = match source {
        ContextSource::Worktree => {
            let (bytes, truncated) = read_worktree_file(dir, path, MAX_CONTEXT_BYTES)?;
            if truncated { return Err(DiffError::Unavailable(format!("file too large to expand context: {path}"))); }
            bytes
        }
        ContextSource::Index => blob_bytes(git, dir, &format!(":{path}"), MAX_CONTEXT_BYTES).await?,
        ContextSource::Commit(rev) => blob_bytes(git, dir, &format!("{rev}:{path}"), MAX_CONTEXT_BYTES).await?,
    };
    let text = String::from_utf8_lossy(&bytes);
    let lines: Vec<&str> = text.lines().collect();
    let wanted = count.map(|c| c as usize).unwrap_or(max_lines).min(max_lines);
    let from = (start.saturating_sub(1) as usize).min(lines.len());
    let end = (from + wanted).min(lines.len());
    Ok(ContextLines { lines: lines[from..end].iter().map(|s| s.to_string()).collect(), total: lines.len() as u32 })
}
