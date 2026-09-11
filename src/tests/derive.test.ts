import { describe, it, expect } from 'vitest';
import { isDirty, isUnpushed, isMerged, isStale, compareRows, matchesText, chipsPass, relTime, absTime, flattenTree, DEFAULT_DIR, type Row } from '../derive';
import { createState, setRegistered, applyScanEvent } from '../state';
import type { Project, Worktree, WorktreeStatus, Upstream } from '../types';

const D = 86400, NOW = 1_788_948_000; // 2026-09-09 10:00 UTC
const proj: Project = { path: '/r/nova', name: 'nova', mainRef: 'origin/master' };
const mkRow = (branch: string | null, o: Partial<Worktree> = {}, st: Partial<WorktreeStatus> | null = {}, up: Upstream = { kind: 'tracking', name: 'o', ahead: 0, behind: 0 }): Row => ({
  project: proj,
  entry: {
    wt: { project: proj.path, path: `/r/nova/.worktrees/${branch ?? 'det'}`, primary: false, branch, head: '9f3a1c2e', upstream: up, locked: null, prunable: null, merged: false, lastCommit: NOW - 2 * D, ...o },
    status: st === null ? null : { counts: { staged: 0, unstaged: 0, untracked: 0 }, untracked: [], ...st },
    error: null,
  },
});

describe('judgements', () => {
  it('dirty / unpushed / merged / stale follow the design definitions', () => {
    expect(isDirty(mkRow('a', {}, { counts: { staged: 0, unstaged: 0, untracked: 4 } }))).toBe(true);
    expect(isDirty(mkRow('a', {}, null))).toBe(false);
    expect(isUnpushed(mkRow('a', {}, {}, { kind: 'tracking', name: 'o', ahead: 3, behind: 0 }))).toBe(true);
    expect(isUnpushed(mkRow('a', {}, {}, { kind: 'none' }))).toBe(true);
    expect(isUnpushed(mkRow('a', {}, {}, { kind: 'gone', name: 'o' }))).toBe(true);
    expect(isUnpushed(mkRow('a', {}, {}, { kind: 'tracking', name: 'o', ahead: 0, behind: 2 }))).toBe(false);
    expect(isMerged(mkRow('a', { merged: true }))).toBe(true);
    expect(isMerged(mkRow('a', { merged: null }))).toBe(false);
    expect(isStale(mkRow('a', { lastCommit: NOW - 41 * D }), 30, NOW)).toBe(true);
    expect(isStale(mkRow('a', { lastCommit: NOW - 30 * D }), 30, NOW)).toBe(false);
  });

  it('chips combine with AND', () => {
    const r = mkRow('a', { merged: true }, { counts: { staged: 0, unstaged: 0, untracked: 0 } });
    expect(chipsPass(r, { dirty: false, unpushed: false, merged: true, stale: false }, 30, NOW)).toBe(true);
    expect(chipsPass(r, { dirty: true, unpushed: false, merged: true, stale: false }, 30, NOW)).toBe(false);
  });
});

describe('sorting and text filter', () => {
  it('default project sort puts the primary worktree first; last-commit ascending is newest first', () => {
    const primary = mkRow('master', { primary: true, lastCommit: NOW - 2 * D });
    const feat = mkRow('feat', { lastCommit: NOW - 5 * 3600 });
    const old = mkRow('old', { lastCommit: NOW - 41 * D });
    const rows = [old, feat, primary];
    rows.sort((a, b) => compareRows(a, b, 'project', 1));
    expect(rows.map((r) => r.entry.wt.branch)).toEqual(['master', 'feat', 'old']);
    rows.sort((a, b) => compareRows(a, b, 'last', DEFAULT_DIR.last));
    expect(rows[0].entry.wt.branch).toBe('feat');
    rows.sort((a, b) => compareRows(a, b, 'changes', DEFAULT_DIR.changes));
    expect(DEFAULT_DIR.changes).toBe(-1);
  });

  it('text filter matches project, branch and path case-insensitively', () => {
    const r = mkRow('iodc-endpoint-url');
    expect(matchesText(r, 'IODC')).toBe(true);
    expect(matchesText(r, 'nova')).toBe(true);
    expect(matchesText(r, '.worktrees/iodc')).toBe(true);
    expect(matchesText(r, 'zzz')).toBe(false);
    expect(matchesText(r, '')).toBe(true);
  });
});

describe('time formatting', () => {
  it('relative and absolute', () => {
    expect(relTime(NOW - 5 * 3600, NOW)).toBe('5h ago');
    expect(relTime(NOW - 41 * D, NOW)).toBe('41d ago');
    expect(relTime(NOW - 90, NOW)).toBe('2m ago');
    expect(absTime(NOW)).toBe('2026-09-09 10:00 UTC');
  });
});

describe('tree', () => {
  it('sorts projects by name, nests worktrees under expanded projects, filters by query', () => {
    const s = createState();
    setRegistered(s, ['/r/nova', '/r/grasp']);
    applyScanEvent(s, 'scan:started', { generation: 1, total: 2, full: true });
    const wts = (p: string, names: string[]): Worktree[] => names.map((b, i) => ({ project: p, path: `${p}/.worktrees/${b}`, primary: i === 0, branch: b, head: 'a', upstream: { kind: 'tracking', name: 'o', ahead: 0, behind: 0 }, locked: null, prunable: null, merged: false, lastCommit: NOW }));
    applyScanEvent(s, 'project:scanned', { generation: 1, project: { path: '/r/nova', name: 'nova', mainRef: 'origin/master' }, worktrees: wts('/r/nova', ['master', 'iodc']) });
    applyScanEvent(s, 'project:scanned', { generation: 1, project: { path: '/r/grasp', name: 'grasp', mainRef: 'origin/master' }, worktrees: wts('/r/grasp', ['master', 'parser']) });
    s.expanded.add('/r/nova');
    let nodes = flattenTree(s, NOW);
    expect(nodes.map((n) => n.label)).toEqual(['All projects', 'grasp', 'nova', 'master', 'iodc']);
    s.query = 'iodc';
    nodes = flattenTree(s, NOW);
    expect(nodes.map((n) => n.label)).toEqual(['All projects', 'nova', 'iodc']);
    s.query = '';
    s.expanded.clear();
    expect(flattenTree(s, NOW).map((n) => n.label)).toEqual(['All projects', 'grasp', 'nova']);
  });
});
