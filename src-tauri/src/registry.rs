//! The only persisted state: the list of project top-level paths.

use crate::git::{Git, GitError};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, thiserror::Error)]
pub enum RegistryError {
    #[error("not a git repository: {0}")]
    NotARepo(String),
    #[error("already in the list: {0}")]
    Duplicate(String),
    #[error("registry file: {0}")]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Git(#[from] GitError),
}

#[derive(Serialize, Deserialize)]
struct RegistryFile { version: u32, projects: Vec<String> }

pub struct Registry { file: PathBuf, projects: Vec<String> }

impl Registry {
    pub fn load(file: PathBuf) -> (Registry, Option<String>) {
        let mut warning = None;
        let projects = match std::fs::read_to_string(&file) {
            Ok(text) => match serde_json::from_str::<RegistryFile>(&text) {
                Ok(f) => f.projects,
                Err(e) => {
                    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
                    let backup = file.with_file_name(format!("{}.corrupt-{stamp}", file.file_name().unwrap().to_string_lossy()));
                    let moved = std::fs::rename(&file, &backup).is_ok();
                    warning = Some(format!("project list could not be read ({e}); {} and starting empty",
                        if moved { format!("moved to {}", backup.display()) } else { "left in place".to_string() }));
                    Vec::new()
                }
            },
            Err(_) => Vec::new(),
        };
        (Registry { file, projects }, warning)
    }

    pub fn projects(&self) -> &[String] { &self.projects }
    pub fn contains(&self, path: &str) -> bool { self.projects.iter().any(|p| p == path) }

    pub fn add(&mut self, top: &str) -> Result<(), RegistryError> {
        if self.contains(top) { return Err(RegistryError::Duplicate(top.to_string())); }
        self.projects.push(top.to_string());
        self.save()
    }

    pub fn remove(&mut self, top: &str) -> Result<(), RegistryError> {
        self.projects.retain(|p| p != top);
        self.save()
    }

    fn save(&self) -> Result<(), RegistryError> {
        if let Some(dir) = self.file.parent() { std::fs::create_dir_all(dir)?; }
        let tmp = self.file.with_extension("json.tmp");
        let body = serde_json::to_string_pretty(&RegistryFile { version: 1, projects: self.projects.clone() })
            .expect("registry serializes");
        std::fs::write(&tmp, body)?;
        std::fs::rename(&tmp, &self.file)?;
        Ok(())
    }
}

/// Resolve any directory inside a repository to that repository's top level.
pub async fn toplevel(git: &Git, dir: &Path) -> Result<String, RegistryError> {
    if !dir.is_dir() { return Err(RegistryError::NotARepo(dir.display().to_string())); }
    match git.run(dir, &["rev-parse", "--show-toplevel"]).await? {
        out if out.code == 0 => Ok(String::from_utf8_lossy(&out.stdout).trim().to_string()),
        _ => Err(RegistryError::NotARepo(dir.display().to_string())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn add_persists_dedupes_and_remove_persists() {
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join("projects.json");
        let (mut r, warn) = Registry::load(file.clone());
        assert!(warn.is_none());
        r.add("/a").unwrap();
        r.add("/b").unwrap();
        assert!(matches!(r.add("/a"), Err(RegistryError::Duplicate(_))));
        let (r2, _) = Registry::load(file.clone());
        assert_eq!(r2.projects(), &["/a".to_string(), "/b".to_string()]);
        let mut r2 = r2;
        r2.remove("/a").unwrap();
        r2.remove("/nope").unwrap();
        let (r3, _) = Registry::load(file);
        assert_eq!(r3.projects(), &["/b".to_string()]);
    }

    #[test]
    fn corrupt_file_is_backed_up_not_overwritten() {
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join("projects.json");
        std::fs::write(&file, "{ not json").unwrap();
        let (r, warn) = Registry::load(file.clone());
        assert!(r.projects().is_empty());
        let warn = warn.expect("warning");
        assert!(warn.contains(".corrupt-"));
        let backups: Vec<_> = std::fs::read_dir(tmp.path()).unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|n| n.starts_with("projects.json.corrupt-")).collect();
        assert_eq!(backups.len(), 1);
        assert_eq!(std::fs::read_to_string(tmp.path().join(&backups[0])).unwrap(), "{ not json");
        assert!(!file.exists() || std::fs::read_to_string(&file).unwrap() != "{ not json");
    }
}
