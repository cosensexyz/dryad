# Dryad

Read-only desktop viewer for every git worktree of every project you add: uncommitted changes, unpushed commits, merge state, idle time, and per-worktree diffs. Design: `DESIGN.md`; UI prototype: `design/`.

## Build

- Rust stable, Node 22, `git` on PATH.
- Linux: `libwebkit2gtk-4.1-dev` and the packages listed in `.github/workflows/ci.yml` (Ubuntu 22.04+ / Debian 12+).
- Windows: WebView2 runtime (bundled with Windows 10/11).

```sh
npm ci
npm run tauri dev        # run
npm test && cargo test --manifest-path src-tauri/Cargo.toml
npm run tauri build      # bundles under src-tauri/target/release/bundle/
```

Using make (macOS/Linux): `make install` once, then `make dev`, `make check`,
`make build`; `make help` lists every target. Windows contributors use the
npm/cargo commands above directly.

## Versioning and releases

`package.json` is the source of the app version. Tauri reads it through
`"version": "../package.json"`; the Rust package and both lockfiles must match.
Use stable `X.Y.Z` versions without a `v` prefix. Prerelease and build suffixes
are not supported by these commands yet. Release tags use `vX.Y.Z`.

```sh
npm run version:set -- 0.3.0
npm run version:check
```

`version:set` updates the npm and Cargo manifests and their lockfiles without
upgrading dependencies, committing, or tagging. Review the diff, run `make check`
(or `npm run version:check`, `npm test`, `npx tsc --noEmit`, and
`cargo test --manifest-path src-tauri/Cargo.toml`), then commit the version changes
and merge them into `master` through the normal workflow. Use `version:set`
instead of editing individual versions or running `npm version`.

On a clean checkout of `master` at the intended release commit:

```sh
npm run release:tag
git push origin master
git push origin v0.3.0
```

`release:tag` derives the name from `package.json` and creates an annotated tag
on `HEAD`. It refuses version mismatches, uncommitted or untracked changes, and
an existing tag. It does not push anything; the push example above assumes the
version was set to `0.3.0`.

CI checks version consistency before tests and bundles. A tag-triggered build
also requires the triggering tag to equal `v${package.json.version}`; a mismatch
stops the build. Branch and PR checks do not require a tag or compare against the
most recent historical tag. Local `npm run build` and `make check` also check
versions. Tagged builds produce the platform bundles as workflow artifacts.
