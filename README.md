# Dryad

Read-only desktop viewer for every git worktree of every project you add: uncommitted changes, unpushed commits, merge state, idle time, and per-worktree diffs. Design: `DESIGN.md`; UI prototype: `design/`.

## Build

- Rust stable, Node 22, `git` on PATH.
- Linux: `libwebkit2gtk-4.1-dev` and the packages listed in `.github/workflows/ci.yml` (Ubuntu 22.04+ / Debian 12+).
- Windows: WebView2 runtime (bundled with Windows 10/11).

    npm ci
    npm run tauri dev        # run
    npm test && cargo test --manifest-path src-tauri/Cargo.toml
    npm run tauri build      # bundles under src-tauri/target/release/bundle/
