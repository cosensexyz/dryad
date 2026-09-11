import { describe, it, expect } from 'vitest';
import { createState, setRegistered, applyScanEvent, select, worktreesOf } from '../state';
import type { Project, Worktree, WorktreeStatus } from '../types';

const proj = (path: string): Project => ({ path, name: path.split('/').pop()!, mainRef: 'origin/master' });
const wt = (project: string, branch: string): Worktree => ({
  project, path: `${project}/.worktrees/${branch}`, primary: false, branch, head: 'abc', upstream: { kind: 'none' }, locked: null, prunable: null, merged: false, lastCommit: 1,
});
const status: WorktreeStatus = { counts: { staged: 1, unstaged: 0, untracked: 0 }, untracked: [] };

describe('scan event reduction', () => {
  it('fills rows in two phases and drops stale generations', () => {
    const s = createState();
    setRegistered(s, ['/r/a', '/r/b']);
    expect(s.projects.get('/r/a')?.scan).toBe('pending');
    expect(applyScanEvent(s, 'scan:started', { generation: 1, total: 2, full: true })).toBe(true);
    expect(applyScanEvent(s, 'project:scanned', { generation: 1, project: proj('/r/a'), worktrees: [wt('/r/a', 'x')] })).toBe(true);
    expect(worktreesOf(s, '/r/a')[0].status).toBeNull();
    expect(applyScanEvent(s, 'worktree:status', { generation: 1, project: '/r/a', path: '/r/a/.worktrees/x', status })).toBe(true);
    expect(worktreesOf(s, '/r/a')[0].status?.counts.staged).toBe(1);
    // a newer scan starts; a late event from generation 1 must be ignored
    applyScanEvent(s, 'scan:started', { generation: 2, total: 2, full: true });
    expect(worktreesOf(s, '/r/a')).toEqual([]);
    expect(applyScanEvent(s, 'project:scanned', { generation: 1, project: proj('/r/a'), worktrees: [wt('/r/a', 'x')] })).toBe(false);
    expect(worktreesOf(s, '/r/a')).toEqual([]);
    expect(s.scanning).toBe(true);
    applyScanEvent(s, 'scan:finished', { generation: 2 });
    expect(s.scanning).toBe(false);
  });

  it('partial scans keep existing rows and failures are recorded per level', () => {
    const s = createState();
    setRegistered(s, ['/r/a']);
    applyScanEvent(s, 'scan:started', { generation: 1, total: 1, full: true });
    applyScanEvent(s, 'project:scanned', { generation: 1, project: proj('/r/a'), worktrees: [wt('/r/a', 'x')] });
    applyScanEvent(s, 'scan:finished', { generation: 1 });
    setRegistered(s, ['/r/a', '/r/new']);
    applyScanEvent(s, 'scan:started', { generation: 2, total: 1, full: false });
    expect(worktreesOf(s, '/r/a').length).toBe(1);
    applyScanEvent(s, 'project:failed', { generation: 2, path: '/r/new', error: 'not a git repository' });
    expect(s.projects.get('/r/new')).toMatchObject({ scan: 'failed', error: 'not a git repository' });
    applyScanEvent(s, 'worktree:failed', { generation: 2, project: '/r/a', path: '/r/a/.worktrees/x', error: 'missing' });
    expect(worktreesOf(s, '/r/a')[0].error).toBe('missing');
    expect(s.finished).toBe(1);
  });

  it('a removed project is not resurrected by late scan events', () => {
    const s = createState();
    setRegistered(s, ['/r/a', '/r/b']);
    applyScanEvent(s, 'scan:started', { generation: 1, total: 1, full: true });
    applyScanEvent(s, 'project:scanned', { generation: 1, project: proj('/r/a'), worktrees: [wt('/r/a', 'x')] });
    setRegistered(s, ['/r/b']); // /r/a was removed from the registry
    expect(applyScanEvent(s, 'project:scanned', { generation: 1, project: proj('/r/a'), worktrees: [] })).toBe(false);
    expect(s.projects.has('/r/a')).toBe(false);
    expect(applyScanEvent(s, 'project:failed', { generation: 1, path: '/r/a', error: 'x' })).toBe(false);
    expect(s.projects.has('/r/a')).toBe(false);
  });

  it('selecting a worktree expands its project and remembers it', () => {
    const s = createState();
    select(s, { kind: 'worktree', project: '/r/a', path: '/r/a/.worktrees/x' });
    expect(s.expanded.has('/r/a')).toBe(true);
    expect(s.lastWorktree).toBe('/r/a/.worktrees/x');
    select(s, { kind: 'project', path: '/r/a' });
    expect(s.lastWorktree).toBe('/r/a/.worktrees/x');
    expect(s.tab).toBe('workingTree');
  });
});
