//! Pure parsers for the git output formats Dryad reads. No I/O here.

#[derive(Debug, Clone, PartialEq, Default)]
pub struct WorktreeEntry {
    pub path: String,
    pub head: String,
    pub branch: Option<String>,
    pub bare: bool,
    pub detached: bool,
    pub locked: Option<String>,
    pub prunable: Option<String>,
}

pub fn parse_worktree_list(out: &[u8]) -> Vec<WorktreeEntry> {
    let text = String::from_utf8_lossy(out);
    let mut entries = Vec::new();
    let mut cur: Option<WorktreeEntry> = None;
    for line in text.lines() {
        if line.is_empty() {
            if let Some(e) = cur.take() { entries.push(e); }
            continue;
        }
        let (key, rest) = match line.split_once(' ') { Some((k, r)) => (k, r), None => (line, "") };
        match key {
            "worktree" => { if let Some(e) = cur.take() { entries.push(e); } cur = Some(WorktreeEntry { path: rest.to_string(), ..Default::default() }); }
            "HEAD" => if let Some(e) = cur.as_mut() { e.head = rest.to_string(); },
            "branch" => if let Some(e) = cur.as_mut() { e.branch = Some(rest.strip_prefix("refs/heads/").unwrap_or(rest).to_string()); },
            "detached" => if let Some(e) = cur.as_mut() { e.detached = true; },
            "bare" => if let Some(e) = cur.as_mut() { e.bare = true; },
            "locked" => if let Some(e) = cur.as_mut() { e.locked = Some(rest.to_string()); },
            "prunable" => if let Some(e) = cur.as_mut() { e.prunable = Some(rest.to_string()); },
            _ => {}
        }
    }
    if let Some(e) = cur.take() { entries.push(e); }
    entries
}

#[cfg(test)]
mod worktree_tests {
    use super::*;

    const SAMPLE: &str = "worktree /r\nHEAD 338c69d6aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\nbranch refs/heads/master\n\n\
worktree /r/.worktrees/feat\nHEAD 4da51ed9bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\nbranch refs/heads/feat/x\nlocked in use by CI\n\n\
worktree /r/.worktrees/old\nHEAD 9f3a1c2eccccccccccccccccccccccccccccccccc\ndetached\nprunable gitdir file points to non-existent location\n\n\
worktree /bare.git\nHEAD 0000000000000000000000000000000000000000\nbare\n\n";

    #[test]
    fn parses_primary_branch_detached_locked_prunable_and_bare() {
        let v = parse_worktree_list(SAMPLE.as_bytes());
        assert_eq!(v.len(), 4);
        assert_eq!(v[0].path, "/r");
        assert_eq!(v[0].branch.as_deref(), Some("master"));
        assert_eq!(&v[0].head[..8], "338c69d6");
        assert_eq!(v[1].branch.as_deref(), Some("feat/x"));
        assert_eq!(v[1].locked.as_deref(), Some("in use by CI"));
        assert!(v[2].detached);
        assert_eq!(v[2].branch, None);
        assert_eq!(v[2].prunable.as_deref(), Some("gitdir file points to non-existent location"));
        assert!(v[3].bare);
    }

    #[test]
    fn locked_without_reason_is_some_empty() {
        let v = parse_worktree_list(b"worktree /a\nHEAD 1111111111111111111111111111111111111111\nbranch refs/heads/b\nlocked\n\n");
        assert_eq!(v[0].locked.as_deref(), Some(""));
        assert_eq!(v[0].prunable, None);
    }

    #[test]
    fn tolerates_missing_trailing_blank_line_and_non_utf8_path() {
        let mut raw = b"worktree /caf\xc3\xa9\xff\nHEAD 2222222222222222222222222222222222222222\ndetached".to_vec();
        raw.push(b'\n');
        let v = parse_worktree_list(&raw);
        assert_eq!(v.len(), 1);
        assert!(v[0].path.starts_with("/caf\u{e9}"));
    }
}
