mod common;
use common::TempRepo;
use dryad_lib::git::Git;
use dryad_lib::registry::{toplevel, RegistryError};
use std::time::Duration;

fn git() -> Git { Git::new(dryad_lib::git::locate().unwrap(), Duration::from_secs(30), 4) }

#[tokio::test]
async fn toplevel_normalizes_subdirectories_and_rejects_non_repos() {
    let t = TempRepo::new();
    let sub = t.root.join("src");
    std::fs::create_dir_all(&sub).unwrap();
    let g = git();
    let top = toplevel(&g, &sub).await.unwrap();
    assert_eq!(std::path::Path::new(&top).canonicalize().unwrap(), t.root.canonicalize().unwrap());
    let err = toplevel(&g, t.dir.path()).await.unwrap_err();
    assert!(matches!(err, RegistryError::NotARepo(_)));
}
