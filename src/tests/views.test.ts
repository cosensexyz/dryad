import { describe, it, expect } from 'vitest';
import { scrollRestore, currentFile, dragWidth, type ScrollSnap } from '../views';
import { createState } from '../state';
import type { DiffFile } from '../types';

const snap = (over: Partial<ScrollSnap> = {}): ScrollSnap => ({ view: '/w|workingTree', file: 'a.txt', filesTop: 120, diffTop: 340, ...over });

describe('scrollRestore', () => {
  it('keeps both panes within the same view and file', () => {
    expect(scrollRestore(snap(), { view: '/w|workingTree', file: 'a.txt' })).toEqual({ filesTop: 120, diffTop: 340 });
  });
  it('keeps the file list but resets the diff when another file is shown', () => {
    expect(scrollRestore(snap(), { view: '/w|workingTree', file: 'b.txt' })).toEqual({ filesTop: 120, diffTop: 0 });
  });
  it('resets both when the worktree or tab changes', () => {
    expect(scrollRestore(snap(), { view: '/w|branch', file: 'a.txt' })).toEqual({ filesTop: 0, diffTop: 0 });
    expect(scrollRestore(snap(), { view: '/other|workingTree', file: 'a.txt' })).toEqual({ filesTop: 0, diffTop: 0 });
  });
  it('resets both without a previous snapshot', () => {
    expect(scrollRestore(null, { view: '/w|workingTree', file: 'a.txt' })).toEqual({ filesTop: 0, diffTop: 0 });
  });
});

const file = (path: string, change: DiffFile['change']): DiffFile => ({ path, oldPath: null, change, staged: false, added: 0, deleted: 0, binary: false });

describe('dragWidth', () => {
  it('applies the drag delta inside the bounds', () => {
    expect(dragWidth(260, 40, 1200, 160, 360)).toBe(300);
  });
  it('clamps to the minimum', () => {
    expect(dragWidth(260, -200, 1200, 160, 360)).toBe(160);
  });
  it('clamps to the container minus the reserve', () => {
    expect(dragWidth(260, 900, 1000, 160, 360)).toBe(640);
  });
  it('keeps the minimum when the container cannot hold both sides', () => {
    expect(dragWidth(260, 0, 400, 160, 360)).toBe(160);
  });
  it('rounds fractional widths', () => {
    expect(dragWidth(260.4, 0.4, 1200, 160, 360)).toBe(261);
  });
});

describe('currentFile', () => {
  it('prefers the remembered file, including an untracked one', () => {
    const s = createState();
    s.tab = 'workingTree';
    s.fileByTab.workingTree = 'new.txt';
    const list = { files: [file('a.txt', 'modified'), file('new.txt', 'untracked')] };
    expect(currentFile(s, list)?.path).toBe('new.txt');
  });
  it('falls back to the first file and tolerates a missing list', () => {
    const s = createState();
    s.tab = 'workingTree';
    const list = { files: [file('new.txt', 'untracked'), file('a.txt', 'modified')] };
    expect(currentFile(s, list)?.path).toBe('new.txt');
    expect(currentFile(s, undefined)).toBeUndefined();
    expect(currentFile(s, { files: [] })).toBeUndefined();
  });
});
