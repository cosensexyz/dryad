mod common;
use common::TempRepo;

#[test]
fn fixture_builds_the_shapes_the_scanner_tests_need() {
    let t = TempRepo::new();
    assert!(!t.root.to_string_lossy().starts_with(r"\\?\"), "fixture paths must be accepted by Git for Windows");
    assert_eq!(t.git(&t.root, &["symbolic-ref", "refs/remotes/origin/HEAD"]), "refs/remotes/origin/master");

    let wt = t.add_worktree("feat/a");
    t.commit(&wt, "a.txt", "a\n", "a", Some(1_700_000_000));
    t.push_upstream(&wt, "feat/a");
    assert_eq!(t.git(&wt, &["rev-parse", "--abbrev-ref", "@{upstream}"]), "origin/feat/a");

    t.delete_remote_branch("feat/a");
    assert!(t.git(&wt, &["status", "--porcelain=v2", "--branch"]).contains("branch.upstream origin/feat/a"));
    assert!(!t.git(&wt, &["status", "--porcelain=v2", "--branch"]).contains("branch.ab"));

    let wt2 = t.add_worktree("done");
    t.commit(&wt2, "d.txt", "d\n", "d", None);
    t.merge_into_master("done");
    assert!(t.git(&t.root, &["branch", "--merged", "master"]).contains("done"));

    let sha = t.git(&t.root, &["rev-parse", "HEAD~1"]);
    let det = t.detach_worktree("det", &sha);
    let listing = t.git(&t.root, &["worktree", "list", "--porcelain"]);
    let entries = dryad_lib::git::parse::parse_worktree_list(listing.as_bytes());
    let detached = entries.iter().find(|e| std::path::Path::new(&e.path) == det).unwrap();
    assert_eq!(detached.head, sha);
    assert!(detached.detached);

    t.lock_worktree(&wt2, "busy");
    assert!(t.git(&t.root, &["worktree", "list", "--porcelain"]).contains("locked busy"));
}
