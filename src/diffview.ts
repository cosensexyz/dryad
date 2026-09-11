import type { Patch } from './types';

export interface DiffRow { kind: 'hunk' | 'ctx' | 'add' | 'del'; n1: string; n2: string; sign: string; text: string; }

export function patchRows(patch: Patch): DiffRow[] {
  const out: DiffRow[] = [];
  for (const h of patch.hunks) {
    let n1 = h.oldStart, n2 = h.newStart;
    out.push({ kind: 'hunk', n1: '', n2: '', sign: '', text: h.header });
    for (const l of h.lines) {
      const text = l.text.replace(/\t/g, '    ');
      if (l.sign === '+') out.push({ kind: 'add', n1: '', n2: String(n2++), sign: '+', text });
      else if (l.sign === '-') out.push({ kind: 'del', n1: String(n1++), n2: '', sign: '-', text });
      else out.push({ kind: 'ctx', n1: String(n1++), n2: String(n2++), sign: '', text });
    }
  }
  return out;
}
