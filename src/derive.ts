import type { Project } from './types';
import type { SortKey, State, WorktreeEntry } from './state';

export interface Row { project: Project; entry: WorktreeEntry; }
export type Chips = State['chips'];
const D = 86400;

export const isDirty = (r: Row): boolean => {
  const c = r.entry.status?.counts; return !!c && c.staged + c.unstaged + c.untracked > 0;
};
export const isUnpushed = (r: Row): boolean => {
  const u = r.entry.wt.upstream;
  return u.kind === 'none' || u.kind === 'gone' || u.ahead > 0;
};
export const isMerged = (r: Row): boolean => r.entry.wt.merged === true;
export const isStale = (r: Row, staleDays: number, nowSec: number): boolean =>
  r.entry.wt.lastCommit !== null && nowSec - r.entry.wt.lastCommit > staleDays * D;

export function chipsPass(r: Row, chips: Chips, staleDays: number, nowSec: number): boolean {
  if (chips.dirty && !isDirty(r)) return false;
  if (chips.unpushed && !isUnpushed(r)) return false;
  if (chips.merged && !isMerged(r)) return false;
  if (chips.stale && !isStale(r, staleDays, nowSec)) return false;
  return true;
}

export function matchesText(r: Row, q: string): boolean {
  const s = q.trim().toLowerCase();
  if (!s) return true;
  return [r.project.name, r.project.path, r.entry.wt.branch ?? r.entry.wt.head, r.entry.wt.path].join(' ').toLowerCase().includes(s);
}

export const DEFAULT_DIR: Record<SortKey, 1 | -1> = { project: 1, worktree: 1, changes: -1, upstream: -1, merged: 1, last: 1 };

const wtLabel = (r: Row) => r.entry.wt.branch ?? `~${r.entry.wt.head}`;
const projectKey = (r: Row): (string | number)[] => [r.project.name, r.entry.wt.primary ? 0 : 1, r.entry.wt.branch ?? '~'];

function keyOf(r: Row, key: SortKey): (string | number)[] {
  const c = r.entry.status?.counts, u = r.entry.wt.upstream;
  switch (key) {
    case 'project': return projectKey(r);
    case 'worktree': return [wtLabel(r)];
    case 'changes': return [c ? c.staged + c.unstaged + c.untracked : -1];
    case 'upstream': return [u.kind === 'tracking' ? u.ahead : -1, u.kind === 'tracking' ? u.behind : 0];
    case 'merged': return [r.entry.wt.merged === true ? 0 : r.entry.wt.merged === false ? 1 : 2];
    // ascending = newest first (the prototype sorts by age); unknown dates sort last
    case 'last': return [r.entry.wt.lastCommit === null ? Number.MAX_SAFE_INTEGER : -r.entry.wt.lastCommit];
  }
}

function cmp(a: (string | number)[], b: (string | number)[]): number {
  for (let i = 0; i < a.length; i++) {
    const x = a[i], y = b[i];
    if (x === y) continue;
    if (typeof x === 'number' && typeof y === 'number') return x - y;
    return String(x).localeCompare(String(y));
  }
  return 0;
}

export function compareRows(a: Row, b: Row, key: SortKey, dir: 1 | -1): number {
  return dir * cmp(keyOf(a, key), keyOf(b, key)) || cmp(projectKey(a), projectKey(b));
}

export function relTime(unix: number, now: number): string {
  const age = Math.max(0, now - unix);
  if (age < 3600) return `${Math.max(1, Math.round(age / 60))}m ago`;
  if (age < D) return `${Math.round(age / 3600)}h ago`;
  return `${Math.round(age / D)}d ago`;
}
export const absTime = (unix: number): string => new Date(unix * 1000).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';

export interface TreeNode {
  kind: 'root' | 'project' | 'worktree'; key: string; label: string; project?: string;
  expanded?: boolean; counts?: { dirty: number; unpushed: number; merged: number; stale: number };
  failed?: boolean; scanning?: boolean; pending?: boolean; error?: string | null;
}

export function rowsOf(s: State, project: string): Row[] {
  const p = s.projects.get(project); if (!p) return [];
  return [...s.worktrees.values()].filter((e) => e.wt.project === project).map((entry) => ({ project: p.project, entry }));
}

export function flattenTree(s: State, nowSec: number): TreeNode[] {
  const q = s.query.trim().toLowerCase();
  const nodes: TreeNode[] = [{ kind: 'root', key: 'root', label: 'All projects' }];
  const projects = [...s.projects.values()].sort((a, b) => a.project.name.localeCompare(b.project.name));
  for (const p of projects) {
    const rows = rowsOf(s, p.project.path);
    const nameHit = q !== '' && p.project.name.toLowerCase().includes(q);
    const hits = q ? rows.filter((r) => matchesText(r, q)) : rows;
    if (q && !nameHit && hits.length === 0) continue;
    const expanded = s.expanded.has(p.project.path) || (q !== '' && !nameHit);
    nodes.push({
      kind: 'project', key: p.project.path, label: p.project.name, project: p.project.path, expanded,
      failed: p.scan === 'failed', error: p.error, scanning: p.scan === 'pending' && s.scanning,
      counts: { dirty: rows.filter(isDirty).length, unpushed: rows.filter(isUnpushed).length, merged: rows.filter(isMerged).length, stale: rows.filter((r) => isStale(r, s.staleDays, nowSec)).length },
    });
    if (!expanded || p.scan === 'failed') continue;
    for (const r of (q && !nameHit ? hits : rows).sort((a, b) => compareRows(a, b, 'project', 1))) {
      nodes.push({ kind: 'worktree', key: r.entry.wt.path, label: r.entry.wt.branch ?? `(detached ${r.entry.wt.head.slice(0, 8)})`, project: p.project.path, pending: r.entry.status === null && !r.entry.error, error: r.entry.error });
    }
  }
  return nodes;
}
