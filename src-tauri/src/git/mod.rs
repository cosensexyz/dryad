//! The only place that spawns `git`. Timeout, concurrency limit, binary location and
//! byte-level output handling all live here so no other module knows the platform.

pub mod parse;

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Semaphore;

#[derive(Debug, thiserror::Error)]
pub enum GitError {
    #[error("git executable not found; searched: {0}")]
    NotFound(String),
    #[error("git timed out after {0:?}")]
    Timeout(Duration),
    #[error("git exited with code {code}: {stderr}")]
    Failed { code: i32, stderr: String },
    #[error("failed to run git: {0}")]
    Io(#[from] std::io::Error),
}

#[derive(Debug)]
pub struct Output {
    pub stdout: Vec<u8>,
    pub stderr: String,
    pub code: i32,
}

pub fn exe_name() -> &'static str {
    if cfg!(windows) { "git.exe" } else { "git" }
}

/// Search PATH entries first, then platform fallbacks. Pure so it can be tested with temp dirs.
pub fn locate_in(path_entries: &[PathBuf], fallbacks: &[PathBuf]) -> Result<PathBuf, GitError> {
    let mut searched = Vec::new();
    for dir in path_entries {
        let cand = dir.join(exe_name());
        if cand.is_file() { return Ok(cand); }
        searched.push(dir.display().to_string());
    }
    for cand in fallbacks {
        if cand.is_file() { return Ok(cand.clone()); }
        searched.push(cand.display().to_string());
    }
    Err(GitError::NotFound(searched.join(", ")))
}

fn platform_fallbacks() -> Vec<PathBuf> {
    let mut v: Vec<PathBuf> = Vec::new();
    if cfg!(target_os = "macos") {
        v.extend(["/opt/homebrew/bin/git", "/usr/local/bin/git", "/usr/bin/git"].map(PathBuf::from));
    } else if cfg!(target_os = "windows") {
        v.extend([r"C:\Program Files\Git\cmd\git.exe", r"C:\Program Files\Git\bin\git.exe"].map(PathBuf::from));
    } else {
        v.extend(["/usr/bin/git", "/usr/local/bin/git"].map(PathBuf::from));
    }
    v
}

/// GUI processes on macOS/Linux do not inherit the login shell's PATH; fix it, then search.
pub fn locate() -> Result<PathBuf, GitError> {
    let _ = fix_path_env::fix();
    let entries: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default();
    locate_in(&entries, &platform_fallbacks())
}

pub struct Git {
    exe: PathBuf,
    timeout: Duration,
    sem: Arc<Semaphore>,
}

impl Git {
    pub fn new(exe: PathBuf, timeout: Duration, concurrency: usize) -> Git {
        Git { exe, timeout, sem: Arc::new(Semaphore::new(concurrency.max(1))) }
    }

    pub fn exe(&self) -> &Path { &self.exe }

    /// Run git in `dir`. Any exit code is Ok; only spawn failure and timeout are Err.
    pub async fn run(&self, dir: &Path, args: &[&str]) -> Result<Output, GitError> {
        let _permit = self.sem.acquire().await.expect("semaphore closed");
        let mut cmd = tokio::process::Command::new(&self.exe);
        cmd.args(args)
            .current_dir(dir)
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("LC_ALL", "C")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }
        let child = cmd.spawn()?;
        match tokio::time::timeout(self.timeout, child.wait_with_output()).await {
            Ok(res) => {
                let out = res?;
                Ok(Output {
                    stdout: out.stdout,
                    stderr: String::from_utf8_lossy(&out.stderr).trim_end().to_string(),
                    code: out.status.code().unwrap_or(-1),
                })
            }
            Err(_) => Err(GitError::Timeout(self.timeout)),
        }
    }

    pub async fn run_ok(&self, dir: &Path, args: &[&str]) -> Result<Vec<u8>, GitError> {
        let out = self.run(dir, args).await?;
        if out.code != 0 {
            return Err(GitError::Failed { code: out.code, stderr: out.stderr });
        }
        Ok(out.stdout)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[cfg(unix)]
    fn fake_git(dir: &std::path::Path, body: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let p = dir.join("git");
        std::fs::write(&p, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
        p
    }

    #[test]
    fn locate_in_prefers_path_entries_then_fallbacks_then_reports_searched() {
        let tmp = tempfile::tempdir().unwrap();
        let on_path = tmp.path().join("bin");
        std::fs::create_dir(&on_path).unwrap();
        let fb = tmp.path().join("fallback").join(exe_name());
        std::fs::create_dir(fb.parent().unwrap()).unwrap();
        // nothing anywhere
        let err = locate_in(&[on_path.clone()], &[fb.clone()]).unwrap_err();
        assert!(matches!(err, GitError::NotFound(ref s) if s.contains("bin") && s.contains("fallback")));
        // fallback only
        std::fs::write(&fb, "").unwrap();
        assert_eq!(locate_in(&[on_path.clone()], &[fb.clone()]).unwrap(), fb);
        // PATH wins over fallback
        let p = on_path.join(exe_name());
        std::fs::write(&p, "").unwrap();
        assert_eq!(locate_in(&[on_path], &[fb]).unwrap(), p);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn run_captures_stdout_stderr_and_exit_code() {
        let tmp = tempfile::tempdir().unwrap();
        let exe = fake_git(tmp.path(), "printf 'out'; printf 'err' >&2; exit 3");
        let git = Git::new(exe, Duration::from_secs(5), 2);
        let out = git.run(tmp.path(), &["status"]).await.unwrap();
        assert_eq!(out.stdout, b"out");
        assert_eq!(out.stderr, "err");
        assert_eq!(out.code, 3);
        let err = git.run_ok(tmp.path(), &["status"]).await.unwrap_err();
        assert!(matches!(err, GitError::Failed { code: 3, ref stderr } if stderr == "err"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn run_times_out_and_kills_the_child() {
        let tmp = tempfile::tempdir().unwrap();
        let exe = fake_git(tmp.path(), "sleep 5");
        let git = Git::new(exe, Duration::from_millis(100), 2);
        let started = std::time::Instant::now();
        let err = git.run(tmp.path(), &["status"]).await.unwrap_err();
        assert!(matches!(err, GitError::Timeout(_)));
        assert!(started.elapsed() < Duration::from_secs(2));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn run_keeps_non_utf8_stdout_as_bytes() {
        let tmp = tempfile::tempdir().unwrap();
        let exe = fake_git(tmp.path(), "printf '\\377\\376ok'");
        let git = Git::new(exe, Duration::from_secs(5), 2);
        let out = git.run(tmp.path(), &["x"]).await.unwrap();
        assert_eq!(&out.stdout[..2], &[0xff, 0xfe]);
        assert_eq!(String::from_utf8_lossy(&out.stdout).ends_with("ok"), true);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn concurrency_limit_bounds_simultaneous_children() {
        // Each fake git records its start, sleeps, records its end; the log must never show >2 overlapping.
        let tmp = tempfile::tempdir().unwrap();
        let log = tmp.path().join("log");
        let exe = fake_git(tmp.path(), &format!("echo start >> {0}; sleep 0.2; echo end >> {0}", log.display()));
        let git = std::sync::Arc::new(Git::new(exe, Duration::from_secs(5), 2));
        let mut set = tokio::task::JoinSet::new();
        for _ in 0..6 {
            let g = git.clone();
            let d = tmp.path().to_path_buf();
            set.spawn(async move { g.run(&d, &["x"]).await.unwrap() });
        }
        while set.join_next().await.is_some() {}
        let mut live = 0i32;
        let mut peak = 0i32;
        for line in std::fs::read_to_string(&log).unwrap().lines() {
            if line == "start" { live += 1; peak = peak.max(live); } else { live -= 1; }
        }
        assert!(peak <= 2, "peak concurrency was {peak}");
    }
}
