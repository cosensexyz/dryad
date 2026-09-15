import type { DiffFile, DiffTab } from './types';
import { listKey, patchKey, type ProjectEntry, type Selection, type SortKey, type State, type WorktreeEntry } from './state';
import { absTime, chipsPass, compareRows, flattenTree, isDirty, isMerged, isStale, isUnpushed, matchesText, relTime, rowsOf, type Row } from './derive';
import { patchRows, type DiffRow } from './diffview';

export interface Handlers {
  addProject(): void; refresh(): void; setQuery(q: string): void; toggleChip(k: keyof State['chips']): void;
  setSort(k: SortKey): void; select(sel: Selection): void; toggleExpand(project: string): void; removeProject(path: string): void;
  setTab(tab: DiffTab): void; pickFile(path: string): void; setStaleDays(n: number): void;
  expandGap(gapId: number, dir: 'up' | 'down' | 'all'): void;
  setPaneWidths(w: { sidebar: number; files: number }): void;
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
  const PANE_MIN = 160, BODY_RESERVE = 360, SPLIT_RESERVE = 240;
  let sidebarW = 260, filesW = 280, dragging = false;

  function gutter(pane: 'sidebar' | 'files'): HTMLElement {
    const g = h('div', { class: 'gutter', 'data-pane': pane });
    g.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const downX = (e as PointerEvent).clientX;
      const paneEl = document.querySelector<HTMLElement>(pane === 'sidebar' ? '.sidebar' : '.files');
      const start = paneEl?.getBoundingClientRect().width ?? (pane === 'sidebar' ? sidebarW : filesW);
      const reserve = pane === 'sidebar' ? BODY_RESERVE : SPLIT_RESERVE;
      const sel = pane === 'sidebar' ? '.body' : '.split';
      const move = (me: PointerEvent) => {
        const w = dragWidth(start, me.clientX - downX, document.querySelector<HTMLElement>(sel)?.clientWidth ?? 0, PANE_MIN, reserve);
        if (pane === 'sidebar') { sidebarW = w; root.style.setProperty('--sidebar-w', `${w}px`); }
        else { filesW = w; root.style.setProperty('--files-w', `${w}px`); }
      };
      const up = () => {
        document.removeEventListener('pointermove', move);
        document.removeEventListener('pointerup', up);
        document.removeEventListener('pointercancel', up);
        document.body.classList.remove('dragging');
        dragging = false;
        hs.setPaneWidths({ sidebar: sidebarW, files: filesW });
      };
      dragging = true;
      document.body.classList.add('dragging');
      document.addEventListener('pointermove', move);
      document.addEventListener('pointerup', up);
      document.addEventListener('pointercancel', up);
    });
    return g;
  }

  const fsGutter = gutter('files');
  root.replaceChildren(
    h('div', { class: 'toolbar' }, [
      h('button', { class: 'btn', onClick: () => hs.addProject(), title: 'Add a repository to the list' }, [svg(ICON.plus), 'Add project']),
      h('button', { class: 'btn', onClick: () => hs.refresh(), title: 'Re-scan every project' }, [svg(ICON.refresh), 'Refresh']),
      h('div', { class: 'filterbox' }, [svg(ICON.search), input]),
      h('div', { class: 'spacer' }), progress,
    ]),
    banner,
    h('div', { class: 'body' }, [sidebar, gutter('sidebar'), main]),
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
    delete main.dataset.view; delete main.dataset.file;
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
        h('input', { type: 'number', class: 'stale mono', min: '1', max: '3650', value: String(s.staleDays), title: 'Stale threshold in days',
          onChange: (e) => hs.setStaleDays(Number((e.target as HTMLInputElement).value)) }),
        h('div', { class: 'spacer' }),
        h('div', { class: 'mono muted' }, [`${filtered ? `showing ${shown.length} of ${wtCount} · ` : ''}${s.projects.size} projects · ${wtCount} worktrees`]),
      ]),
      renderTable(s, now, shown, true),
    );
  }

  function renderProject(s: State, now: number, path: string) {
    delete main.dataset.view; delete main.dataset.file;
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
      if (!dragging) { sidebarW = s.paneWidths.sidebar; filesW = s.paneWidths.files; }
      root.style.setProperty('--sidebar-w', `${sidebarW}px`);
      root.style.setProperty('--files-w', `${filesW}px`);
      if (input.value !== s.query) input.value = s.query;
      progress.textContent = s.scanning ? `scanning ${s.finished}/${s.total}` : 'idle';
      progress.className = `progress mono ${s.scanning ? 'pending' : 'muted'}`;
      const msg = s.gitError ? `git not found: ${s.gitError}` : s.registryWarning;
      banner.hidden = !msg; banner.textContent = msg ?? '';
      renderTree(s, now);
      const prev: ScrollSnap | null = main.dataset.view !== undefined ? {
        view: main.dataset.view, file: main.dataset.file ?? '',
        filesTop: main.querySelector('.files')?.scrollTop ?? 0,
        diffTop: main.querySelector('.dbody')?.scrollTop ?? 0,
      } : null;
      if (s.selection.kind === 'root') renderRoot(s, now);
      else if (s.selection.kind === 'project') renderProject(s, now, s.selection.path);
      else renderWorktree(main, s, now, hs, s.selection, fsGutter);
      if (main.dataset.view !== undefined) {
        const target = scrollRestore(prev, { view: main.dataset.view, file: main.dataset.file ?? '' });
        const files = main.querySelector<HTMLElement>('.files');
        const dbody = main.querySelector<HTMLElement>('.dbody');
        if (files) files.scrollTop = target.filesTop;
        if (dbody) dbody.scrollTop = target.diffTop;
      }
    },
    focusFilter() { input.focus(); input.select(); },
  };
}

export function worktreeNotice(s: Pick<State, 'tab' | 'diffError' | 'diffLoading'>, p: ProjectEntry, e: WorktreeEntry, list: { files: DiffFile[]; truncated: boolean } | undefined): string {
  const mainRef = p.project.mainRef;
  if (s.tab === 'workingTree') {
    if (e.error) return `Status unavailable: ${e.error}`;
    if (e.status === null) return 'Waiting for the scan to reach this worktree…';
  } else {
    if (e.wt.primary) return 'This worktree is on the main ref; there is nothing to compare against.';
    if (e.wt.merged === true) return `Already an ancestor of ${mainRef ?? 'main'} — no commits beyond it.`;
    if (!mainRef) return 'No main ref resolved for this project.';
  }
  if (s.diffError) return s.diffError;
  if (!list) return s.diffLoading ? 'Loading…' : '';
  if (list.files.length === 0) return s.tab === 'workingTree' ? 'No uncommitted changes.' : `No differences against ${mainRef}.`;
  return '';
}

const KIND: Record<DiffFile['change'], [string, string]> = { modified: ['M', 'c-dirty'], added: ['A', 'add-fg'], deleted: ['D', 'del-fg'], renamed: ['R', 'c-dirty'], untracked: ['?', 'muted'] };

export function currentFile(s: State, list: { files: DiffFile[] } | undefined): DiffFile | undefined {
  const files = list?.files ?? [];
  const wanted = s.fileByTab[s.tab];
  return files.find((f) => f.path === wanted) ?? files[0];
}

export interface ScrollSnap { view: string; file: string; filesTop: number; diffTop: number; }

/** Scroll offsets to apply after a re-render: same view keeps the file list; same file keeps the diff. */
export function scrollRestore(prev: ScrollSnap | null, next: { view: string; file: string }): { filesTop: number; diffTop: number } {
  if (!prev || prev.view !== next.view) return { filesTop: 0, diffTop: 0 };
  return { filesTop: prev.filesTop, diffTop: prev.file === next.file ? prev.diffTop : 0 };
}

/** Width after a drag: start width + dx, clamped to [min, container - reserve]. */
export function dragWidth(start: number, dx: number, container: number, min: number, reserve: number): number {
  const max = Math.max(min, container - reserve);
  return Math.round(Math.min(max, Math.max(min, start + dx)));
}

function gapLine(l: DiffRow, hs: Handlers): HTMLElement {
  const g = l.gap!;
  const btn = (dir: 'up' | 'down' | 'all', label: string, show: boolean) => show
    ? h('button', { class: 'gapbtn', disabled: g.pending ? '' : undefined, onClick: () => hs.expandGap(g.id, dir) }, [label])
    : null;
  return h('div', { class: 'dline gap' }, [
    h('span', { class: 'n' }), h('span', { class: 'n' }), h('span', { class: 'sign' }),
    h('span', { class: 'text gapbody' }, [
      h('span', {}, [g.remaining === null ? '⋯' : `⋯ ${g.remaining} lines hidden`]),
      btn('down', '↓ 20', g.canDown), btn('up', '↑ 20', g.canUp), btn('all', 'All', true),
      g.pending ? h('span', {}, ['…']) : null,
      g.error ? h('span', { class: 'c-err' }, [g.error]) : null,
    ]),
  ]);
}

export function renderWorktree(main: HTMLElement, s: State, now: number, hs: Handlers, sel: { project: string; path: string }, filesGutter: HTMLElement) {
  const p = s.projects.get(sel.project), e = s.worktrees.get(sel.path);
  if (!p || !e) { main.dataset.view = `${sel.path}|${s.tab}`; main.dataset.file = ''; main.replaceChildren(h('div', { class: 'empty' }, ['This worktree is no longer listed.'])); return; }
  const r: Row = { project: p.project, entry: e };
  const c = cellsFor(r, s.staleDays, now);
  const wt = e.wt, mainRef = p.project.mainRef ?? 'main';
  const extra = e.error ? `error: ${e.error}` : wt.locked !== null ? `locked: ${wt.locked}` : wt.prunable !== null ? `prunable: ${wt.prunable}` : '';
  const list = s.diffLists.get(listKey(sel.path, s.tab));
  const notice = worktreeNotice(s, p, e, list);
  const files = notice && !list ? [] : (list?.files ?? []);
  const cur = currentFile(s, list);
  main.dataset.view = `${sel.path}|${s.tab}`;
  main.dataset.file = cur?.path ?? '';
  const patch = cur ? s.diffPatches.get(patchKey(sel.path, s.tab, cur.path)) : undefined;
  const contexts = cur ? s.diffContexts.get(patchKey(sel.path, s.tab, cur.path)) : undefined;
  const wtList = s.diffLists.get(listKey(sel.path, 'workingTree')), brList = s.diffLists.get(listKey(sel.path, 'branch'));
  const tabCount = (t: DiffTab) => (t === 'workingTree' ? (e.error || e.status === null ? '' : wtList ? String(wtList.files.length) : '…') : (wt.primary || wt.merged === true ? '0' : brList ? String(brList.files.length) : '…'));
  const tab = (t: DiffTab, label: string) => h('div', { class: `tab ${s.tab === t ? 'on' : ''}`, onClick: () => hs.setTab(t) }, [label, h('span', { class: 'mono cnt muted' }, [tabCount(t)])]);
  const groups: [string, DiffFile[]][] = s.tab === 'workingTree'
    ? [['Staged', files.filter((f) => f.staged)], ['Unstaged', files.filter((f) => !f.staged && f.change !== 'untracked')], ['Untracked', files.filter((f) => f.change === 'untracked')]]
    : [['Files', files]];
  const fileRows: HTMLElement[] = [];
  for (const [name, fs] of groups) {
    if (!fs.length) continue;
    fileRows.push(h('div', { class: 'file head', 'data-sel': '-' }, [`${name.toUpperCase()} · ${fs.length}`]));
    for (const f of fs) {
      const cut = f.path.lastIndexOf('/') + 1;
      fileRows.push(h('div', { class: 'file', 'data-sel': cur?.path === f.path ? '1' : '0', title: f.oldPath ? `${f.oldPath} → ${f.path}` : f.path,
        onClick: () => hs.pickFile(f.path) }, [
        h('span', { class: `kind ${KIND[f.change][1]}` }, [KIND[f.change][0]]),
        h('span', { class: 'dir ellipsis' }, [f.path.slice(0, cut)]),
        h('span', { class: 'base ellipsis' }, [f.path.slice(cut)]),
        f.change === 'untracked' ? null : f.binary ? h('span', { class: 'counts muted' }, ['binary']) : h('span', { class: 'counts' }, [h('span', { class: 'add-fg' }, [`+${f.added}`]), ' ', h('span', { class: 'del-fg' }, [`-${f.deleted}`])]),
      ]));
    }
  }
  if (list?.truncated) fileRows.push(h('div', { class: 'file head', 'data-sel': '-' }, [`list truncated at ${files.length} files`]));
  const tA = files.reduce((n, f) => n + f.added, 0), tD = files.reduce((n, f) => n + f.deleted, 0);
  const diffRows = patch ? patchRows(patch, contexts).map((l) => (l.kind === 'gap' ? gapLine(l, hs) : h('div', { class: `dline ${l.kind}` }, [h('span', { class: 'n' }, [l.n1]), h('span', { class: 'n' }, [l.n2]), h('span', { class: 'sign' }, [l.sign]), h('span', { class: 'text' }, [l.text])]))) : [];
  if (patch?.truncated) diffRows.push(h('div', { class: 'dline hunk' }, [h('span', { class: 'n' }), h('span', { class: 'n' }), h('span', { class: 'sign' }), h('span', { class: 'text' }, ['… patch truncated'])]));
  const binary = cur?.binary === true || patch?.binary === true;
  const diffNotice = notice || (binary ? 'Binary file — no textual diff.' : cur && !patch ? (s.diffLoading ? 'Loading…' : '') : '');
  const untrackedCur = cur?.change === 'untracked';
  const added = untrackedCur ? patch?.hunks.reduce((n, h) => n + h.lines.filter((l) => l.sign === '+').length, 0) ?? 0 : cur?.added ?? 0;
  const deleted = untrackedCur ? 0 : cur?.deleted ?? 0;
  main.replaceChildren(
    h('div', { class: 'whead' }, [
      h('span', { class: 'muted big' }, [p.project.name]), h('span', { class: 'faint big' }, ['/']),
      h('span', { class: `mono big ${c.wtClass}` }, [c.wtLabel]),
      ...c.badges.map((b) => h('span', { class: 'badge' }, [b])),
      h('span', { class: 'mono muted ellipsis grow' }, [wt.path]),
      h('span', { class: 'mono' }, [h('span', { class: 'muted' }, ['HEAD ']), wt.head.slice(0, 8)]),
    ]),
    h('div', { class: 'strip mono' }, [
      h('span', {}, [h('span', { class: 'muted' }, ['changes ']), h('span', { class: c.changesClass }, [c.changes])]),
      h('span', {}, [h('span', { class: 'muted' }, ['upstream ']), h('span', { class: c.upClass }, [c.upName])]),
      h('span', {}, [h('span', { class: 'muted' }, ['merged ']), h('span', { class: c.mergedClass }, [c.merged])]),
      h('span', { title: c.lastAbs }, [h('span', { class: 'muted' }, ['last commit ']), h('span', { class: c.lastClass }, [c.last])]),
      extra ? h('span', { class: `ellipsis grow ${e.error ? 'c-err' : 'muted'}`, title: extra }, [extra]) : null,
    ]),
    h('div', { class: 'tabs' }, [tab('workingTree', 'Working tree'), tab('branch', `vs ${mainRef}`), h('div', { class: 'spacer' }), h('div', { class: 'mono muted' }, [files.length ? `${files.length} files · +${tA} -${tD}` : ''])]),
    h('div', { class: 'split' }, [
      h('div', { class: 'files' }, fileRows),
      filesGutter,
      h('div', { class: 'diff' }, diffNotice ? [h('div', { class: 'empty center' }, [diffNotice])] : [
        h('div', { class: 'dhead mono' }, [h('span', { class: 'ellipsis grow' }, [cur?.path ?? '']), h('span', { class: 'muted' }, [s.tab === 'workingTree' ? (untrackedCur ? 'untracked' : cur?.staged ? 'staged' : 'unstaged') : `vs ${mainRef}`]), h('span', { class: 'add-fg' }, [`+${added}`]), h('span', { class: 'del-fg' }, [`-${deleted}`])]),
        h('div', { class: 'dbody mono' }, diffRows),
      ]),
    ]),
  );
}
