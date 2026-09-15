import { describe, it, expect } from 'vitest';
import { gapRequest, patchRows } from '../diffview';
import type { DiffLine, GapContext, Hunk, Patch } from '../types';

const ctx = (over: Partial<GapContext> = {}): GapContext => ({ down: [], up: [], total: null, pending: null, error: null, ...over });
const patch = (hunks: Hunk[], truncated = false): Patch => ({ path: 'x', truncated, binary: false, hunks });
const hunk = (header: string, oldStart: number, oldCount: number, newStart: number, newCount: number, lines: DiffLine[]): Hunk =>
  ({ header, oldStart, oldCount, newStart, newCount, lines });

describe('patchRows', () => {
  it('numbers old and new sides independently and keeps hunk headers', () => {
    const rows = patchRows(patch([hunk('@@ -18,3 +18,4 @@ impl', 18, 3, 18, 4, [
      { sign: ' ', text: 'a' }, { sign: '-', text: 'b' }, { sign: '+', text: 'b2' }, { sign: '+', text: 'c' },
    ])]));
    expect(rows.map((r) => [r.kind, r.n1, r.n2, r.text])).toEqual([
      ['gap', '', '', ''],
      ['hunk', '', '', '@@ -18,3 +18,4 @@ impl'],
      ['ctx', '18', '18', 'a'],
      ['del', '19', '', 'b'],
      ['add', '', '19', 'b2'],
      ['add', '', '20', 'c'],
      ['gap', '', '', ''],
    ]);
    expect(rows[0].gap).toMatchObject({ id: 0, remaining: 17, canUp: false, canDown: false });
    expect(rows[6].gap).toMatchObject({ id: 1, remaining: null, canUp: false, canDown: true });
    expect(patchRows(patch([hunk('@@ -1,2 +1,3 @@', 1, 2, 1, 3, [])]))[0].kind).toBe('hunk');
  });

  it('merges revealed context into a gap and numbers it continuously', () => {
    const p = patch([
      hunk('@@ -10,3 +10,4 @@', 10, 3, 10, 4, [{ sign: '+', text: 'x' }]),
      hunk('@@ -40,2 +41,2 @@', 40, 2, 41, 2, [{ sign: '-', text: 'y' }]),
    ]);
    const contexts = new Map([[1, ctx({ down: ['d1', 'd2'], up: ['u1'] })]]);
    expect(patchRows(p, contexts).map((r) => [r.kind, r.n1, r.n2, r.text])).toEqual([
      ['gap', '', '', ''],
      ['hunk', '', '', '@@ -10,3 +10,4 @@'],
      ['add', '', '10', 'x'],
      ['ctx', '13', '14', 'd1'],
      ['ctx', '14', '15', 'd2'],
      ['gap', '', '', ''],
      ['ctx', '39', '40', 'u1'],
      ['hunk', '', '', '@@ -40,2 +41,2 @@'],
      ['del', '40', '', 'y'],
      ['gap', '', '', ''],
    ]);
    const rows = patchRows(p, contexts);
    expect(rows[0].gap).toMatchObject({ id: 0, remaining: 9 });
    expect(rows[5].gap).toMatchObject({ id: 1, remaining: 24, canUp: true, canDown: true });
    expect(rows[9].gap).toMatchObject({ id: 2, remaining: null });
  });

  it('drops a fully revealed gap and keeps its lines contiguous', () => {
    const p = patch([hunk('@@ -10 +10 @@', 10, 1, 10, 1, [])]);
    const full = ctx({ down: ['1', '2', '3', '4', '5'], up: ['6', '7', '8', '9'] });
    const rows = patchRows(p, new Map([[0, full]]));
    expect(rows.filter((r) => r.kind === 'gap').map((r) => r.gap!.id)).toEqual([1]);
    expect(rows.slice(0, 9).map((r) => [r.kind, r.n1, r.text])).toEqual([
      ['ctx', '1', '1'], ['ctx', '2', '2'], ['ctx', '3', '3'], ['ctx', '4', '4'], ['ctx', '5', '5'],
      ['ctx', '6', '6'], ['ctx', '7', '7'], ['ctx', '8', '8'], ['ctx', '9', '9'],
    ]);
    expect(patchRows(p, new Map([[0, ctx({ up: ['8', '9'] })]])).map((r) => [r.kind, r.n1, r.n2, r.text])).toEqual([
      ['gap', '', '', ''],
      ['ctx', '8', '8', '8'],
      ['ctx', '9', '9', '9'],
      ['hunk', '', '', '@@ -10 +10 @@'],
      ['gap', '', '', ''],
    ]);
    const over = ctx({ down: new Array(10).fill('x') });
    expect(patchRows(p, new Map([[0, over]])).some((r) => r.kind === 'gap' && r.gap!.id === 0)).toBe(false);
    expect(gapRequest(p, over, 0, 'down')).toBeNull();
  });

  it('offers only expand-all when at most 20 lines remain, and omits the tail when truncated', () => {
    const p = patch([hunk('@@ -30,3 +30,4 @@', 30, 3, 30, 4, [])]);
    expect(patchRows(p)[0].gap).toMatchObject({ id: 0, remaining: 29, canUp: true, canDown: true });
    const contexts = new Map([[0, ctx({ down: new Array(24).fill('x') })]]);
    expect(patchRows(p, contexts).filter((r) => r.kind === 'gap')[0].gap).toMatchObject({ remaining: 5, canUp: false, canDown: false });
    expect(patchRows(patch([hunk('@@ -10,3 +10,4 @@', 10, 3, 10, 4, [])], true)).some((r) => r.kind === 'gap' && r.gap!.id === 1)).toBe(false);
    expect(patchRows(patch([hunk('@@ -0,0 +1,3 @@', 0, 0, 1, 3, [])])).some((r) => r.kind === 'gap')).toBe(false);
  });
});

describe('gapRequest', () => {
  it('builds requests from either revealed edge', () => {
    const p = patch([
      hunk('@@ -10,3 +10,4 @@', 10, 3, 10, 4, []),
      hunk('@@ -40,2 +41,2 @@', 40, 2, 41, 2, []),
    ]);
    expect(gapRequest(p, undefined, 1, 'down')).toEqual({ start: 14, count: 20 });
    expect(gapRequest(p, ctx({ down: ['a', 'b'] }), 1, 'down')).toEqual({ start: 16, count: 20 });
    expect(gapRequest(p, ctx({ up: ['z'] }), 1, 'up')).toEqual({ start: 20, count: 20 });
    expect(gapRequest(p, ctx({ down: ['a', 'b'] }), 1, 'all')).toEqual({ start: 16, count: 25 });
    expect(gapRequest(p, ctx({ down: new Array(27).fill('x') }), 1, 'down')).toBeNull();
    expect(gapRequest(p, undefined, 5, 'down')).toBeNull();
  });

  it('treats the tail as unknown until total arrives', () => {
    const p = patch([hunk('@@ -10,3 +10,4 @@', 10, 3, 10, 4, [])]);
    expect(gapRequest(p, undefined, 1, 'down')).toEqual({ start: 14, count: 20 });
    expect(gapRequest(p, undefined, 1, 'all')).toEqual({ start: 14, count: null });
    const c = ctx({ down: ['a'], total: 30 });
    expect(gapRequest(p, c, 1, 'down')).toEqual({ start: 15, count: 16 });
    expect(gapRequest(p, c, 1, 'up')).toEqual({ start: 15, count: 16 });
    expect(gapRequest(p, c, 1, 'all')).toEqual({ start: 15, count: 16 });
    expect(gapRequest(p, ctx({ down: new Array(17).fill('x'), total: 30 }), 1, 'down')).toBeNull();
    // the tail is empty when the last hunk already ends at EOF: total 13 means line 14 does not exist
    expect(patchRows(p, new Map([[1, ctx({ total: 13 })]])).some((r) => r.kind === 'gap' && r.gap!.id === 1)).toBe(false);
  });
});
