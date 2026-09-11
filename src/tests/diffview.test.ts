import { describe, it, expect } from 'vitest';
import { patchRows } from '../diffview';

describe('patchRows', () => {
  it('numbers old and new sides independently and keeps hunk headers', () => {
    const rows = patchRows({ path: 'x', truncated: false, binary: false, hunks: [
      { header: '@@ -18,3 +18,4 @@ impl', oldStart: 18, newStart: 18, lines: [
        { sign: ' ', text: 'a' }, { sign: '-', text: 'b' }, { sign: '+', text: 'b2' }, { sign: '+', text: 'c' },
      ] },
    ] });
    expect(rows.map((r) => [r.kind, r.n1, r.n2, r.text])).toEqual([
      ['hunk', '', '', '@@ -18,3 +18,4 @@ impl'],
      ['ctx', '18', '18', 'a'],
      ['del', '19', '', 'b'],
      ['add', '', '19', 'b2'],
      ['add', '', '20', 'c'],
    ]);
  });
});
