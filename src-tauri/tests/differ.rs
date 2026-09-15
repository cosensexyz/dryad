mod common;
use common::TempRepo;
use dryad_lib::differ::*;
use dryad_lib::git::Git;
use dryad_lib::model::*;
use std::time::Duration;

fn git() -> Git { Git::new(dryad_lib::git::locate().unwrap(), Duration::from_secs(30), 4) }

/// feat worktree: staged edit (a.txt), staged rename (b.txt -> c.txt), staged binary (img.bin),
/// unstaged edit (README.md), untracked (new.txt); two commits ahead of origin/master.
fn setup() -> (TempRepo, std::path::PathBuf, String) {
    let t = TempRepo::new();
    let wt = t.add_worktree("feat");
    t.commit(&wt, "a.txt", "one\ntwo\nthree\n", "a", None);
    t.commit(&wt, "b.txt", "bee\n", "b", None);
    std::fs::write(wt.join("a.txt"), "one\n2\nthree\nfour\n").unwrap();
    t.git(&wt, &["add", "a.txt"]);
    t.git(&wt, &["mv", "b.txt", "c.txt"]);
    std::fs::write(wt.join("img.bin"), [0u8, 159, 146, 150, 0, 1]).unwrap();
    t.git(&wt, &["add", "img.bin"]);
    std::fs::write(wt.join("README.md"), "# repo\nmore\n").unwrap();
    std::fs::write(wt.join("new.txt"), "n\n").unwrap();
    let head = t.git(&wt, &["rev-parse", "HEAD"]);
    (t, wt, head)
}

fn find<'a>(l: &'a FileList, p: &str) -> &'a DiffFile { l.files.iter().find(|f| f.path == p).unwrap() }

#[tokio::test]
async fn working_tree_list_groups_staged_unstaged_untracked_with_counts_renames_and_binary() {
    let (_t, wt, _) = setup();
    let l = working_tree_files(&git(), &wt, &["new.txt".to_string()], 500).await.unwrap();
    assert!(!l.truncated);
    let a = find(&l, "a.txt");
    assert!(a.staged && a.change == Change::Modified && a.added == 2 && a.deleted == 1);
    let c = find(&l, "c.txt");
    assert!(c.staged && c.change == Change::Renamed && c.old_path.as_deref() == Some("b.txt"));
    let img = find(&l, "img.bin");
    assert!(img.staged && img.binary && img.change == Change::Added);
    let readme = find(&l, "README.md");
    assert!(!readme.staged && readme.change == Change::Modified && readme.added == 1);
    let new = find(&l, "new.txt");
    assert!(!new.staged && new.change == Change::Untracked);
    assert_eq!(l.files.len(), 5);
}

#[tokio::test]
async fn working_tree_patch_distinguishes_staged_and_unstaged_and_refuses_untracked() {
    let (_t, wt, _) = setup();
    let g = git();
    let p = working_tree_patch(&g, &wt, "a.txt", None, true, 5000).await.unwrap();
    assert_eq!(p.hunks.len(), 1);
    let signs: String = p.hunks[0].lines.iter().map(|l| l.sign).collect();
    assert_eq!(signs, " -+ +");
    let un = working_tree_patch(&g, &wt, "a.txt", None, false, 5000).await.unwrap();
    assert!(un.hunks.is_empty(), "a.txt has no unstaged change");
    let r = working_tree_patch(&g, &wt, "c.txt", Some("b.txt"), true, 5000).await.unwrap();
    assert!(r.hunks.is_empty(), "pure rename has no content hunks");
    let p = working_tree_patch(&g, &wt, "a.txt", None, true, 2).await.unwrap();
    assert_eq!(p.hunks.iter().map(|x| x.lines.len()).sum::<usize>(), 2);
    assert!(p.truncated);
}

#[tokio::test]
async fn branch_list_and_patch_use_three_dot_diff_from_the_primary_worktree() {
    let (t, wt, head) = setup();
    let g = git();
    let l = branch_files(&g, &t.root, "origin/master", &head, 500).await.unwrap();
    let paths: Vec<_> = l.files.iter().map(|f| f.path.as_str()).collect();
    assert_eq!(paths, vec!["a.txt", "b.txt"]);
    assert!(l.files.iter().all(|f| f.change == Change::Added && !f.staged));
    let p = branch_patch(&g, &t.root, "origin/master", &head, "a.txt", None, 5000).await.unwrap();
    assert_eq!(p.hunks[0].lines.iter().filter(|l| l.sign == '+').count(), 3);
    // the worktree directory is not needed for branch data
    std::fs::remove_dir_all(&wt).unwrap();
    assert_eq!(branch_files(&g, &t.root, "origin/master", &head, 500).await.unwrap().files.len(), 2);
    // a merged branch has nothing beyond main
    let sha = t.git(&t.root, &["rev-parse", "master"]);
    assert!(branch_files(&g, &t.root, "origin/master", &sha, 500).await.unwrap().files.is_empty());
}

#[tokio::test]
async fn file_cap_truncates() {
    let (t, wt, _) = setup();
    for i in 0..5 { std::fs::write(wt.join(format!("u{i}.txt")), "x").unwrap(); }
    let untracked: Vec<String> = (0..5).map(|i| format!("u{i}.txt")).collect();
    let l = working_tree_files(&git(), &wt, &untracked, 3).await.unwrap();
    assert_eq!(l.files.len(), 3);
    assert!(l.truncated);
    drop(t);
}

#[test]
fn untracked_patch_reads_a_file_as_added_lines() {
    let (_t, wt, _) = setup();
    let p = untracked_patch(&wt, "new.txt", 5000).unwrap();
    assert_eq!(p.path, "new.txt");
    assert!(!p.binary && !p.truncated);
    assert_eq!(p.hunks.len(), 1);
    assert_eq!(p.hunks[0].header, "@@ -0,0 +1,1 @@");
    assert_eq!(p.hunks[0].lines, vec![DiffLine { sign: '+', text: "n".to_string() }]);
}

#[test]
fn untracked_patch_truncates_at_max_lines() {
    let (_t, wt, _) = setup();
    std::fs::write(wt.join("many.txt"), "a\nb\nc\nd\ne\n").unwrap();
    let p = untracked_patch(&wt, "many.txt", 3).unwrap();
    assert!(p.truncated);
    assert_eq!(p.hunks[0].lines.len(), 3);
}

#[test]
fn untracked_patch_marks_binary_files() {
    let (_t, wt, _) = setup();
    std::fs::write(wt.join("blob.bin"), [1u8, 0, 2]).unwrap();
    let p = untracked_patch(&wt, "blob.bin", 5000).unwrap();
    assert!(p.binary);
    assert!(p.hunks.is_empty());
}

#[test]
fn untracked_patch_rejects_missing_and_escaping_paths() {
    let (t, wt, _) = setup();
    assert!(untracked_patch(&wt, "gone.txt", 5000).is_err());
    assert!(untracked_patch(&wt, "../escape.txt", 5000).is_err());
    assert!(untracked_patch(&wt, "/etc/hosts", 5000).is_err());
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(t.root.join("README.md"), wt.join("link.txt")).unwrap();
        assert!(untracked_patch(&wt, "link.txt", 5000).is_err());
    }
}

#[tokio::test]
async fn context_lines_read_worktree_index_and_commit_sides() {
    let (t, wt, _) = setup();
    let content: String = (1..=30).map(|i| format!("line {i}\n")).collect();
    let head = t.commit(&wt, "long.txt", &content, "long", None);
    let g = git();
    let c = context_lines(&g, &t.root, ContextSource::Commit(&head), "long.txt", 1, Some(4), 5000).await.unwrap();
    assert_eq!(c.lines, vec!["line 1", "line 2", "line 3", "line 4"]);
    assert_eq!(c.total, 30);
    // staged change, then a further worktree change: the index wins for a staged diff
    let staged: String = (1..=30).map(|i| format!("staged {i}\n")).collect();
    std::fs::write(wt.join("long.txt"), &staged).unwrap();
    t.git(&wt, &["add", "long.txt"]);
    std::fs::write(wt.join("long.txt"), "worktree only\n".repeat(30)).unwrap();
    let c = context_lines(&g, &wt, ContextSource::Index, "long.txt", 2, Some(2), 5000).await.unwrap();
    assert_eq!(c.lines, vec!["staged 2", "staged 3"]);
    // unstaged: the worktree file; renamed files are read by their new path
    let c = context_lines(&g, &wt, ContextSource::Worktree, "long.txt", 1, Some(1), 5000).await.unwrap();
    assert_eq!(c.lines, vec!["worktree only"]);
    assert_eq!(c.total, 30);
    t.git(&wt, &["mv", "long.txt", "renamed.txt"]);
    let c = context_lines(&g, &wt, ContextSource::Index, "renamed.txt", 29, Some(3), 5000).await.unwrap();
    assert_eq!(c.lines, vec!["staged 29", "staged 30"]);
}

#[tokio::test]
async fn context_lines_stop_at_eof_and_respect_the_single_response_cap() {
    let (t, wt, _) = setup();
    let content: String = (1..=30).map(|i| format!("line {i}\n")).collect();
    let head = t.commit(&wt, "long.txt", &content, "long", None);
    let g = git();
    let c = context_lines(&g, &t.root, ContextSource::Commit(&head), "long.txt", 28, Some(10), 5000).await.unwrap();
    assert_eq!(c.lines.len(), 3);
    assert_eq!(c.total, 30);
    let c = context_lines(&g, &t.root, ContextSource::Commit(&head), "long.txt", 1, Some(100), 5).await.unwrap();
    assert_eq!(c.lines.len(), 5);
    let c = context_lines(&g, &t.root, ContextSource::Commit(&head), "long.txt", 1, None, 7).await.unwrap();
    assert_eq!(c.lines.len(), 7);
}

#[tokio::test]
async fn context_lines_reject_escaping_missing_and_oversized_sources() {
    let (_t, wt, _) = setup();
    let g = git();
    assert!(context_lines(&g, &wt, ContextSource::Worktree, "../escape.txt", 1, Some(1), 5000).await.is_err());
    assert!(context_lines(&g, &wt, ContextSource::Worktree, "gone.txt", 1, Some(1), 5000).await.is_err());
    assert!(context_lines(&g, &wt, ContextSource::Index, "/etc/hosts", 1, Some(1), 5000).await.is_err());
    std::fs::write(wt.join("big.txt"), vec![b'a'; (MAX_CONTEXT_BYTES + 1) as usize]).unwrap();
    let err = context_lines(&g, &wt, ContextSource::Worktree, "big.txt", 1, Some(1), 5000).await.unwrap_err();
    assert!(err.to_string().contains("too large"));
}
