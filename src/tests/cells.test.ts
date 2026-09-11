import { describe, it, expect } from 'vitest';
import { cellsFor, worktreeNotice } from '../views';
import type { Row } from '../derive';
import type { Worktree, WorktreeStatus } from '../types';

const NOW = 1_788_948_000, D = 86400;
const row = (wt: Partial<Worktree>, status: WorktreeStatus | null, error: string | null = null): Row => ({
  project: { path: '/r/x', name: 'x', mainRef: 'origin/master' },
  entry: { wt: { project: '/r/x', path: '/r/x/.worktrees/b', primary: false, branch: 'b', head: '9f3a1c2e0000', upstream: { kind: 'tracking', name: 'o', ahead: 0, behind: 0 }, locked: null, prunable: null, merged: false, lastCommit: NOW - 41 * D, ...wt }, status, error },
});
const st = (c: [number, number, number]): WorktreeStatus => ({ counts: { staged: c[0], unstaged: c[1], untracked: c[2] }, untracked: [] });

describe('cellsFor', () => {
  it('distinguishes pending, clean and not-applicable; upstream never waits for the status', () => {
    expect(cellsFor(row({ upstream: { kind: 'none' } }, null), 30, NOW)).toMatchObject({ changes: '…', changesClass: 'pending', up: 'none', upClass: 'c-ahead' });
    expect(cellsFor(row({}, st([0, 0, 0])), 30, NOW)).toMatchObject({ changes: '–', changesClass: 'clean', up: '=', upClass: 'clean' });
    expect(cellsFor(row({ upstream: { kind: 'tracking', name: 'origin/b', ahead: 1, behind: 0 } }, null, 'worktree directory is missing'), 30, NOW))
      .toMatchObject({ changes: '—', changesClass: 'na', up: '↑1', upClass: 'c-ahead', err: 'worktree directory is missing' });
  });
  it('formats counts, upstream variants, merged tri-state, badges and staleness', () => {
    const c = cellsFor(row({ primary: true, locked: 'busy', merged: null, upstream: { kind: 'gone', name: 'origin/b' } }, st([2, 1, 4])), 30, NOW);
    expect(c).toMatchObject({ changes: '+2 ~1 ?4', changesClass: 'c-dirty', up: 'gone', upClass: 'c-err', upName: 'origin/b (gone)', merged: 'main ref', mergedClass: 'na', last: '41d ago', lastClass: 'c-stale' });
    expect(c.badges).toEqual(['primary', 'locked']);
    expect(cellsFor(row({ branch: null, upstream: { kind: 'none' } }, st([0, 0, 0])), 30, NOW)).toMatchObject({ wtLabel: '(detached 9f3a1c2e)', up: 'none', upClass: 'c-ahead' });
    expect(cellsFor(row({ merged: true, upstream: { kind: 'tracking', name: 'o', ahead: 3, behind: 2 } }, st([0, 0, 0])), 30, NOW)).toMatchObject({ up: '↑3 ↓2', upClass: 'c-ahead', upName: 'o ↑3 ↓2', merged: 'yes', mergedClass: 'c-merged' });
  });
});

describe('worktreeNotice', () => {
  const p = { project: { path: '/r/x', name: 'x', mainRef: 'origin/master' }, scan: 'done' as const, error: null };
  const base = row({ upstream: { kind: 'none' } }, st([0, 0, 0]));
  it('working tree tab', () => {
    const s = { tab: 'workingTree', diffError: null, diffLoading: false } as any;
    expect(worktreeNotice(s, p, base.entry, { files: [], truncated: false })).toBe('No uncommitted changes.');
    expect(worktreeNotice(s, p, base.entry, { files: [{ path: 'n', oldPath: null, change: 'untracked', staged: false, added: 0, deleted: 0, binary: false }], truncated: false })).toBe('Only untracked files — git has no diff for them.');
    expect(worktreeNotice(s, p, { ...base.entry, status: null }, undefined)).toBe('Waiting for the scan to reach this worktree…');
    expect(worktreeNotice(s, p, { ...base.entry, error: 'gone' }, undefined)).toBe('Status unavailable: gone');
    expect(worktreeNotice({ ...s, diffLoading: true }, p, base.entry, undefined)).toBe('Loading…');
    expect(worktreeNotice(s, p, base.entry, { files: [{ path: 'a', oldPath: null, change: 'modified', staged: true, added: 1, deleted: 0, binary: false }], truncated: false })).toBe('');
  });
  it('branch tab', () => {
    const s = { tab: 'branch', diffError: null, diffLoading: false } as any;
    expect(worktreeNotice(s, p, { ...base.entry, wt: { ...base.entry.wt, primary: true } }, undefined)).toBe('This worktree is on the main ref; there is nothing to compare against.');
    expect(worktreeNotice(s, p, { ...base.entry, wt: { ...base.entry.wt, merged: true } }, undefined)).toBe('Already an ancestor of origin/master — no commits beyond it.');
    expect(worktreeNotice(s, { ...p, project: { ...p.project, mainRef: null } }, base.entry, undefined)).toBe('No main ref resolved for this project.');
    expect(worktreeNotice(s, p, base.entry, { files: [], truncated: false })).toBe('No differences against origin/master.');
  });
});
