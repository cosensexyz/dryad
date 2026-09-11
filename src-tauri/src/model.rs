use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub path: String,
    pub name: String,
    pub main_ref: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Worktree {
    pub project: String,
    pub path: String,
    pub primary: bool,
    pub branch: Option<String>,
    pub head: String,
    pub upstream: Upstream,
    pub locked: Option<String>,
    pub prunable: Option<String>,
    pub merged: Option<bool>,
    pub last_commit: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Counts {
    pub staged: u32,
    pub unstaged: u32,
    pub untracked: u32,
}

/// Reference-level: known from `for-each-ref` even when the working directory is gone.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Upstream {
    Tracking { name: String, ahead: u32, behind: u32 },
    None,
    Gone { name: String },
}

/// Working-directory-level: the only data that needs the checkout to exist.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeStatus {
    pub counts: Counts,
    pub untracked: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Change { Modified, Added, Deleted, Renamed, Untracked }

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffFile {
    pub path: String,
    pub old_path: Option<String>,
    pub change: Change,
    pub staged: bool,
    pub added: u32,
    pub deleted: u32,
    pub binary: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DiffLine { pub sign: char, pub text: String }

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Hunk { pub header: String, pub old_start: u32, pub new_start: u32, pub lines: Vec<DiffLine> }

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Patch { pub path: String, pub hunks: Vec<Hunk>, pub truncated: bool, pub binary: bool }

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DiffTab { WorkingTree, Branch }

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn upstream_is_tagged_with_kind() {
        let v = serde_json::to_value(Upstream::Tracking { name: "origin/x".into(), ahead: 2, behind: 0 }).unwrap();
        assert_eq!(v["kind"], "tracking");
        assert_eq!(v["ahead"], 2);
        let v = serde_json::to_value(Upstream::None).unwrap();
        assert_eq!(v["kind"], "none");
    }

    #[test]
    fn worktree_uses_camel_case_and_nullable_fields() {
        let wt = Worktree { project: "/p".into(), path: "/p".into(), primary: true, branch: None, head: "abc".into(),
            upstream: Upstream::None, locked: None, prunable: None, merged: None, last_commit: Some(1) };
        let v = serde_json::to_value(&wt).unwrap();
        assert!(v["lastCommit"].is_number());
        assert!(v["branch"].is_null());
        let back: Worktree = serde_json::from_value(v).unwrap();
        assert_eq!(back, wt);
    }

    #[test]
    fn diff_tab_serializes_as_camel_case_string() {
        assert_eq!(serde_json::to_value(DiffTab::WorkingTree).unwrap(), "workingTree");
        assert_eq!(serde_json::from_value::<DiffTab>(serde_json::json!("branch")).unwrap(), DiffTab::Branch);
    }
}
