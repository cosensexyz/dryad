//! Pure parsers for the git output formats Dryad reads. No I/O here.

use crate::model::Counts;
use crate::model::Upstream;
use std::collections::{HashMap, HashSet};

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

#[derive(Debug, Clone, PartialEq, Default)]
pub struct StatusParsed {
    pub head: Option<String>,
    pub upstream: Option<String>,
    pub ab: Option<(u32, u32)>,
    pub counts: Counts,
    pub untracked: Vec<String>,
}

fn nul_records(out: &[u8]) -> Vec<String> {
    out.split(|b| *b == 0)
        .filter(|r| !r.is_empty())
        .map(|r| String::from_utf8_lossy(r).into_owned())
        .collect()
}

pub fn parse_status_v2(out: &[u8]) -> StatusParsed {
    let recs = nul_records(out);
    let mut s = StatusParsed::default();
    let mut i = 0;
    while i < recs.len() {
        let r = &recs[i];
        i += 1;
        if let Some(h) = r.strip_prefix("# ") {
            if let Some(v) = h.strip_prefix("branch.head ") {
                s.head = if v == "(detached)" { None } else { Some(v.to_string()) };
            } else if let Some(v) = h.strip_prefix("branch.upstream ") {
                s.upstream = Some(v.to_string());
            } else if let Some(v) = h.strip_prefix("branch.ab ") {
                let mut it = v.split(' ');
                let a = it.next().and_then(|t| t.trim_start_matches('+').parse().ok());
                let b = it.next().and_then(|t| t.trim_start_matches('-').parse().ok());
                if let (Some(a), Some(b)) = (a, b) { s.ab = Some((a, b)); }
            }
            continue;
        }
        let mut f = r.splitn(2, ' ');
        let tag = f.next().unwrap_or("");
        let rest = f.next().unwrap_or("");
        match tag {
            "1" | "2" | "u" => {
                let xy = rest.get(0..2).unwrap_or("..").as_bytes();
                if tag == "u" {
                    s.counts.unstaged += 1;
                } else {
                    if xy[0] != b'.' { s.counts.staged += 1; }
                    if xy[1] != b'.' { s.counts.unstaged += 1; }
                }
                if tag == "2" { i += 1; } // the original path is its own NUL-terminated record
            }
            "?" => { s.counts.untracked += 1; s.untracked.push(rest.to_string()); }
            _ => {} // "!" ignored entries and anything unknown
        }
    }
    s
}

#[derive(Debug, Clone, PartialEq)]
pub struct RefInfo { pub time: i64, pub upstream: Upstream }

pub fn parse_ref_info(out: &[u8]) -> HashMap<String, RefInfo> {
    String::from_utf8_lossy(out)
        .lines()
        .filter_map(|l| {
            let mut f = l.split('\t');
            let name = f.next()?;
            let time: i64 = f.next()?.parse().ok()?;
            let up = f.next().unwrap_or("");
            let track = f.next().unwrap_or("").trim_matches(|c| c == '[' || c == ']');
            let upstream = if up.is_empty() {
                Upstream::None
            } else if track == "gone" {
                Upstream::Gone { name: up.to_string() }
            } else {
                let (mut ahead, mut behind) = (0u32, 0u32);
                for part in track.split(',') {
                    let part = part.trim();
                    if let Some(n) = part.strip_prefix("ahead ") { ahead = n.parse().unwrap_or(0); }
                    if let Some(n) = part.strip_prefix("behind ") { behind = n.parse().unwrap_or(0); }
                }
                Upstream::Tracking { name: up.to_string(), ahead, behind }
            };
            Some((name.to_string(), RefInfo { time, upstream }))
        })
        .collect()
}

pub fn parse_ref_names(out: &[u8]) -> HashSet<String> {
    String::from_utf8_lossy(out).lines().filter(|l| !l.is_empty()).map(str::to_string).collect()
}

#[derive(Debug, Clone, PartialEq)]
pub struct NameStatus { pub status: char, pub path: String, pub old_path: Option<String> }

pub fn parse_name_status(out: &[u8]) -> Vec<NameStatus> {
    let recs = nul_records(out);
    let mut v = Vec::new();
    let mut i = 0;
    while i + 1 < recs.len() {
        let status = recs[i].chars().next().unwrap_or('M');
        if status == 'R' || status == 'C' {
            if i + 2 < recs.len() {
                v.push(NameStatus { status, path: recs[i + 2].clone(), old_path: Some(recs[i + 1].clone()) });
            }
            i += 3;
        } else {
            v.push(NameStatus { status, path: recs[i + 1].clone(), old_path: None });
            i += 2;
        }
    }
    v
}

#[derive(Debug, Clone, PartialEq)]
pub struct NumStat { pub added: Option<u32>, pub deleted: Option<u32>, pub path: String }

pub fn parse_numstat(out: &[u8]) -> Vec<NumStat> {
    let recs = nul_records(out);
    let mut v = Vec::new();
    let mut i = 0;
    while i < recs.len() {
        let mut cols = recs[i].splitn(3, '\t');
        let added = cols.next().and_then(|t| t.parse().ok());
        let deleted = cols.next().and_then(|t| t.parse().ok());
        let path = cols.next().unwrap_or("");
        i += 1;
        if path.is_empty() {
            // rename: the record ends after the second tab; old and new paths follow as two records
            if i + 1 < recs.len() { v.push(NumStat { added, deleted, path: recs[i + 1].clone() }); }
            i += 2;
        } else {
            v.push(NumStat { added, deleted, path: path.to_string() });
        }
    }
    v
}

use crate::model::{DiffLine, Hunk};

fn hunk_starts(header: &str) -> Option<(u32, u32)> {
    // "@@ -a[,b] +c[,d] @@ ..."
    let body = header.strip_prefix("@@ -")?;
    let (old, rest) = body.split_once(" +")?;
    let (new, _) = rest.split_once(" @@")?;
    let num = |s: &str| s.split(',').next().and_then(|n| n.parse::<u32>().ok());
    Some((num(old)?, num(new)?))
}

pub fn parse_patch(text: &str, max_lines: usize) -> (Vec<Hunk>, bool) {
    let mut hunks: Vec<Hunk> = Vec::new();
    let mut count = 0usize;
    for line in text.lines() {
        if line.starts_with("@@") {
            let (old_start, new_start) = hunk_starts(line).unwrap_or((0, 0));
            hunks.push(Hunk { header: line.to_string(), old_start, new_start, lines: Vec::new() });
            continue;
        }
        if line.starts_with("diff --git") && !hunks.is_empty() { break; }
        let Some(h) = hunks.last_mut() else { continue };
        let Some(sign) = line.chars().next() else { continue };
        if sign == '\\' { continue; }
        if !matches!(sign, ' ' | '+' | '-') { continue; }
        if count >= max_lines { return (hunks, true); }
        h.lines.push(DiffLine { sign, text: line[1..].to_string() });
        count += 1;
    }
    (hunks, false)
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

#[cfg(test)]
mod status_tests {
    use super::*;

    fn z(records: &[&str]) -> Vec<u8> {
        let mut v = Vec::new();
        for r in records { v.extend_from_slice(r.as_bytes()); v.push(0); }
        v
    }

    #[test]
    fn counts_staged_unstaged_untracked_and_reads_branch_headers() {
        let out = z(&[
            "# branch.oid 4da51ed9",
            "# branch.head iodc-endpoint-url",
            "# branch.upstream origin/iodc-endpoint-url",
            "# branch.ab +3 -0",
            "1 M. N... 100644 100644 100644 aaa bbb internal/network/endpoint.go",   // staged only
            "1 .M N... 100644 100644 100644 aaa aaa SPEC/connector-module.md",       // unstaged only
            "1 MM N... 100644 100644 100644 aaa bbb internal/config/config.go",      // both
            "2 R. N... 100644 100644 100644 aaa aaa R100 new/name.go", "old/name.go", // rename, staged; orig path record
            "u UU N... 100644 100644 100644 100644 aaa bbb ccc conflict.txt",        // unmerged -> unstaged
            "? notes/todo.md",
            "! target/",
        ]);
        let s = parse_status_v2(&out);
        assert_eq!(s.head.as_deref(), Some("iodc-endpoint-url"));
        assert_eq!(s.upstream.as_deref(), Some("origin/iodc-endpoint-url"));
        assert_eq!(s.ab, Some((3, 0)));
        assert_eq!(s.counts, Counts { staged: 3, unstaged: 3, untracked: 1 });
        assert_eq!(s.untracked, vec!["notes/todo.md".to_string()]);
    }

    #[test]
    fn upstream_without_ab_means_gone_and_detached_head_is_none() {
        let out = z(&["# branch.oid 9f3a1c2e", "# branch.head (detached)", "# branch.upstream origin/feat/ui"]);
        let s = parse_status_v2(&out);
        assert_eq!(s.head, None);
        assert_eq!(s.upstream.as_deref(), Some("origin/feat/ui"));
        assert_eq!(s.ab, None);
        assert_eq!(s.counts, Counts::default());
    }

    #[test]
    fn no_upstream_and_empty_status() {
        let s = parse_status_v2(&z(&["# branch.oid c3f3fd74", "# branch.head simplify-merge-gate"]));
        assert_eq!(s.upstream, None);
        assert_eq!(s.ab, None);
        assert!(s.untracked.is_empty());
    }
}

#[cfg(test)]
mod ref_and_diff_list_tests {
    use super::*;

    #[test]
    fn ref_info_and_names() {
        let out = b"master\t1757400000\torigin/master\t\nfeat/x\t1757300000\torigin/feat/x\t[ahead 3, behind 1]\n\
gone\t1600000000\torigin/gone\t[gone]\nlocal\t1500000000\t\t\nbehind\t1400000000\torigin/behind\t[behind 2]\n";
        let r = parse_ref_info(out);
        assert_eq!(r["master"], RefInfo { time: 1757400000, upstream: Upstream::Tracking { name: "origin/master".into(), ahead: 0, behind: 0 } });
        assert_eq!(r["feat/x"].upstream, Upstream::Tracking { name: "origin/feat/x".into(), ahead: 3, behind: 1 });
        assert_eq!(r["gone"].upstream, Upstream::Gone { name: "origin/gone".into() });
        assert_eq!(r["local"].upstream, Upstream::None);
        assert_eq!(r["behind"].upstream, Upstream::Tracking { name: "origin/behind".into(), ahead: 0, behind: 2 });
        let names = parse_ref_names(b"master\nhotfix-401\n");
        assert!(names.contains("hotfix-401") && names.len() == 2);
        assert!(parse_ref_names(b"").is_empty());
    }

    #[test]
    fn name_status_handles_plain_and_rename_records() {
        let out = b"M\0a.go\0A\0b.go\0R100\0old.go\0new.go\0D\0gone.go\0";
        let v = parse_name_status(out);
        assert_eq!(v.len(), 4);
        assert_eq!((v[0].status, v[0].path.as_str()), ('M', "a.go"));
        assert_eq!((v[2].status, v[2].path.as_str(), v[2].old_path.as_deref()), ('R', "new.go", Some("old.go")));
        assert_eq!(v[3].status, 'D');
    }

    #[test]
    fn numstat_handles_binary_and_rename_records() {
        let out = b"12\t3\ta.go\0-\t-\timg.png\05\t0\t\0old.go\0new.go\0";
        let v = parse_numstat(out);
        assert_eq!(v.len(), 3);
        assert_eq!((v[0].added, v[0].deleted, v[0].path.as_str()), (Some(12), Some(3), "a.go"));
        assert_eq!((v[1].added, v[1].deleted), (None, None));
        assert_eq!((v[2].added, v[2].path.as_str()), (Some(5), "new.go"));
    }
}

#[cfg(test)]
mod patch_tests {
    use super::*;

    const P: &str = "diff --git a/x.rs b/x.rs\nindex 1..2 100644\n--- a/x.rs\n+++ b/x.rs\n\
@@ -18,3 +18,4 @@ impl Parser {\n fn a() {}\n-fn b() {}\n+fn b2() {}\n+fn c() {}\n\
@@ -64,2 +65,1 @@\n fn d() {}\n-// gone\n\\ No newline at end of file\n";

    #[test]
    fn parses_hunks_with_starts_and_signs() {
        let (h, trunc) = parse_patch(P, 1000);
        assert!(!trunc);
        assert_eq!(h.len(), 2);
        assert_eq!((h[0].old_start, h[0].new_start), (18, 18));
        assert_eq!(h[0].header, "@@ -18,3 +18,4 @@ impl Parser {");
        let signs: String = h[0].lines.iter().map(|l| l.sign).collect();
        assert_eq!(signs, " -++");
        assert_eq!(h[0].lines[2].text, "fn b2() {}");
        assert_eq!(h[1].lines.len(), 2); // the "\ No newline" marker is dropped
    }

    #[test]
    fn truncates_after_max_lines() {
        let (h, trunc) = parse_patch(P, 3);
        assert!(trunc);
        let n: usize = h.iter().map(|x| x.lines.len()).sum();
        assert_eq!(n, 3);
    }

    #[test]
    fn empty_patch_yields_no_hunks() {
        assert_eq!(parse_patch("", 10), (vec![], false));
    }
}
