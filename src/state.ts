import type { DiffFile, DiffTab, Patch, Project, Worktree, WorktreeStatus } from './types';
import type { ScanEventName } from './api';

export type Selection = { kind: 'root' } | { kind: 'project'; path: string } | { kind: 'worktree'; project: string; path: string };
export type SortKey = 'project' | 'worktree' | 'changes' | 'upstream' | 'merged' | 'last';
export interface ProjectEntry { project: Project; scan: 'pending' | 'done' | 'failed'; error: string | null; }
export interface WorktreeEntry { wt: Worktree; status: WorktreeStatus | null; error: string | null; }

export interface State {
  generation: number; scanning: boolean; total: number; finished: number;
  projects: Map<string, ProjectEntry>;
  worktrees: Map<string, WorktreeEntry>;
  selection: Selection; lastWorktree: string | null;
  expanded: Set<string>; query: string;
  chips: { dirty: boolean; unpushed: boolean; merged: boolean; stale: boolean };
  sort: { key: SortKey; dir: 1 | -1 };
  staleDays: number;
  tab: DiffTab; fileByTab: { workingTree: string | null; branch: string | null };
  /** Diff cache keyed by `${worktree}|${tab}` (lists) and `${worktree}|${tab}|${path}` (patches); cleared on scan:started. */
  diffLists: Map<string, { files: DiffFile[]; truncated: boolean }>;
  diffPatches: Map<string, Patch>;
  diffSeq: number; diffLoading: boolean; diffError: string | null;
  gitError: string | null; registryWarning: string | null;
}

export const listKey = (wt: string, tab: DiffTab) => `${wt}|${tab}`;
export const patchKey = (wt: string, tab: DiffTab, path: string) => `${wt}|${tab}|${path}`;

export function createState(): State {
  return {
    generation: 0, scanning: false, total: 0, finished: 0,
    projects: new Map(), worktrees: new Map(),
    selection: { kind: 'root' }, lastWorktree: null,
    expanded: new Set(), query: '',
    chips: { dirty: false, unpushed: false, merged: false, stale: false },
    sort: { key: 'project', dir: 1 }, staleDays: 30,
    tab: 'workingTree', fileByTab: { workingTree: null, branch: null },
    diffLists: new Map(), diffPatches: new Map(),
    diffSeq: 0, diffLoading: false, diffError: null,
    gitError: null, registryWarning: null,
  };
}

/** Registered paths appear immediately as pending projects; unregistered ones disappear with their worktrees. */
export function setRegistered(s: State, paths: string[]): void {
  for (const p of paths) {
    if (!s.projects.has(p)) s.projects.set(p, { project: { path: p, name: p.split(/[\\/]/).filter(Boolean).pop() ?? p, mainRef: null }, scan: 'pending', error: null });
  }
  for (const p of [...s.projects.keys()]) if (!paths.includes(p)) { s.projects.delete(p); dropWorktrees(s, p); }
}

function dropWorktrees(s: State, project: string): void {
  for (const [k, e] of s.worktrees) if (e.wt.project === project) s.worktrees.delete(k);
}

export function worktreesOf(s: State, project: string): WorktreeEntry[] {
  return [...s.worktrees.values()].filter((e) => e.wt.project === project);
}

type P = Record<string, any>;

/** Reduce one scan event. Returns false when the event belongs to a superseded generation. */
export function applyScanEvent(s: State, name: ScanEventName, payload: unknown): boolean {
  const p = payload as P;
  if (name === 'scan:started') {
    if (p.generation < s.generation) return false;
    s.generation = p.generation; s.scanning = true; s.total = p.total; s.finished = 0;
    s.diffLists.clear(); s.diffPatches.clear();
    if (p.full) { for (const e of s.projects.values()) { e.scan = 'pending'; e.error = null; } s.worktrees.clear(); }
    return true;
  }
  if (p.generation !== s.generation) return false;
  switch (name) {
    case 'project:scanned': {
      const path = p.project.path as string;
      s.projects.set(path, { project: p.project, scan: 'done', error: null });
      dropWorktrees(s, path);
      for (const wt of p.worktrees as Worktree[]) s.worktrees.set(wt.path, { wt, status: null, error: null });
      s.finished += 1;
      break;
    }
    case 'project:failed': {
      const cur = s.projects.get(p.path);
      s.projects.set(p.path, { project: cur?.project ?? { path: p.path, name: p.path.split(/[\\/]/).pop() ?? p.path, mainRef: null }, scan: 'failed', error: p.error });
      dropWorktrees(s, p.path);
      s.finished += 1;
      break;
    }
    case 'worktree:status': { const e = s.worktrees.get(p.path); if (e) { e.status = p.status; e.error = null; } break; }
    case 'worktree:failed': { const e = s.worktrees.get(p.path); if (e) { e.error = p.error; } break; }
    case 'scan:finished': s.scanning = false; break;
  }
  return true;
}

export function select(s: State, sel: Selection): void {
  s.selection = sel;
  s.tab = 'workingTree';
  s.fileByTab = { workingTree: null, branch: null };
  if (sel.kind === 'worktree') { s.lastWorktree = sel.path; s.expanded.add(sel.project); }
}
