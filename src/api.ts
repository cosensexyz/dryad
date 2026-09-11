import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { DiffFile, DiffTab, Patch, StartupInfo, WorktreeStatus } from './types';

export type ScanEventName = 'scan:started' | 'project:scanned' | 'project:failed' | 'worktree:status' | 'worktree:failed' | 'scan:finished';
const SCAN_EVENTS: ScanEventName[] = ['scan:started', 'project:scanned', 'project:failed', 'worktree:status', 'worktree:failed', 'scan:finished'];

export const api = {
  startupInfo: () => invoke<StartupInfo>('startup_info'),
  listProjects: () => invoke<string[]>('list_projects'),
  addProject: (dir: string) => invoke<string>('add_project', { dir }),
  removeProject: (path: string) => invoke<void>('remove_project', { path }),
  scanAll: () => invoke<number>('scan_all'),
  worktreeStatusNow: (project: string, path: string) => invoke<WorktreeStatus>('worktree_status_now', { project, path }),
  diffFiles: (a: { project: string; worktree: string; head: string; tab: DiffTab; mainRef: string | null; untracked: string[] }) =>
    invoke<{ files: DiffFile[]; truncated: boolean }>('diff_files', a),
  diffPatch: (a: { project: string; worktree: string; head: string; tab: DiffTab; mainRef: string | null; path: string; oldPath: string | null; staged: boolean; untracked: boolean }) =>
    invoke<Patch>('diff_patch', a),
  setStaleDays: (days: number) => invoke<number>('set_stale_days', { days }),
  setPaneWidths: (a: { sidebar: number; files: number }) => invoke<void>('set_pane_widths', a),
};

export async function onScanEvents(handler: (name: ScanEventName, payload: unknown) => void): Promise<() => void> {
  const unlisteners = await Promise.all(SCAN_EVENTS.map((name) => listen(name, (e) => handler(name, e.payload))));
  return () => unlisteners.forEach((u) => u());
}
