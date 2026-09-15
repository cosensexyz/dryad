import type { GapContext, Patch } from './types';

export interface GapRow {
  id: number;
  remaining: number | null;
  canUp: boolean;
  canDown: boolean;
  pending: 'up' | 'down' | 'all' | null;
  error: string | null;
}

export interface DiffRow { kind: 'hunk' | 'ctx' | 'add' | 'del' | 'gap'; n1: string; n2: string; sign: string; text: string; gap?: GapRow; }

interface Gap { id: number; oldStart: number; newStart: number; size: number | null; }

const EMPTY: GapContext = { down: [], up: [], total: null, pending: null, error: null };
const stateOf = (c: GapContext | undefined): GapContext => c ?? EMPTY;

/** Hidden-line ranges: leading, between hunks, and the tail. The tail's size stays null until a
 *  response has returned `total`; its id is the hunk count. */
function gapsOf(patch: Patch, contexts?: Map<number, GapContext>): Gap[] {
  const gaps: Gap[] = [];
  let oldLine = 1, newLine = 1;
  patch.hunks.forEach((h, i) => {
    const size = (h.oldStart > 0 ? h.oldStart : h.newStart) - (h.oldStart > 0 ? oldLine : newLine);
    if (size > 0) gaps.push({ id: i, oldStart: oldLine, newStart: newLine, size });
    oldLine = h.oldStart + h.oldCount;
    newLine = h.newStart + h.newCount;
  });
  const last = patch.hunks[patch.hunks.length - 1];
  if (!patch.truncated && last && last.oldCount > 0 && last.newCount > 0) {
    const total = contexts?.get(patch.hunks.length)?.total ?? null;
    const size = total === null ? null : total - newLine + 1;
    if (size === null || size > 0) gaps.push({ id: patch.hunks.length, oldStart: oldLine, newStart: newLine, size });
  }
  return gaps;
}

function pushCtx(out: DiffRow[], n1: number, n2: number, text: string): void {
  out.push({ kind: 'ctx', n1: String(n1), n2: String(n2), sign: '', text: text.replace(/\t/g, '    ') });
}

export function patchRows(patch: Patch, contexts?: Map<number, GapContext>): DiffRow[] {
  const out: DiffRow[] = [];
  const gaps = gapsOf(patch, contexts);
  let g = 0;
  const pushGap = (gap: Gap) => {
    const ctx = stateOf(contexts?.get(gap.id));
    for (let i = 0; i < ctx.down.length; i++) pushCtx(out, gap.oldStart + i, gap.newStart + i, ctx.down[i]);
    const remaining = gap.size === null ? null : Math.max(0, gap.size - ctx.down.length - ctx.up.length);
    if (remaining !== 0) {
      const few = remaining !== null && remaining <= 20;
      out.push({ kind: 'gap', n1: '', n2: '', sign: '', text: '', gap: {
        id: gap.id, remaining, canUp: gap.size !== null && !few, canDown: !few, pending: ctx.pending, error: ctx.error,
      } });
    }
    if (gap.size !== null) for (let i = 0; i < ctx.up.length; i++) {
      const off = gap.size - ctx.up.length + i;
      pushCtx(out, gap.oldStart + off, gap.newStart + off, ctx.up[i]);
    }
  };
  patch.hunks.forEach((h, i) => {
    while (g < gaps.length && gaps[g].id === i) { pushGap(gaps[g]); g++; }
    let n1 = h.oldStart, n2 = h.newStart;
    out.push({ kind: 'hunk', n1: '', n2: '', sign: '', text: h.header });
    for (const l of h.lines) {
      const text = l.text.replace(/\t/g, '    ');
      if (l.sign === '+') out.push({ kind: 'add', n1: '', n2: String(n2++), sign: '+', text });
      else if (l.sign === '-') out.push({ kind: 'del', n1: String(n1++), n2: '', sign: '-', text });
      else out.push({ kind: 'ctx', n1: String(n1++), n2: String(n2++), sign: '', text });
    }
  });
  while (g < gaps.length) { pushGap(gaps[g]); g++; }
  return out;
}

/** Line range to request for one gap action; null when the gap is unknown or fully revealed. */
export function gapRequest(patch: Patch, context: GapContext | undefined, gapId: number, dir: 'up' | 'down' | 'all'): { start: number; count: number | null } | null {
  const contexts = new Map<number, GapContext>();
  if (context) contexts.set(gapId, context);
  const gap = gapsOf(patch, contexts).find((x) => x.id === gapId);
  if (!gap) return null;
  const down = context?.down.length ?? 0;
  const up = context?.up.length ?? 0;
  const remaining = gap.size === null ? null : Math.max(0, gap.size - down - up);
  if (remaining === 0) return null;
  if (dir === 'all') return { start: gap.newStart + down, count: remaining };
  const batch = remaining === null ? 20 : Math.min(20, remaining);
  if (dir === 'up') {
    if (gap.size === null) return null;
    return { start: gap.newStart + gap.size - up - batch, count: batch };
  }
  return { start: gap.newStart + down, count: batch };
}
