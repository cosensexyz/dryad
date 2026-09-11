mod common;
use common::TempRepo;
use dryad_lib::git::Git;
use dryad_lib::model::*;
use dryad_lib::scanner::{resolve_main_ref, scan_repo, worktree_status};
use std::path::PathBuf;
use std::time::Duration;

fn git() -> Git { Git::new(dryad_lib::git::locate().unwrap(), Duration::from_secs(30), 4) }

/// master (primary) · feat/a: 1 unpushed commit on top of a pushed one, dirty (1 modified + 1 untracked)
/// · gone: pushed then remote branch deleted · done: merged into master · det: detached at master~1 and locked
#[allow(dead_code)]
struct Scenario { t: TempRepo, feat: PathBuf, gone: PathBuf, done: PathBuf, det: PathBuf, det_sha: String }

fn scenario() -> Scenario {
    let t = TempRepo::new();
    let feat = t.add_worktree("feat/a");
    t.commit(&feat, "a.txt", "a\n", "a1", Some(1_700_000_000));
    t.push_upstream(&feat, "feat/a");
    t.commit(&feat, "a.txt", "a2\n", "a2", Some(1_700_000_100));
    std::fs::write(feat.join("a.txt"), "dirty\n").unwrap();
    std::fs::write(feat.join("new.txt"), "x\n").unwrap();
    let gone = t.add_worktree("gone");
    t.commit(&gone, "g.txt", "g\n", "g", Some(1_600_000_000));
    t.push_upstream(&gone, "gone");
    t.delete_remote_branch("gone");
    let done = t.add_worktree("done");
    t.commit(&done, "d.txt", "d\n", "d", Some(1_650_000_000));
    t.merge_into_master("done");
    let det_sha = t.git(&t.root, &["rev-parse", "master~1"]);
    let det = t.detach_worktree("det", &det_sha);
    t.lock_worktree(&det, "busy");
    Scenario { t, feat, gone, done, det, det_sha }
}

fn by_branch<'a>(wts: &'a [Worktree], b: &str) -> &'a Worktree { wts.iter().find(|w| w.branch.as_deref() == Some(b)).unwrap() }

#[tokio::test]
async fn main_ref_prefers_origin_head_then_local_main_then_master() {
    let t = TempRepo::new();
    let g = git();
    assert_eq!(resolve_main_ref(&g, &t.root).await.as_deref(), Some("origin/master"));
    t.git(&t.root, &["remote", "remove", "origin"]);
    assert_eq!(resolve_main_ref(&g, &t.root).await.as_deref(), Some("master"));
    t.git(&t.root, &["branch", "main"]);
    assert_eq!(resolve_main_ref(&g, &t.root).await.as_deref(), Some("main"));
    t.git(&t.root, &["branch", "-D", "main"]);
    t.git(&t.root, &["branch", "-m", "master", "trunk"]);
    assert_eq!(resolve_main_ref(&g, &t.root).await, None);
}

#[tokio::test]
async fn scan_repo_reports_reference_level_data_for_every_worktree() {
    let s = scenario();
    let g = git();
    let r = scan_repo(&g, &s.t.root).await.unwrap();
    assert_eq!(r.project.name, "repo");
    assert_eq!(r.project.main_ref.as_deref(), Some("origin/master"));
    assert_eq!(r.worktrees.len(), 5);
    let primary = &r.worktrees[0];
    assert!(primary.primary && primary.branch.as_deref() == Some("master"));
    assert_eq!(primary.merged, None, "the main branch itself is not judged");
    let feat = by_branch(&r.worktrees, "feat/a");
    assert_eq!((feat.merged, feat.last_commit), (Some(false), Some(1_700_000_100)));
    assert!(feat.path.ends_with("feat-a"));
    assert_eq!(feat.upstream, Upstream::Tracking { name: "origin/feat/a".into(), ahead: 1, behind: 0 });
    assert_eq!(by_branch(&r.worktrees, "gone").upstream, Upstream::Gone { name: "origin/gone".into() });
    let done = by_branch(&r.worktrees, "done");
    assert_eq!((done.merged, done.upstream.clone()), (Some(true), Upstream::None));
    let det = r.worktrees.iter().find(|w| w.branch.is_none()).unwrap();
    assert_eq!(det.head, s.det_sha);
    assert_eq!(det.merged, Some(true), "master~1 is an ancestor of master");
    assert_eq!(det.upstream, Upstream::None);
    assert!(det.last_commit.is_some());
    assert_eq!(det.locked.as_deref(), Some("busy"));
}

#[tokio::test]
async fn worktree_status_reports_counts_and_untracked_names() {
    let s = scenario();
    let g = git();
    let feat = worktree_status(&g, &s.feat).await.unwrap();
    assert_eq!(feat.counts, Counts { staged: 0, unstaged: 1, untracked: 1 });
    assert_eq!(feat.untracked, vec!["new.txt".to_string()]);
    let done = worktree_status(&g, &s.done).await.unwrap();
    assert_eq!(done.counts, Counts::default());
    assert!(done.untracked.is_empty());
}
