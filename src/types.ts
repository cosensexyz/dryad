export interface Project { path: string; name: string; mainRef: string | null; }
export type Upstream =
  | { kind: 'tracking'; name: string; ahead: number; behind: number }
  | { kind: 'none' }
  | { kind: 'gone'; name: string };
export interface Worktree {
  project: string; path: string; primary: boolean; branch: string | null; head: string; upstream: Upstream;
  locked: string | null; prunable: string | null; merged: boolean | null; lastCommit: number | null;
}
export interface Counts { staged: number; unstaged: number; untracked: number; }
export interface WorktreeStatus { counts: Counts; untracked: string[]; }
export type Change = 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked';
export interface DiffFile { path: string; oldPath: string | null; change: Change; staged: boolean; added: number; deleted: number; binary: boolean; }
export interface DiffLine { sign: ' ' | '+' | '-'; text: string; }
export interface Hunk { header: string; oldStart: number; newStart: number; lines: DiffLine[]; }
export interface Patch { path: string; hunks: Hunk[]; truncated: boolean; }
export type DiffTab = 'workingTree' | 'branch';

/** Scan events emitted by the backend; every payload carries the scan generation. */
export interface ScanStarted { generation: number; total: number; }
export interface ProjectScanned { generation: number; project: Project; worktrees: Worktree[]; }
export interface ProjectFailed { generation: number; path: string; error: string; }
export interface WorktreeStatusEvent { generation: number; project: string; path: string; status: WorktreeStatus; }
export interface WorktreeFailed { generation: number; project: string; path: string; error: string; }
export interface ScanFinished { generation: number; }
export interface StartupInfo { gitError: string | null; registryWarning: string | null; staleDays: number; }
