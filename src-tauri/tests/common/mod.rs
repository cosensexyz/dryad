#![allow(dead_code)]
use std::path::{Path, PathBuf};
use std::process::Command;

pub struct TempRepo {
    pub dir: tempfile::TempDir,
    pub root: PathBuf,
    pub origin: PathBuf,
}

impl TempRepo {
    pub fn new() -> TempRepo {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path().canonicalize().unwrap();
        let root = base.join("repo");
        let origin = base.join("origin.git");
        std::fs::create_dir_all(&root).unwrap();
        let t = TempRepo { dir, root: root.clone(), origin: origin.clone() };
        t.git(&root, &["init", "-q", "-b", "master"]);
        t.git(&root, &["config", "user.email", "t@example.com"]);
        t.git(&root, &["config", "user.name", "T"]);
        t.git(&root, &["config", "commit.gpgsign", "false"]);
        t.commit(&root, "README.md", "# repo\n", "initial", None);
        t.git(&root, &["init", "-q", "--bare", origin.to_str().unwrap()]);
        t.git(&root, &["remote", "add", "origin", origin.to_str().unwrap()]);
        t.git(&root, &["push", "-q", "-u", "origin", "master"]);
        t.git(&root, &["remote", "set-head", "origin", "master"]);
        t
    }

    pub fn git(&self, dir: &Path, args: &[&str]) -> String {
        let out = Command::new("git").args(args).current_dir(dir)
            .env("GIT_TERMINAL_PROMPT", "0").output().expect("spawn git");
        assert!(out.status.success(), "git {:?} in {} failed: {}", args, dir.display(), String::from_utf8_lossy(&out.stderr));
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    pub fn commit(&self, dir: &Path, file: &str, content: &str, msg: &str, unix_time: Option<i64>) -> String {
        let p = dir.join(file);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(&p, content).unwrap();
        self.git(dir, &["add", "--", file]);
        let mut cmd = Command::new("git");
        cmd.args(["commit", "-q", "-m", msg]).current_dir(dir);
        if let Some(t) = unix_time {
            let d = format!("{t} +0000");
            cmd.env("GIT_AUTHOR_DATE", &d).env("GIT_COMMITTER_DATE", &d);
        }
        assert!(cmd.output().unwrap().status.success());
        self.git(dir, &["rev-parse", "HEAD"])
    }

    pub fn add_worktree(&self, branch: &str) -> PathBuf {
        let p = self.root.join(".worktrees").join(branch.replace('/', "-"));
        self.git(&self.root, &["worktree", "add", "-q", p.to_str().unwrap(), "-b", branch]);
        p
    }

    pub fn push_upstream(&self, dir: &Path, branch: &str) { self.git(dir, &["push", "-q", "-u", "origin", branch]); }
    pub fn delete_remote_branch(&self, branch: &str) { self.git(&self.root, &["push", "-q", "origin", "--delete", branch]); }

    pub fn merge_into_master(&self, branch: &str) {
        self.git(&self.root, &["merge", "-q", "--no-ff", "-m", &format!("merge {branch}"), branch]);
        self.git(&self.root, &["push", "-q", "origin", "master"]);
    }

    pub fn detach_worktree(&self, name: &str, sha: &str) -> PathBuf {
        let p = self.root.join(".worktrees").join(name);
        self.git(&self.root, &["worktree", "add", "-q", "--detach", p.to_str().unwrap(), sha]);
        p
    }

    pub fn lock_worktree(&self, path: &Path, reason: &str) {
        self.git(&self.root, &["worktree", "lock", "--reason", reason, path.to_str().unwrap()]);
    }
}
