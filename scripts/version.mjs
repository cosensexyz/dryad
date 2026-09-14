import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const read = path => readFileSync(path, 'utf8');
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const requireThat = (condition, message) => { if (!condition) throw new Error(message); };

// Keep TOML formatting and dependency versions intact; only edit the app's table.
function tomlVersion(path, table) {
  const text = read(path);
  const block = text.match(table)?.[0];
  const field = /^version[ \t]*=[ \t]*"([^"\r\n]+)"/m;
  const version = block?.match(field)?.[1];
  requireThat(version, `${path}: cannot find the app version`);
  return { path, version, update: value => text.replace(block, block.replace(field, `version = "${value}"`)) };
}

try {
  const [command, target, ...extra] = process.argv.slice(2);
  requireThat(extra.length === 0 && (
    (command === 'set' && target !== undefined) ||
    (['check', 'tag'].includes(command) && target === undefined)
  ), 'Usage: node scripts/version.mjs set X.Y.Z | check | tag');

  const pkg = JSON.parse(read('package.json'));
  const version = command === 'set' ? target : pkg.version;
  requireThat(typeof version === 'string' && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version),
    'Version must be stable X.Y.Z (no v prefix, leading zeros, or prerelease/build suffix)');
  const npmLock = JSON.parse(read('package-lock.json'));
  const tauri = JSON.parse(read('src-tauri/tauri.conf.json'));
  requireThat(tauri.version === '../package.json', 'src-tauri/tauri.conf.json: version must reference ../package.json');
  requireThat(npmLock.packages?.[''], 'package-lock.json: missing root package');
  const cargo = tomlVersion('src-tauri/Cargo.toml', /^\[package\][ \t]*\r?\n[\s\S]*?(?=^\[|(?![\s\S]))/m);
  const cargoLock = tomlVersion('src-tauri/Cargo.lock', /^\[\[package\]\]\r?\nname = "dryad"\r?\n[\s\S]*?(?=^\[|(?![\s\S]))/m);

  if (command === 'set') {
    pkg.version = npmLock.version = npmLock.packages[''].version = version;
    // Prepare every output before writing, so malformed input cannot cause partial updates.
    const updates = [
      ['package.json', JSON.stringify(pkg, null, 2) + '\n'],
      ['package-lock.json', JSON.stringify(npmLock, null, 2) + '\n'],
      [cargo.path, cargo.update(version)],
      [cargoLock.path, cargoLock.update(version)],
    ];
    for (const [path, text] of updates) writeFileSync(path, text);
    console.log(`Set app version to ${version}. Review and commit the changes before release:tag.`);
  } else {
    for (const [path, actual] of [
      ['package-lock.json', npmLock.version],
      ['package-lock.json root package', npmLock.packages[''].version],
      [cargo.path, cargo.version],
      [cargoLock.path, cargoLock.version],
    ]) requireThat(actual === version, `${path}: found ${actual}, expected ${version}`);

    const tag = `v${version}`;
    if (process.env.GITHUB_REF_TYPE === 'tag') {
      requireThat(process.env.GITHUB_REF_NAME === tag, `Release tag: found ${process.env.GITHUB_REF_NAME}, expected ${tag}`);
    }
    if (command === 'tag') {
      requireThat(git('status', '--porcelain=v1', '--untracked-files=all') === '', 'A clean working tree is required; commit or stash changes first.');
      requireThat(git('tag', '--list', tag) === '', `Tag ${tag} already exists`);
      git('tag', '-a', tag, '-m', `Dryad ${tag}`, 'HEAD');
      console.log(`Created ${tag}. Push the release commit and this tag when ready.`);
    } else {
      console.log(`Version ${version}: manifests, lockfiles, and Tauri reference agree${process.env.GITHUB_REF_TYPE === 'tag' ? ` with ${tag}` : ''}.`);
    }
  }
} catch (error) {
  console.error(error.stderr?.toString().trim() || error.message);
  process.exitCode = 1;
}
