import { open } from '@tauri-apps/plugin-dialog';
import { api, onScanEvents } from './api';
import { applyScanEvent, createState, listKey, patchKey, select as selectState, setRegistered, type Selection } from './state';
import { flattenTree } from './derive';
import { currentFile, mount } from './views';

const s = createState();
const now = () => Math.floor(Date.now() / 1000);
const root = document.getElementById('app')!;
let view: ReturnType<typeof mount>;
const render = () => view.update(s, now());
const flash = (msg: string | null) => { s.registryWarning = msg; render(); };

async function reloadProjects() { setRegistered(s, await api.listProjects()); render(); }

/** Fresh status + file list + current patch for the selected worktree/tab; `seq` drops late results. */
async function loadDiff() {
  if (s.selection.kind !== 'worktree') return;
  const sel = s.selection, tab = s.tab, seq = ++s.diffSeq;
  const e = s.worktrees.get(sel.path), p = s.projects.get(sel.project);
  if (!e || !p) return;
  if (tab === 'branch' && (e.wt.primary || e.wt.merged === true || !p.project.mainRef)) { render(); return; }
  if (tab === 'workingTree' && e.error) { render(); return; }
  s.diffLoading = true; s.diffError = null; render();
  try {
    if (tab === 'workingTree') {
      const status = await api.worktreeStatusNow(sel.project, sel.path);
      if (seq !== s.diffSeq) return;
      e.status = status; e.error = null;
    }
    const key = listKey(sel.path, tab);
    if (!s.diffLists.has(key)) {
      const l = await api.diffFiles({ project: sel.project, worktree: sel.path, head: e.wt.head, tab, mainRef: p.project.mainRef, untracked: e.status?.untracked ?? [] });
      if (seq !== s.diffSeq) return;
      s.diffLists.set(key, l);
    }
    await loadPatch(seq);
  } catch (err) {
    if (seq === s.diffSeq) s.diffError = String(err);
  } finally {
    if (seq === s.diffSeq) { s.diffLoading = false; render(); }
  }
}

async function loadPatch(seq: number) {
  if (s.selection.kind !== 'worktree') return;
  const sel = s.selection, tab = s.tab;
  const e = s.worktrees.get(sel.path), p = s.projects.get(sel.project);
  const cur = currentFile(s, s.diffLists.get(listKey(sel.path, tab)));
  if (!e || !p || !cur || cur.binary) return;
  const key = patchKey(sel.path, tab, cur.path);
  if (s.diffPatches.has(key)) return;
  const patch = await api.diffPatch({ project: sel.project, worktree: sel.path, head: e.wt.head, tab, mainRef: p.project.mainRef, path: cur.path, oldPath: cur.oldPath, staged: cur.staged, untracked: cur.change === 'untracked' });
  if (seq !== s.diffSeq) return;
  s.diffPatches.set(key, patch);
}

function moveSelection(delta: 1 | -1) {
  const nodes = flattenTree(s, now());
  const idx = nodes.findIndex((n) => (n.kind === 'root' && s.selection.kind === 'root') || (n.kind === 'project' && s.selection.kind === 'project' && n.key === s.selection.path) || (n.kind === 'worktree' && s.selection.kind === 'worktree' && n.key === s.selection.path));
  const n = nodes[Math.min(nodes.length - 1, Math.max(0, idx + delta))];
  if (!n) return;
  handlers.select(n.kind === 'root' ? { kind: 'root' } : n.kind === 'project' ? { kind: 'project', path: n.key } : { kind: 'worktree', project: n.project!, path: n.key });
}

const handlers = {
  async addProject() {
    const dir = await open({ directory: true, multiple: false, title: 'Add a git repository' });
    if (typeof dir !== 'string') return;
    try { await api.addProject(dir); flash(null); await reloadProjects(); }
    catch (err) { flash(String(err)); }
  },
  async refresh() { try { await api.scanAll(); } catch (err) { flash(String(err)); } },
  setQuery(q: string) { s.query = q; render(); },
  toggleChip(k: keyof typeof s.chips) { s.chips[k] = !s.chips[k]; render(); },
  setSort(k: typeof s.sort.key) {
    const dirs = { project: 1, worktree: 1, changes: -1, upstream: -1, merged: 1, last: 1 } as const;
    s.sort = s.sort.key === k ? { key: k, dir: (s.sort.dir * -1) as 1 | -1 } : { key: k, dir: dirs[k] };
    render();
  },
  select(sel: Selection) { selectState(s, sel); render(); if (sel.kind === 'worktree') void loadDiff(); },
  toggleExpand(project: string) { s.expanded.has(project) ? s.expanded.delete(project) : s.expanded.add(project); render(); },
  async removeProject(path: string) {
    try { await api.removeProject(path); selectState(s, { kind: 'root' }); flash(null); await reloadProjects(); }
    catch (err) { flash(String(err)); }
  },
  setTab(tab: typeof s.tab) { s.tab = tab; render(); void loadDiff(); },
  pickFile(path: string) { s.fileByTab[s.tab] = path; render(); void loadDiff(); },
  async setStaleDays(n: number) {
    try { s.staleDays = await api.setStaleDays(Math.max(1, Math.floor(n))); } catch (err) { flash(String(err)); }
    render();
  },
  setPaneWidths(w: { sidebar: number; files: number }) {
    s.paneWidths = w; render();
    void api.setPaneWidths(w).catch((err) => flash(String(err)));
  },
};

async function boot() {
  view = mount(root, handlers);
  const info = await api.startupInfo();
  s.gitError = info.gitError; s.registryWarning = info.registryWarning; s.staleDays = info.staleDays;
  s.paneWidths = { sidebar: info.sidebarWidth, files: info.filesWidth };
  await reloadProjects();
  await onScanEvents((name, payload) => {
    if (!applyScanEvent(s, name, payload)) return;
    render();
    // the selected worktree just got its first status: load its diff without waiting for a click
    if (name === 'worktree:status' && s.selection.kind === 'worktree' && (payload as { path: string }).path === s.selection.path && !s.diffLists.has(listKey(s.selection.path, s.tab))) void loadDiff();
  });
  document.addEventListener('keydown', (e) => {
    const mod = e.metaKey || e.ctrlKey;
    const inInput = (e.target as HTMLElement).tagName === 'INPUT';
    if (mod && e.key === 'r') { e.preventDefault(); void handlers.refresh(); }
    else if (mod && e.key === 'f') { e.preventDefault(); view.focusFilter(); }
    else if (!inInput && e.key === 'ArrowDown') { e.preventDefault(); moveSelection(1); }
    else if (!inInput && e.key === 'ArrowUp') { e.preventDefault(); moveSelection(-1); }
  });
  render();
  if (!s.gitError) await handlers.refresh();
}

void boot();
