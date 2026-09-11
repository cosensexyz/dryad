import type { DiffTab } from './types';
import type { Selection, SortKey, State } from './state';
import { absTime, chipsPass, compareRows, flattenTree, isDirty, isMerged, isStale, isUnpushed, matchesText, relTime, rowsOf, type Row } from './derive';

export interface Handlers {
  addProject(): void; refresh(): void; setQuery(q: string): void; toggleChip(k: keyof State['chips']): void;
  setSort(k: SortKey): void; select(sel: Selection): void; toggleExpand(project: string): void; removeProject(path: string): void;
  setTab(tab: DiffTab): void; pickFile(path: string): void; setStaleDays(n: number): void;
}

type Attrs = Record<string, string | ((e: Event) => void) | undefined>;
export function h(tag: string, attrs: Attrs = {}, children: (Node | string | null)[] = []): HTMLElement {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined) continue;
    if (typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else el.setAttribute(k, v);
  }
  for (const c of children) if (c !== null) el.append(typeof c === 'string' ? document.createTextNode(c) : c);
  return el;
}
const svg = (d: string, size = 16) => {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 16 16'); s.setAttribute('width', String(size)); s.setAttribute('height', String(size));
  s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor'); s.setAttribute('stroke-width', '1.5');
  s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path'); p.setAttribute('d', d); s.append(p); return s;
};
const ICON = { plus: 'M8 3v10M3 8h10', refresh: 'M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 3v3h-3', search: 'M11 11a4 4 0 1 0-8 0 4 4 0 0 0 8 0zM10 10l3.5 3.5', chev: 'M6 4l4 4-4 4', caret: 'M4 6l4 4 4-4', warn: 'M8 2.5 14 13H2zM8 6.5v3M8 11.2v.3' };

export interface Cells {
  wtLabel: string; wtClass: string; badges: string[]; changes: string; changesClass: string;
  up: string; upClass: string; upName: string; merged: string; mergedClass: string;
  last: string; lastClass: string; lastAbs: string; err: string;
}

/** Text and class of every table cell; mirrors `cellsFor` in design/Main.dc.html. */
export function cellsFor(r: Row, staleDays: number, nowSec: number): Cells {
  const wt = r.entry.wt, st = r.entry.status, err = r.entry.error ?? '';
  const wtLabel = wt.branch ?? `(detached ${wt.head.slice(0, 8)})`;
  const badges = [wt.primary ? 'primary' : null, wt.locked !== null ? 'locked' : null, wt.prunable !== null ? 'prunable' : null].filter((b): b is string => b !== null);
  let changes = '—', changesClass = 'na';
  if (!err) {
    if (st === null) { changes = '…'; changesClass = 'pending'; }
    else {
      const parts = [st.counts.staged ? `+${st.counts.staged}` : '', st.counts.unstaged ? `~${st.counts.unstaged}` : '', st.counts.untracked ? `?${st.counts.untracked}` : ''].filter(Boolean);
      if (parts.length) { changes = parts.join(' '); changesClass = 'c-dirty'; } else { changes = '–'; changesClass = 'clean'; }
    }
  }
  // Upstream is reference-level: known from the first scan phase, shown even when the directory is missing.
  let up: string, upClass: string, upName: string;
  const u = wt.upstream;
  if (u.kind === 'none') { up = 'none'; upClass = 'c-ahead'; upName = 'none'; }
  else if (u.kind === 'gone') { up = 'gone'; upClass = 'c-err'; upName = `${u.name} (gone)`; }
  else {
    const parts = [u.ahead ? `↑${u.ahead}` : '', u.behind ? `↓${u.behind}` : ''].filter(Boolean);
    up = parts.length ? parts.join(' ') : '='; upClass = u.ahead ? 'c-ahead' : 'clean'; upName = `${u.name} ${up}`;
  }
  const merged = wt.merged === true ? 'yes' : wt.merged === false ? 'no' : 'main ref';
  const mergedClass = wt.merged === true ? 'c-merged' : wt.merged === false ? '' : 'na';
  const last = wt.lastCommit === null ? '—' : relTime(wt.lastCommit, nowSec);
  const lastClass = wt.lastCommit === null ? 'na' : isStale(r, staleDays, nowSec) ? 'c-stale' : '';
  return { wtLabel, wtClass: wt.branch ? '' : 'muted', badges, changes, changesClass, up, upClass, upName, merged, mergedClass, last, lastClass, lastAbs: wt.lastCommit === null ? '' : absTime(wt.lastCommit), err };
}

export function allRows(s: State): Row[] { return [...s.projects.keys()].flatMap((p) => rowsOf(s, p)); }

export function mount(root: HTMLElement, hs: Handlers) {
  const input = h('input', { class: 'filter', placeholder: 'filter project, branch, path', onInput: (e) => hs.setQuery((e.target as HTMLInputElement).value), onKeyDown: (e) => { if ((e as KeyboardEvent).key === 'Escape') { (e.target as HTMLInputElement).value = ''; hs.setQuery(''); } } }) as HTMLInputElement;
  const progress = h('div', { class: 'progress mono' });
  const banner = h('div', { class: 'banner', hidden: '' });
  const sidebar = h('div', { class: 'sidebar' });
  const main = h('div', { class: 'main' });
  root.replaceChildren(
    h('div', { class: 'toolbar' }, [
      h('button', { class: 'btn', onClick: () => hs.addProject(), title: 'Add a repository to the list' }, [svg(ICON.plus), 'Add project']),
      h('button', { class: 'btn', onClick: () => hs.refresh(), title: 'Re-scan every project' }, [svg(ICON.refresh), 'Refresh']),
      h('div', { class: 'filterbox' }, [svg(ICON.search), input]),
      h('div', { class: 'spacer' }), progress,
    ]),
    banner,
    h('div', { class: 'body' }, [sidebar, main]),
  );

  function renderTree(s: State, now: number) {
    sidebar.replaceChildren(...flattenTree(s, now).map((n) => {
      const sel = (n.kind === 'root' && s.selection.kind === 'root') || (n.kind === 'project' && s.selection.kind === 'project' && s.selection.path === n.key) || (n.kind === 'worktree' && s.selection.kind === 'worktree' && s.selection.path === n.key);
      const c = n.counts;
      const node = h('div', { class: `node ${n.kind}`, 'data-sel': sel ? '1' : '0', title: n.error ?? n.key,
        onClick: () => hs.select(n.kind === 'root' ? { kind: 'root' } : n.kind === 'project' ? { kind: 'project', path: n.key } : { kind: 'worktree', project: n.project!, path: n.key }) }, [
        n.kind === 'project' && !n.failed ? h('span', { class: `chev ${n.expanded ? 'open' : ''}`, onClick: (e) => { e.stopPropagation(); hs.toggleExpand(n.key); } }, [svg(ICON.chev, 12)]) : null,
        h('span', { class: `label ${n.kind === 'worktree' ? 'mono' : ''}` }, [n.label]),
        n.failed || n.error ? h('span', { class: 'c-err' }, [svg(ICON.warn, 13)]) : null,
        n.scanning || n.pending ? h('span', { class: 'mono pending' }, ['…']) : null,
        c && c.dirty ? h('span', { class: 'cnt c-dirty' }, [String(c.dirty)]) : null,
        c && c.unpushed ? h('span', { class: 'cnt c-ahead' }, [String(c.unpushed)]) : null,
        c && c.merged ? h('span', { class: 'cnt c-merged' }, [String(c.merged)]) : null,
        c && c.stale ? h('span', { class: 'cnt c-stale' }, [String(c.stale)]) : null,
      ]);
      if (c) node.title = `${n.key}\n${c.dirty} dirty · ${c.unpushed} unpushed · ${c.merged} merged · ${c.stale} stale`;
      return node;
    }));
  }

  function renderTable(s: State, now: number, rows: Row[], showProject: boolean): HTMLElement {
    const hdr = (key: SortKey, label: string, cls: string, title?: string) => {
      const on = s.sort.key === key;
      return h('div', { class: `hdr ${cls} ${on ? 'on' : ''}`, title, onClick: () => hs.setSort(key) }, [label, h('span', { class: `caret ${on ? (s.sort.dir === 1 ? 'asc' : 'desc') : ''}` }, [svg(ICON.caret, 12)])]);
    };
    const sorted = [...rows].sort((a, b) => compareRows(a, b, s.sort.key, s.sort.dir));
    let prev: string | null = null;
    const body = sorted.map((r) => {
      const c = cellsFor(r, s.staleDays, now);
      const same = s.sort.key === 'project' && prev === r.project.path; prev = r.project.path;
      return h('div', { class: 'row', 'data-sel': s.lastWorktree === r.entry.wt.path ? '1' : '0', title: c.err || r.entry.wt.path,
        onClick: () => hs.select({ kind: 'worktree', project: r.project.path, path: r.entry.wt.path }) }, [
        h('div', { class: 'cell icon c-err' }, [c.err ? svg(ICON.warn, 14) : null]),
        showProject ? h('div', { class: `cell project ${same ? 'faint' : ''}` }, [r.project.name]) : null,
        h('div', { class: 'cell worktree' }, [h('span', { class: c.wtClass }, [c.wtLabel]), ...c.badges.map((b) => h('span', { class: 'badge' }, [b]))]),
        h('div', { class: `cell changes ${c.changesClass}` }, [c.changes]),
        h('div', { class: `cell upstream ${c.upClass}` }, [c.up]),
        h('div', { class: `cell merged ${c.mergedClass}` }, [c.merged]),
        h('div', { class: `cell last ${c.lastClass}`, title: c.lastAbs }, [c.last]),
      ]);
    });
    const empty = s.projects.size === 0 ? 'No projects yet — use Add project to get started.' : rows.length === 0 && !s.query ? 'This project has no scanned worktrees.' : 'No worktree matches the current filter.';
    return h('div', { class: 'table' }, [
      h('div', { class: 'thead' }, [h('div', { class: 'cell icon' }), showProject ? hdr('project', 'Project', 'project') : null, hdr('worktree', 'Worktree', 'worktree'), hdr('changes', 'Changes', 'changes', '+ staged   ~ modified   ? untracked'), hdr('upstream', 'Upstream', 'upstream', 'ahead / behind the tracking branch'), hdr('merged', 'Merged', 'merged'), hdr('last', 'Last commit', 'last')]),
      ...body,
      body.length === 0 ? h('div', { class: 'empty' }, [empty]) : null,
    ]);
  }

  function renderRoot(s: State, now: number) {
    const rows = allRows(s);
    const shown = rows.filter((r) => chipsPass(r, s.chips, s.staleDays, now) && matchesText(r, s.query));
    const chip = (k: keyof State['chips'], label: string, n: number, title: string) =>
      h('button', { class: `chip ${s.chips[k] ? 'on' : ''}`, title, onClick: () => hs.toggleChip(k) }, [label, h('span', { class: 'mono cnt' }, [String(n)])]);
    const filtered = Object.values(s.chips).some(Boolean) || s.query.trim() !== '';
    const wtCount = rows.length;
    main.replaceChildren(
      h('div', { class: 'chips' }, [
        chip('dirty', 'dirty', rows.filter(isDirty).length, 'Worktrees with staged, modified or untracked files'),
        chip('unpushed', 'unpushed', rows.filter(isUnpushed).length, 'Commits ahead of upstream, or no upstream at all'),
        chip('merged', 'merged', rows.filter(isMerged).length, 'Branch is an ancestor of the main ref (squash merges are not detected)'),
        chip('stale', `stale >${s.staleDays}d`, rows.filter((r) => isStale(r, s.staleDays, now)).length, 'Last commit older than the stale threshold'),
        h('div', { class: 'spacer' }),
        h('div', { class: 'mono muted' }, [`${filtered ? `showing ${shown.length} of ${wtCount} · ` : ''}${s.projects.size} projects · ${wtCount} worktrees`]),
      ]),
      renderTable(s, now, shown, true),
    );
  }

  function renderProject(s: State, now: number, path: string) {
    const p = s.projects.get(path); if (!p) { hs.select({ kind: 'root' }); return; }
    const rows = rowsOf(s, path).filter((r) => matchesText(r, s.query));
    main.replaceChildren(
      h('div', { class: 'phead' }, [
        h('span', { class: 'pname' }, [p.project.name]),
        h('span', { class: 'mono muted ellipsis grow' }, [p.project.path]),
        h('span', { class: 'mono' }, [h('span', { class: 'muted' }, ['main ref ']), p.project.mainRef ?? '—']),
        h('span', { class: 'mono' }, [h('span', { class: 'muted' }, ['scan ']), h('span', { class: p.scan === 'failed' ? 'c-err' : p.scan === 'pending' ? 'pending' : 'muted' }, [p.scan])]),
        h('button', { class: 'btn small', title: "Removes this project from Dryad's list only; the repository is not touched", onClick: () => hs.removeProject(path) }, ['Remove from list']),
      ]),
      ...(p.error ? [h('div', { class: 'perror mono c-err' }, [p.error])] : []),
      renderTable(s, now, rows, false),
    );
  }

  return {
    update(s: State, now: number) {
      if (input.value !== s.query) input.value = s.query;
      progress.textContent = s.scanning ? `scanning ${s.finished}/${s.total}` : 'idle';
      progress.className = `progress mono ${s.scanning ? 'pending' : 'muted'}`;
      const msg = s.gitError ? `git not found: ${s.gitError}` : s.registryWarning;
      banner.hidden = !msg; banner.textContent = msg ?? '';
      renderTree(s, now);
      if (s.selection.kind === 'root') renderRoot(s, now);
      else if (s.selection.kind === 'project') renderProject(s, now, s.selection.path);
      else renderWorktree(main, s, now, hs, s.selection);
    },
  };
}

// Task 18 replaces this stub with the worktree view.
export function renderWorktree(main: HTMLElement, _s: State, _now: number, _hs: Handlers, sel: { project: string; path: string }) {
  main.replaceChildren(h('div', { class: 'empty' }, [`worktree view pending: ${sel.path}`]));
}
