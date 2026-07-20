// app.js — front end for local-code-review. Vanilla JS, no build step, no
// dependencies. This file is shared by four units (this one builds the
// layout shell + tree; three more add diff rendering, comments/export, and
// keyboard navigation). Sections are marked so later units know where to
// plug in without reshaping what is already here.
//
// Hard rule carried over from the brief: file paths and diff content come
// from the reviewed repo and may contain anything, including HTML-looking
// text. Never use innerHTML for that content -- always textContent /
// createElement. See createEl() below, used everywhere a string reaches
// the DOM.

// ===========================================================================
// DOM references
// ===========================================================================

const sidebarToggleBtnEl = document.getElementById('sidebar-toggle-btn');

const repoSelectEl = document.getElementById('repo-select');
const addRepoToggleEl = document.getElementById('add-repo-toggle');
const addRepoFormEl = document.getElementById('add-repo-form');
const addRepoInputEl = document.getElementById('add-repo-input');
const addRepoCancelEl = document.getElementById('add-repo-cancel');
const addRepoErrorEl = document.getElementById('add-repo-error');

const baseSelectEl = document.getElementById('base-select');
const targetSelectEl = document.getElementById('target-select');
const workingTreeHintEl = document.getElementById('working-tree-hint');

const viewUnifiedBtnEl = document.getElementById('view-unified-btn');
const viewSideBySideBtnEl = document.getElementById('view-sidebyside-btn');

const statsBadgeEl = document.getElementById('stats-badge');
const errorBannerEl = document.getElementById('error-banner');

const treeRootEl = document.getElementById('tree-root');
const mainPaneEl = document.getElementById('main-pane');
const changepointsRootEl = document.getElementById('changepoints-root');

const appEl = document.getElementById('app');
const topbarEl = document.getElementById('topbar');
const bodyEl = document.getElementById('body');

// ===========================================================================
// EXTENSION POINT 2 -- central app state.
//
// Every unit that touches shared state (current repo/base/target, the
// annotated tree, view mode, current change point, comment drafts, ...)
// should add fields here rather than inventing a parallel state object.
// `tree` is the live, mutated-in-place annotated diff from GET /api/diff
// (see applyCheckedChange below for why it is mutated in place rather than
// re-fetched: refetching would blow away scroll position).
// ===========================================================================

const appState = {
  repos: [],           // [{id, path, name}]
  repo: null,           // currently selected repo id
  base: null,           // currently selected base ref
  target: null,         // currently selected target ref, or 'WORKING_TREE'
  viewMode: 'unified',  // 'unified' | 'side-by-side' -- diff-rendering unit reads this
  tree: null,           // { files, orphans, stats } from GET /api/diff, mutated in place
  order: [],            // flattened change-point ids, in tree/scroll order
  currentKey: null,     // id of the currently selected/highlighted change point
  collapsed: new Set(), // collapsed tree node ids, e.g. "file:foo.js", "group:foo.js::g0"

  // EXTENSION POINT 5 -- "is editing" flag, for the keyboard-shortcut unit.
  // isEditing is true whenever a comment textarea is open (add or edit).
  // The keyboard-navigation unit's document-level keydown handler for
  // j/k/x/u/c/f MUST check `appState.isEditing` first and bail out while
  // it's true, or single-key shortcuts will fire while the user is typing
  // a comment. editingKey names which change point is being edited (or
  // null); isEditing is the boolean the next unit should actually check.
  isEditing: false,
  editingKey: null,

  // Sidebar collapse -- whole #tree-pane, not any individual tree node (that
  // is appState.collapsed above). Restored from localStorage on init, see
  // SIDEBAR_COLLAPSED_KEY below.
  sidebarCollapsed: false,
};

// DOM index rebuilt every time the tree is (re)rendered. Not part of
// appState because it holds live element references, not serializable
// application state.
const dom = {
  changePoints: new Map(), // key -> { changePoint, group, file, groupKey, leftRow, leftCheckbox, rightContainer, rightCheckbox, contentEl, commentEl }
  groups: new Map(),       // groupKey -> { group, badgeEl, progressFillEl, toggleBtn, childUl }
  files: new Map(),        // path -> { file, badgeEl, progressFillEl, toggleBtn, childUl }
};

let scrollObserver = null;

// ===========================================================================
// Small DOM helper -- the only place that sets text content, always via
// textContent, never innerHTML.
// ===========================================================================

function createEl(tag, { className, text } = {}) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

// ===========================================================================
// API layer
// ===========================================================================

async function apiFetch(path, options) {
  const res = await fetch(path, options);
  const raw = await res.text();
  let body = null;
  if (raw) {
    try {
      body = JSON.parse(raw);
    } catch {
      body = null;
    }
  }
  if (!res.ok) {
    const message = (body && typeof body.error === 'string') ? body.error : `request failed: ${res.status}`;
    throw new Error(message);
  }
  return body;
}

const api = {
  listRepos: () => apiFetch('/api/repos').then((b) => b.repos),
  addRepo: (path) =>
    apiFetch('/api/repos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    }).then((b) => b.repo),
  getRefs: (repoId) => apiFetch(`/api/refs?repo=${encodeURIComponent(repoId)}`),
  getDiff: (repoId, base, target) =>
    apiFetch(
      `/api/diff?repo=${encodeURIComponent(repoId)}&base=${encodeURIComponent(base)}&target=${encodeURIComponent(target)}`,
    ),
  setChecked: (repoId, key, checked) =>
    apiFetch('/api/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repo: repoId, key, checked }),
    }),
  setComment: (repoId, key, text, context) =>
    apiFetch('/api/comment', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repo: repoId, key, text, context }),
    }),
  discardOrphan: (repoId, key) =>
    apiFetch('/api/orphan/discard', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repo: repoId, key }),
    }),
  exportReview: (repoId, base, target, format) =>
    apiFetch(
      `/api/export?repo=${encodeURIComponent(repoId)}&base=${encodeURIComponent(base)}&target=${encodeURIComponent(target)}&format=${encodeURIComponent(format)}`,
    ).then((b) => b.text),
};

// ===========================================================================
// Error banner
// ===========================================================================

function showError(message) {
  errorBannerEl.textContent = message;
  errorBannerEl.hidden = false;
}

function clearError() {
  errorBannerEl.textContent = '';
  errorBannerEl.hidden = true;
}

// ===========================================================================
// localStorage persistence -- repo / base / target / view mode
// ===========================================================================

const LS_KEYS = {
  repo: 'lcr.repo',
  base: 'lcr.base',
  target: 'lcr.target',
  viewMode: 'lcr.viewMode',
};

function restoreSavedSelection() {
  appState.repo = localStorage.getItem(LS_KEYS.repo) || null;
  appState.base = localStorage.getItem(LS_KEYS.base) || null;
  appState.target = localStorage.getItem(LS_KEYS.target) || null;
  appState.viewMode = localStorage.getItem(LS_KEYS.viewMode) || 'unified';
}

function saveSelection() {
  setOrRemove(LS_KEYS.repo, appState.repo);
  setOrRemove(LS_KEYS.base, appState.base);
  setOrRemove(LS_KEYS.target, appState.target);
  localStorage.setItem(LS_KEYS.viewMode, appState.viewMode);
}

function setOrRemove(key, value) {
  if (value) localStorage.setItem(key, value);
  else localStorage.removeItem(key);
}

// ===========================================================================
// Sidebar collapse -- whole #tree-pane, toggled from the top-bar button, the
// `b` keyboard shortcut (see handleGlobalKeydown), and restored from
// localStorage on init (see init() at the bottom of this file). Purely a
// class toggle + a couple of attribute/label updates -- no tree rebuild, no
// change to appState.collapsed (which is the per-node fold state and is
// untouched by this).
// ===========================================================================

const SIDEBAR_COLLAPSED_KEY = 'lcr.sidebarCollapsed';

function setSidebarCollapsed(collapsed) {
  appState.sidebarCollapsed = collapsed;
  bodyEl.classList.toggle('sidebar-collapsed', collapsed);
  sidebarToggleBtnEl.textContent = collapsed ? '▸' : '◂'; // ▸ / ◂
  sidebarToggleBtnEl.setAttribute('aria-expanded', String(!collapsed));
  sidebarToggleBtnEl.setAttribute('aria-label', collapsed ? 'show sidebar' : 'hide sidebar');
  sidebarToggleBtnEl.title = collapsed ? 'Show sidebar (b)' : 'Hide sidebar (b)';
  localStorage.setItem(SIDEBAR_COLLAPSED_KEY, collapsed ? '1' : '0');
}

function toggleSidebar() {
  setSidebarCollapsed(!appState.sidebarCollapsed);
}

sidebarToggleBtnEl.addEventListener('click', toggleSidebar);

// ===========================================================================
// Top bar: repo picker + add-repo form
// ===========================================================================

function populateRepoSelect() {
  repoSelectEl.textContent = '';

  // Two repos can share a basename (e.g. ~/work/app vs ~/side/app) -- config.js
  // already disambiguates them by id (path hash), but the option *text* also
  // needs to tell them apart without relying on hover. Append the parent
  // directory only for names that actually collide, so the common case stays
  // as short as possible.
  const nameCounts = new Map();
  for (const repo of appState.repos) {
    nameCounts.set(repo.name, (nameCounts.get(repo.name) || 0) + 1);
  }

  for (const repo of appState.repos) {
    const label = nameCounts.get(repo.name) > 1
      ? `${repo.name} — ${parentDirName(repo.path)}`
      : repo.name;
    const opt = createEl('option', { text: label });
    opt.value = repo.id;
    opt.title = repo.path;
    repoSelectEl.appendChild(opt);
  }
  if (appState.repo) repoSelectEl.value = appState.repo;
  updateRepoSelectTitle();
}

// Last path segment before the given path's own basename, e.g.
// "/Users/x/work/app" -> "work". Used only to disambiguate same-named repos.
function parentDirName(path) {
  const trimmed = path.replace(/\/+$/, '');
  const idx = trimmed.lastIndexOf('/');
  if (idx <= 0) return trimmed;
  const parent = trimmed.slice(0, idx);
  const parentIdx = parent.lastIndexOf('/');
  return parent.slice(parentIdx + 1);
}

// The <select> itself also carries the full path of whichever repo is
// currently selected, so hovering the closed control (not just an open
// option) reveals the full path -- ellipsis-truncated text in the closed
// state would otherwise recover nothing.
function updateRepoSelectTitle() {
  const repo = appState.repos.find((r) => r.id === appState.repo);
  repoSelectEl.title = repo ? repo.path : '';
}

function dedupeRepos(repos) {
  const seen = new Set();
  const out = [];
  for (const r of repos) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    out.push(r);
  }
  return out;
}

repoSelectEl.addEventListener('change', async () => {
  appState.repo = repoSelectEl.value;
  updateRepoSelectTitle();
  saveSelection();
  await loadRefsForRepo();
});

addRepoToggleEl.addEventListener('click', () => {
  addRepoFormEl.hidden = !addRepoFormEl.hidden;
  addRepoErrorEl.textContent = '';
  if (!addRepoFormEl.hidden) addRepoInputEl.focus();
});

addRepoCancelEl.addEventListener('click', () => {
  addRepoFormEl.hidden = true;
  addRepoErrorEl.textContent = '';
  addRepoInputEl.value = '';
});

addRepoFormEl.addEventListener('submit', async (e) => {
  e.preventDefault();
  const path = addRepoInputEl.value.trim();
  addRepoErrorEl.textContent = '';
  if (!path) return;

  try {
    const repo = await api.addRepo(path);
    appState.repos = dedupeRepos([...appState.repos, repo]);
    populateRepoSelect();
    appState.repo = repo.id;
    repoSelectEl.value = repo.id;
    updateRepoSelectTitle();
    addRepoInputEl.value = '';
    addRepoFormEl.hidden = true;
    saveSelection();
    await loadRefsForRepo();
  } catch (err) {
    // Per brief: repo add failures must show the backend error message,
    // right where the user is looking (not console.log-only).
    addRepoErrorEl.textContent = err.message;
  }
});

// ===========================================================================
// Top bar: base / target picker
// ===========================================================================

function populateBaseTargetSelects(refs) {
  baseSelectEl.textContent = '';
  for (const name of [...refs.branches, ...refs.tags]) {
    const opt = createEl('option', { text: name });
    opt.value = name;
    baseSelectEl.appendChild(opt);
  }

  targetSelectEl.textContent = '';
  const workingTreeOpt = createEl('option', { text: 'Working Tree' });
  workingTreeOpt.value = 'WORKING_TREE';
  targetSelectEl.appendChild(workingTreeOpt);
  for (const name of [...refs.branches, ...refs.tags]) {
    const opt = createEl('option', { text: name });
    opt.value = name;
    targetSelectEl.appendChild(opt);
  }
}

function pickDefaultBase(branches) {
  for (const candidate of ['main', 'master', 'dev', 'develop']) {
    if (branches.includes(candidate)) return candidate;
  }
  return branches[0] ?? null;
}

function updateWorkingTreeHint() {
  workingTreeHintEl.hidden = appState.target !== 'WORKING_TREE';
}

baseSelectEl.addEventListener('change', async () => {
  appState.base = baseSelectEl.value;
  saveSelection();
  await loadDiff();
});

targetSelectEl.addEventListener('change', async () => {
  appState.target = targetSelectEl.value;
  updateWorkingTreeHint();
  saveSelection();
  await loadDiff();
});

// ===========================================================================
// Top bar: view mode toggle (unified / side-by-side). This unit only wires
// up the control and the state field -- actual diff re-rendering per mode
// belongs to the diff-rendering unit (EXTENSION POINT 1 below).
// ===========================================================================

function setViewMode(mode) {
  appState.viewMode = mode;
  viewUnifiedBtnEl.classList.toggle('active', mode === 'unified');
  viewSideBySideBtnEl.classList.toggle('active', mode === 'side-by-side');
  viewUnifiedBtnEl.setAttribute('aria-pressed', String(mode === 'unified'));
  viewSideBySideBtnEl.setAttribute('aria-pressed', String(mode === 'side-by-side'));
  saveSelection();
  // Re-render each change point's content in place -- deliberately not a
  // tree rebuild and not a refetch, so the main pane's scroll position
  // (and the tree/scroll-spy state) is untouched. See EXTENSION POINT 1.
  for (const entry of dom.changePoints.values()) {
    renderChangePointContent(entry.changePoint, entry.contentEl);
  }
}

viewUnifiedBtnEl.addEventListener('click', () => setViewMode('unified'));
viewSideBySideBtnEl.addEventListener('click', () => setViewMode('side-by-side'));

// ===========================================================================
// Loading pipeline: repos -> refs -> diff
// ===========================================================================

async function loadRepos() {
  try {
    appState.repos = await api.listRepos();
  } catch (err) {
    showError(err.message);
    appState.repos = [];
  }
  populateRepoSelect();
}

async function loadRefsForRepo() {
  clearError();
  if (!appState.repo) return;

  let refs;
  try {
    refs = await api.getRefs(appState.repo);
  } catch (err) {
    showError(err.message);
    return;
  }

  populateBaseTargetSelects(refs);

  const validRefs = new Set([...refs.branches, ...refs.tags]);
  if (!appState.base || !validRefs.has(appState.base)) {
    appState.base = pickDefaultBase(refs.branches);
  }

  const validTargets = new Set(['WORKING_TREE', ...refs.branches, ...refs.tags]);
  if (!appState.target || !validTargets.has(appState.target)) {
    appState.target = refs.branches.includes(refs.current) ? refs.current : 'WORKING_TREE';
  }

  if (appState.base) baseSelectEl.value = appState.base;
  targetSelectEl.value = appState.target;
  updateWorkingTreeHint();
  saveSelection();

  await loadDiff();
}

async function loadDiff() {
  if (!appState.repo || !appState.base || !appState.target) return;
  clearError();

  let data;
  try {
    data = await api.getDiff(appState.repo, appState.base, appState.target);
  } catch (err) {
    showError(err.message);
    appState.tree = null;
    treeRootEl.textContent = '';
    changepointsRootEl.textContent = '';
    return;
  }

  appState.tree = data;
  appState.currentKey = null;
  renderTree();
}

// ===========================================================================
// Tree + right-pane rendering
// ===========================================================================

function renderTree() {
  if (scrollObserver) {
    scrollObserver.disconnect();
    scrollObserver = null;
  }
  dom.changePoints.clear();
  dom.groups.clear();
  dom.files.clear();
  appState.order = [];

  // A fresh tree means every previous DOM node (including any open comment
  // textarea) is about to be discarded, so any in-progress edit is over too.
  appState.isEditing = false;
  appState.editingKey = null;

  treeRootEl.textContent = '';
  changepointsRootEl.textContent = '';

  for (const file of appState.tree.files) {
    renderFileNode(file);
  }

  updateStatsDom();
  setupScrollSpy();
  renderAllComments();
  renderOrphans();
}

// Splits a file path into "dir/" (muted) + "name" (foreground) so a single
// tree row reads as path + emphasis without relying on indentation --
// addendum: the file level must be visually distinguishable from function
// and change-point levels by typeface/weight, not just indent depth.
function buildFileLabel(path) {
  const label = createEl('span', { className: 'tree-label' });
  const slash = path.lastIndexOf('/');
  if (slash === -1) {
    label.appendChild(createEl('span', { className: 'tree-name', text: path }));
    return label;
  }
  label.appendChild(createEl('span', { className: 'tree-dir', text: path.slice(0, slash + 1) }));
  label.appendChild(createEl('span', { className: 'tree-name', text: path.slice(slash + 1) }));
  return label;
}

// Thin 2px progress rail shown under file / function rows (addendum:
// "how much is left" should be scannable, not read off a small grey
// counter). Returns the outer track element; caller keeps the fill ref to
// update its width in place as checks come in, without re-rendering.
function buildProgressRail(checked, total) {
  const track = createEl('div', { className: 'tree-progress' });
  const fill = createEl('span', { className: 'tree-progress-fill' });
  fill.style.width = total > 0 ? `${Math.round((checked / total) * 100)}%` : '0%';
  track.appendChild(fill);
  return { track, fill };
}

function renderFileNode(file) {
  const li = createEl('li', { className: 'tree-file' });

  // File row + its progress rail live together in one sticky header (see
  // .tree-file-header in style.css) -- addendum: the file level is a
  // container, and a container should stay labeled while its contents
  // scroll past. Everything sticks as one unit so the progress rail stays
  // visible too, not just the name.
  const header = createEl('div', { className: 'tree-file-header' });
  const row = createEl('div', { className: 'tree-row tree-file-row' });

  const collapseId = `file:${file.path}`;
  const collapsed = appState.collapsed.has(collapseId);

  const toggleBtn = createEl('button', { className: 'toggle-btn', text: collapsed ? '▸' : '▾' });
  toggleBtn.type = 'button';
  toggleBtn.addEventListener('click', () => toggleCollapse(collapseId, 'file', file.path));

  const label = buildFileLabel(file.path);
  const badge = createEl('span', { className: 'tree-badge', text: `${file.checked}/${file.total}` });
  if (file.allChecked) badge.classList.add('all-checked');

  row.append(toggleBtn, label, badge);
  header.appendChild(row);

  const { track: progressTrack, fill: progressFill } = buildProgressRail(file.checked, file.total);
  header.appendChild(progressTrack);
  li.appendChild(header);

  const childUl = createEl('ul', { className: 'tree-children' });
  childUl.hidden = collapsed;
  li.appendChild(childUl);

  dom.files.set(file.path, { file, badgeEl: badge, progressFillEl: progressFill, toggleBtn, childUl });
  treeRootEl.appendChild(li);

  file.groups.forEach((group, groupIdx) => {
    if (group.name === null) {
      // The file-level bucket: no extra tree level, its change points hang
      // directly under the file (this is how non-JS files render as two
      // levels instead of three -- see model.js).
      for (const changePoint of group.changePoints) {
        renderChangePoint(changePoint, group, file, null, childUl);
      }
      return;
    }

    const groupKey = `${file.path}::g${groupIdx}`;
    renderGroupNode(group, groupKey, file, childUl);
  });
}

function renderGroupNode(group, groupKey, file, parentUl) {
  const li = createEl('li', { className: 'tree-group' });
  const row = createEl('div', { className: 'tree-row tree-group-row' });

  const collapseId = `group:${groupKey}`;
  const collapsed = appState.collapsed.has(collapseId);

  const toggleBtn = createEl('button', { className: 'toggle-btn', text: collapsed ? '▸' : '▾' });
  toggleBtn.type = 'button';
  toggleBtn.addEventListener('click', () => toggleCollapse(collapseId, 'group', groupKey));

  const label = createEl('span', { className: 'tree-label', text: group.name });
  const badge = createEl('span', { className: 'tree-badge', text: `${group.checked}/${group.total}` });
  if (group.allChecked) badge.classList.add('all-checked');

  row.append(toggleBtn, label, badge);
  li.appendChild(row);

  const { track: progressTrack, fill: progressFill } = buildProgressRail(group.checked, group.total);
  li.appendChild(progressTrack);

  const childUl = createEl('ul', { className: 'tree-children' });
  childUl.hidden = collapsed;
  li.appendChild(childUl);

  dom.groups.set(groupKey, { group, badgeEl: badge, progressFillEl: progressFill, toggleBtn, childUl });
  parentUl.appendChild(li);

  for (const changePoint of group.changePoints) {
    renderChangePoint(changePoint, group, file, groupKey, childUl);
  }
}

function toggleCollapse(collapseId, kind, id) {
  const entry = kind === 'file' ? dom.files.get(id) : dom.groups.get(id);
  if (!entry) return;

  const nowCollapsed = !appState.collapsed.has(collapseId);
  if (nowCollapsed) {
    appState.collapsed.add(collapseId);
  } else {
    appState.collapsed.delete(collapseId);
  }
  entry.childUl.hidden = nowCollapsed;
  entry.toggleBtn.textContent = nowCollapsed ? '▸' : '▾';
}

function renderChangePoint(changePoint, group, file, groupKey, parentUl) {
  const key = changePoint.id;
  const rangeLabel = `+${changePoint.newStart}..${changePoint.newEnd}`;

  // --- left tree row -------------------------------------------------
  const li = createEl('li', { className: 'tree-changepoint' });
  li.dataset.key = key;

  const label = createEl('span', { className: 'tree-label', text: rangeLabel });
  const leftCheckbox = document.createElement('input');
  leftCheckbox.type = 'checkbox';
  leftCheckbox.checked = changePoint.checked;
  leftCheckbox.setAttribute('aria-label', `mark ${rangeLabel} reviewed`);
  leftCheckbox.addEventListener('click', (e) => e.stopPropagation());
  leftCheckbox.addEventListener('change', () => onToggleCheck(key, leftCheckbox.checked));

  li.append(label, leftCheckbox);
  li.addEventListener('click', () => selectChangePoint(key, { scroll: true }));
  parentUl.appendChild(li);

  // --- right pane container ------------------------------------------
  // EXTENSION POINT 4: data-key is how the comment unit locates this
  // container to attach its comment UI.
  const container = createEl('div', { className: 'changepoint' });
  container.dataset.key = key;

  const header = createEl('div', { className: 'changepoint-header' });
  const headerLabel = createEl('span', { className: 'changepoint-label', text: rangeLabel });
  const rightCheckbox = document.createElement('input');
  rightCheckbox.type = 'checkbox';
  rightCheckbox.checked = changePoint.checked;
  rightCheckbox.setAttribute('aria-label', `mark ${rangeLabel} reviewed`);
  rightCheckbox.addEventListener('change', () => onToggleCheck(key, rightCheckbox.checked));
  header.append(headerLabel, rightCheckbox);
  container.appendChild(header);

  container.classList.toggle('checked', changePoint.checked);

  const content = createEl('div', { className: 'changepoint-content' });
  renderChangePointContent(changePoint, content);
  container.appendChild(content);

  changepointsRootEl.appendChild(container);

  dom.changePoints.set(key, {
    changePoint,
    group,
    file,
    groupKey,
    leftRow: li,
    leftCheckbox,
    rightContainer: container,
    rightCheckbox,
    contentEl: content,
  });
  appState.order.push(key);
}

// ===========================================================================
// EXTENSION POINT 1 -- render a single change point's content area.
//
// Reads appState.viewMode to pick unified vs. side-by-side. Signature stays
// stable: (changePoint, contentEl) -> void, contentEl already appended to
// the DOM. Called both from renderChangePoint() (initial render) and from
// setViewMode() (re-render in place on mode switch -- no refetch, no
// scroll reset).
//
// Security: diff content comes from the reviewed repo and may contain
// anything, including literal HTML. Every path below writes text via
// textContent/createEl, with exactly one exception: buildCodeSpan() may
// assign to innerHTML, but only ever with the *return value* of
// Prism.highlight(text, grammar, lang) -- Prism's tokenizer HTML-escapes
// the source text itself before wrapping matched tokens in spans, so the
// result is always safe markup. Raw `line.text` is never assigned to
// innerHTML anywhere.
// ===========================================================================

// Line objects come from git.js and are shared by reference with server
// state (see model.js/state.js comments) -- read-only, never mutated here.

const EXT_TO_PRISM_LANG = {
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  css: 'css',
  html: 'markup',
  htm: 'markup',
  xml: 'markup',
  svg: 'markup',
};

// Resolves a Prism language name for a file path, or null if the extension
// is unknown or the vendored Prism bundle doesn't have that grammar loaded.
// Callers must treat null as "render as plain text" -- never throw.
function getPrismLanguage(filePath) {
  const match = /\.([^./]+)$/.exec(filePath || '');
  const ext = match ? match[1].toLowerCase() : '';
  const lang = EXT_TO_PRISM_LANG[ext];
  if (!lang) return null;
  if (typeof Prism === 'undefined' || !Prism.languages || !Prism.languages[lang]) return null;
  return lang;
}

// Builds the inline text/code carrier for one line's content. Highlighted
// path uses Prism.highlight() (escapes internally, see block comment
// above); everything else -- including any Prism failure -- falls back to
// plain textContent so an unknown/broken grammar degrades instead of
// crashing the render.
function buildCodeSpan(text, lang) {
  const span = createEl('span', { className: 'diff-code-text' });
  if (lang) {
    try {
      span.innerHTML = Prism.highlight(text, Prism.languages[lang], lang);
      return span;
    } catch {
      // fall through to plain text below
    }
  }
  span.textContent = text;
  return span;
}

function diffRowTypeClass(type) {
  if (type === '+') return 'add';
  if (type === '-') return 'del';
  return 'ctx';
}

function renderChangePointContent(changePoint, contentEl) {
  contentEl.textContent = '';
  if (appState.viewMode === 'side-by-side') {
    renderSideBySide(changePoint, contentEl);
  } else {
    renderUnified(changePoint, contentEl);
  }
}

// ---------------------------------------------------------------------------
// Unified: one row per line, old-line# | new-line# | marker | code.
// ---------------------------------------------------------------------------

function renderUnified(changePoint, contentEl) {
  const lang = getPrismLanguage(changePoint.filePath);
  const container = createEl('div', { className: 'diff-unified' });
  for (const line of changePoint.lines) {
    container.appendChild(buildUnifiedRow(line, lang));
  }
  contentEl.appendChild(container);
}

function buildUnifiedRow(line, lang) {
  const row = createEl('div', { className: `diff-row diff-row-${diffRowTypeClass(line.type)}` });
  row.appendChild(
    createEl('span', {
      className: 'diff-gutter',
      text: line.oldLine != null ? String(line.oldLine) : '',
    }),
  );
  row.appendChild(
    createEl('span', {
      className: 'diff-gutter',
      text: line.newLine != null ? String(line.newLine) : '',
    }),
  );
  row.appendChild(createEl('span', { className: 'diff-marker', text: line.type }));
  const code = createEl('span', { className: 'diff-code' });
  code.appendChild(buildCodeSpan(line.text, lang));
  row.appendChild(code);
  return row;
}

// ---------------------------------------------------------------------------
// Side-by-side: old lines on the left, new lines on the right, aligned row
// by row. Context lines appear on both sides. A run of N '-' lines directly
// followed by a run of M '+' lines pairs the first min(N,M) rows; the
// leftover rows are single-sided (empty cell on the other side).
// ---------------------------------------------------------------------------

function pairLinesForSideBySide(lines) {
  const rows = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    if (line.type === ' ') {
      rows.push({ left: line, right: line });
      i++;
      continue;
    }

    if (line.type === '-') {
      const dels = [];
      while (i < lines.length && lines[i].type === '-') {
        dels.push(lines[i]);
        i++;
      }
      const adds = [];
      while (i < lines.length && lines[i].type === '+') {
        adds.push(lines[i]);
        i++;
      }
      const pairCount = Math.min(dels.length, adds.length);
      for (let k = 0; k < pairCount; k++) rows.push({ left: dels[k], right: adds[k] });
      for (let k = pairCount; k < dels.length; k++) rows.push({ left: dels[k], right: null });
      for (let k = pairCount; k < adds.length; k++) rows.push({ left: null, right: adds[k] });
      continue;
    }

    if (line.type === '+') {
      // '+' run with no immediately preceding '-' run (e.g. a pure addition).
      const adds = [];
      while (i < lines.length && lines[i].type === '+') {
        adds.push(lines[i]);
        i++;
      }
      for (const add of adds) rows.push({ left: null, right: add });
      continue;
    }

    // Unrecognised line type: git.js only ever emits '+' / '-' / ' ' today,
    // but if that ever changes, skip the line rather than falling through
    // into the '+' branch above -- which only advances `i` while
    // lines[i].type === '+' and would otherwise spin forever on anything
    // else. Same precaution model.js already takes for this class of input
    // (see its buildAnnotated line-type handling: "寧可跳過這行也不要讓
    // cursor 被污染").
    i++;
  }
  return rows;
}

function renderSideBySide(changePoint, contentEl) {
  const lang = getPrismLanguage(changePoint.filePath);
  const rows = pairLinesForSideBySide(changePoint.lines);

  const container = createEl('div', { className: 'diff-sidebyside' });
  const leftCol = createEl('div', { className: 'diff-side diff-side-left' });
  const rightCol = createEl('div', { className: 'diff-side diff-side-right' });

  for (const { left, right } of rows) {
    leftCol.appendChild(buildSideBySideRow(left, lang, 'old'));
    rightCol.appendChild(buildSideBySideRow(right, lang, 'new'));
  }

  container.append(leftCol, rightCol);
  contentEl.appendChild(container);
}

function buildSideBySideRow(line, lang, side) {
  if (!line) {
    const row = createEl('div', { className: 'diff-row diff-row-empty' });
    row.appendChild(createEl('span', { className: 'diff-gutter' }));
    row.appendChild(createEl('span', { className: 'diff-marker' }));
    row.appendChild(createEl('span', { className: 'diff-code' }));
    return row;
  }

  const row = createEl('div', { className: `diff-row diff-row-${diffRowTypeClass(line.type)}` });
  const lineNo = side === 'old' ? line.oldLine : line.newLine;
  row.appendChild(
    createEl('span', { className: 'diff-gutter', text: lineNo != null ? String(lineNo) : '' }),
  );
  row.appendChild(createEl('span', { className: 'diff-marker', text: line.type }));
  const code = createEl('span', { className: 'diff-code' });
  code.appendChild(buildCodeSpan(line.text, lang));
  row.appendChild(code);
  return row;
}

// ===========================================================================
// Checking a change point -- POST /api/check, then update the tree in place.
// Deliberately does not refetch /api/diff: that would reset scroll position.
// ===========================================================================

async function onToggleCheck(key, checked) {
  clearError();
  try {
    await api.setChecked(appState.repo, key, checked);
    applyCheckedChange(key, checked);
  } catch (err) {
    showError(err.message);
    // Request failed: put both checkboxes back to the pre-click state.
    const entry = dom.changePoints.get(key);
    if (entry) {
      entry.leftCheckbox.checked = !checked;
      entry.rightCheckbox.checked = !checked;
    }
  }
}

function applyCheckedChange(key, checked) {
  const entry = dom.changePoints.get(key);
  if (!entry) return;
  const { changePoint, group, file, groupKey } = entry;
  if (changePoint.checked === checked) return;

  changePoint.checked = checked;
  const delta = checked ? 1 : -1;

  group.checked += delta;
  group.allChecked = group.total > 0 && group.checked === group.total;

  file.checked += delta;
  file.allChecked = file.total > 0 && file.checked === file.total;

  appState.tree.stats.checked += delta;

  entry.leftCheckbox.checked = checked;
  entry.rightCheckbox.checked = checked;
  entry.rightContainer.classList.toggle('checked', checked);
  updateGroupDom(groupKey);
  updateFileDom(file.path);
  updateStatsDom();
}

function progressPercent(checked, total) {
  return total > 0 ? `${Math.round((checked / total) * 100)}%` : '0%';
}

function updateGroupDom(groupKey) {
  if (!groupKey) return;
  const entry = dom.groups.get(groupKey);
  if (!entry) return;
  entry.badgeEl.textContent = `${entry.group.checked}/${entry.group.total}`;
  entry.badgeEl.classList.toggle('all-checked', entry.group.allChecked);
  entry.progressFillEl.style.width = progressPercent(entry.group.checked, entry.group.total);
}

function updateFileDom(path) {
  const entry = dom.files.get(path);
  if (!entry) return;
  entry.badgeEl.textContent = `${entry.file.checked}/${entry.file.total}`;
  entry.badgeEl.classList.toggle('all-checked', entry.file.allChecked);
  entry.progressFillEl.style.width = progressPercent(entry.file.checked, entry.file.total);
}

function updateStatsDom() {
  if (!appState.tree) return;
  statsBadgeEl.textContent = `${appState.tree.stats.checked}/${appState.tree.stats.total}`;
}

// ===========================================================================
// EXTENSION POINT 3 -- current change point + moving it.
//
// selectChangePoint() is the single place that changes appState.currentKey
// and the highlight it drives. moveSelection(delta) walks appState.order
// (already in tree/scroll order) and is what the keyboard-navigation unit
// calls for "next"/"previous" change point.
// ===========================================================================

function selectChangePoint(key, { scroll = false } = {}) {
  if (!key || !dom.changePoints.has(key)) return;
  if (appState.currentKey === key && !scroll) return;

  const prevKey = appState.currentKey;
  appState.currentKey = key;
  if (prevKey && prevKey !== key) setHighlight(prevKey, false);
  setHighlight(key, true);

  if (scroll) {
    const entry = dom.changePoints.get(key);
    // Addendum: j/k movement gets a 150ms smooth scroll so the user can
    // perceive direction, but prefers-reduced-motion always wins -- jump
    // instantly instead.
    const behavior = prefersReducedMotion() ? 'auto' : 'smooth';
    entry.rightContainer.scrollIntoView({ block: 'start', behavior });
  }
}

function prefersReducedMotion() {
  return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function moveSelection(delta) {
  const order = appState.order;
  if (order.length === 0) return;
  const currentIdx = appState.currentKey ? order.indexOf(appState.currentKey) : -1;
  const nextIdx = Math.min(Math.max(currentIdx + delta, 0), order.length - 1);
  selectChangePoint(order[nextIdx], { scroll: true });
}

function setHighlight(key, on) {
  const entry = dom.changePoints.get(key);
  if (!entry) return;
  entry.leftRow.classList.toggle('current', on);
  entry.rightContainer.classList.toggle('current', on);
  if (on) entry.leftRow.scrollIntoView({ block: 'nearest' });
}

// ===========================================================================
// Scroll spy: right-pane scroll -> left tree highlight, via
// IntersectionObserver (per brief). Root is the main pane's own scroll
// container, not the viewport, since the main pane scrolls independently.
// ===========================================================================

// Persistent intersection state, keyed by change-point id. An
// IntersectionObserver callback only ever reports the *delta* -- targets
// whose isIntersecting flag changed since the previous callback -- not the
// full set of everything currently intersecting. Two change points that
// render close together relative to the top band (rootMargin below) can
// both be "in play" at once, but only one of them may appear in a given
// batch (the other's state simply didn't change). Deriving the current
// selection from the batch alone therefore silently picks whichever
// change point happened to flip most recently, not whichever one is
// actually topmost right now -- and that wrong pick can even be an
// already-checked change point, which corrupts `u`'s "jump to next
// unread" guarantee. Tracking cumulative state in this map and deriving
// the selection from the whole map, every time, fixes that: every batch
// updates the map, then the topmost currently-intersecting entry (by
// boundingClientRect.top) is recomputed from the full map, not just the
// entries the batch happened to mention.
const intersectionState = new Map(); // key -> { isIntersecting, top }

function setupScrollSpy() {
  intersectionState.clear();
  scrollObserver = new IntersectionObserver(handleIntersections, {
    root: mainPaneEl,
    // Treat "current" as whichever change point occupies the top band of
    // the main pane, not merely "any pixel visible".
    rootMargin: '0px 0px -70% 0px',
    threshold: 0,
  });
  for (const entry of dom.changePoints.values()) {
    scrollObserver.observe(entry.rightContainer);
  }
}

function handleIntersections(batch) {
  for (const e of batch) {
    const key = e.target.dataset.key;
    if (!key) continue;
    intersectionState.set(key, {
      isIntersecting: e.isIntersecting,
      top: e.boundingClientRect.top,
    });
  }

  let topKey = null;
  let topValue = Infinity;
  for (const [key, state] of intersectionState) {
    if (!state.isIntersecting) continue;
    if (state.top < topValue) {
      topValue = state.top;
      topKey = key;
    }
  }
  if (topKey) selectChangePoint(topKey, { scroll: false });
}

// ===========================================================================
// EXTENSION POINT 4 continued -- comment UI, attached to every change point
// via its container's data-key (set by renderChangePoint above). Called
// once per tree render (see renderTree), after every change point exists,
// so it never has to guess at DOM ordering.
//
// A comment section has two mutually exclusive render states:
//   - view mode: existing comment text (or an "add comment" affordance)
//   - edit mode: a textarea, Esc to cancel / Cmd|Ctrl+Enter to save
//
// Saving always goes through POST /api/comment and updates the in-memory
// changePoint + DOM in place -- no refetch of the tree (see saveComment).
// ===========================================================================

function renderAllComments() {
  for (const entry of dom.changePoints.values()) {
    if (!entry.commentEl) {
      const section = createEl('div', { className: 'comment-section' });
      // Programmatically focusable (tabIndex -1) but not a Tab stop: this is
      // where focus lands after a save/cancel (see renderCommentView's
      // focusTrigger below), instead of on the Edit/+Comment button. Landing
      // on an activatable <button> there means a `space` press right after
      // saving a comment -- exactly the rhythm the brief calls out ("save a
      // comment, then press space to keep reading") -- activates the button
      // and reopens the editor instead of scrolling. A non-interactive
      // container has no activation behavior, so `space` falls through to
      // the browser's native scroll. The Edit/+Comment button itself is
      // untouched and still reachable by tabbing through the document in
      // order.
      section.tabIndex = -1;
      entry.rightContainer.appendChild(section);
      entry.commentEl = section;
    }
    renderCommentView(entry);
  }
}

// View mode: shows the saved comment (via textContent only -- comment text
// comes from the reviewed repo's own diff plus whatever the user typed, and
// must never be interpreted as markup) plus Edit/Delete, or an "add
// comment" button when there is none yet.
function renderCommentView(entry, { focusTrigger = false } = {}) {
  const { commentEl, changePoint } = entry;
  commentEl.textContent = '';

  if (changePoint.comment) {
    const body = createEl('div', { className: 'comment-body' });
    body.appendChild(createEl('span', { className: 'comment-label', text: 'Comment' }));
    body.appendChild(createEl('p', { className: 'comment-text', text: changePoint.comment }));

    const actions = createEl('div', { className: 'comment-actions' });
    const editBtn = createEl('button', { className: 'comment-btn', text: 'Edit' });
    editBtn.type = 'button';
    editBtn.addEventListener('click', () => enterCommentEdit(entry));
    const deleteBtn = createEl('button', { className: 'comment-btn comment-btn-danger', text: 'Delete' });
    deleteBtn.type = 'button';
    deleteBtn.addEventListener('click', () => saveComment(entry, ''));
    actions.append(editBtn, deleteBtn);
    body.appendChild(actions);

    commentEl.appendChild(body);
    // Focus the section container, not editBtn -- see the tabIndex comment
    // in renderAllComments for why (space-reopens-editor bug, finding 2).
    if (focusTrigger) commentEl.focus();
  } else {
    const addBtn = createEl('button', { className: 'comment-btn comment-add-btn', text: '+ Comment' });
    addBtn.type = 'button';
    addBtn.addEventListener('click', () => enterCommentEdit(entry));
    commentEl.appendChild(addBtn);
    // Focus the section container, not addBtn -- see the tabIndex comment
    // in renderAllComments for why (space-reopens-editor bug, finding 2).
    if (focusTrigger) commentEl.focus();
  }
}

// Edit mode. Sets appState.isEditing -- see EXTENSION POINT 5 at the
// appState declaration -- for the whole time the textarea exists.
function enterCommentEdit(entry) {
  // Only one change point can be in edit mode at a time, so editingKey is
  // always an accurate answer to "which one" -- opening a second editor
  // auto-cancels the first (same as Esc: discards unsaved text).
  if (appState.editingKey && appState.editingKey !== entry.changePoint.id) {
    const other = dom.changePoints.get(appState.editingKey);
    if (other) renderCommentView(other);
  }

  appState.isEditing = true;
  appState.editingKey = entry.changePoint.id;

  const { commentEl, changePoint } = entry;
  commentEl.textContent = '';

  const textarea = document.createElement('textarea');
  textarea.className = 'comment-textarea';
  textarea.value = changePoint.comment || '';
  textarea.rows = 4;
  textarea.setAttribute('aria-label', 'comment text');

  const hint = createEl('div', {
    className: 'comment-hint',
    text: 'Esc cancel  ·  ⌘/Ctrl+Enter save  ·  clear + save = delete',
  });

  const actions = createEl('div', { className: 'comment-actions' });
  const saveBtn = createEl('button', { className: 'comment-btn comment-btn-primary', text: 'Save' });
  saveBtn.type = 'button';
  saveBtn.addEventListener('click', () => saveComment(entry, textarea.value));
  const cancelBtn = createEl('button', { className: 'comment-btn', text: 'Cancel' });
  cancelBtn.type = 'button';
  cancelBtn.addEventListener('click', () => exitCommentEdit(entry));
  actions.append(saveBtn, cancelBtn);

  // Stop every keyboard event from leaving the textarea: this is the other
  // half of EXTENSION POINT 5 -- even before the next unit's shortcut
  // handler exists, nothing typed here should ever be treated as anything
  // but text.
  const stop = (e) => e.stopPropagation();
  textarea.addEventListener('keyup', stop);
  textarea.addEventListener('keypress', stop);
  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      exitCommentEdit(entry);
    } else if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      saveComment(entry, textarea.value);
    }
    stop(e);
  });

  commentEl.append(textarea, hint, actions);
  textarea.focus();
  textarea.setSelectionRange(textarea.value.length, textarea.value.length);
}

function exitCommentEdit(entry) {
  appState.isEditing = false;
  appState.editingKey = null;
  renderCommentView(entry, { focusTrigger: true });
}

// Saves via POST /api/comment (server treats empty/whitespace-only text as
// delete -- see state.js setComment), then updates changePoint.comment and
// re-renders just this one comment section in place. Never refetches
// GET /api/diff, per the brief ("存檔後就地更新畫面，不要整棵樹重抓").
async function saveComment(entry, text) {
  clearError();
  const { changePoint } = entry;
  const context = {
    filePath: changePoint.filePath,
    functionName: changePoint.functionName,
    diffText: changePoint.diffText,
  };

  try {
    await api.setComment(appState.repo, changePoint.id, text, context);
  } catch (err) {
    showError(err.message);
    return; // stay in edit mode -- the user's text is still in the textarea
  }

  const hadCommentBefore = changePoint.comment != null;
  const isEmpty = typeof text !== 'string' || text.trim() === '';
  changePoint.comment = isEmpty ? null : text;
  const hasCommentAfter = changePoint.comment != null;

  if (appState.tree && appState.tree.stats) {
    if (hadCommentBefore && !hasCommentAfter) appState.tree.stats.comments -= 1;
    if (!hadCommentBefore && hasCommentAfter) appState.tree.stats.comments += 1;
  }

  // Only clear the shared editing flag if `entry` is the change point it
  // actually refers to. saveComment is also reached directly from the
  // view-mode Delete button (no editor open for that entry at all), so an
  // unconditional reset here can clobber appState.isEditing/editingKey out
  // from under an *unrelated* change point's still-open textarea -- at which
  // point every single-key shortcut goes live while a comment editor is
  // visibly open and still holds the user's unsaved text. Mirrors the guard
  // enterCommentEdit already applies before stealing edit mode from another
  // entry.
  if (appState.editingKey === entry.changePoint.id) {
    appState.isEditing = false;
    appState.editingKey = null;
  }
  renderCommentView(entry, { focusTrigger: true });
}

// ===========================================================================
// Orphan comments -- change points whose underlying diff no longer exists
// (GET /api/diff's `orphans` array; see state.js buildAnnotated). Never
// silently dropped: shown in their own section with the filePath /
// functionName / diffText snapshot the comment was originally attached to,
// entirely via textContent (that snapshot is reviewed-repo content and must
// never be treated as markup). "Keep" needs no API call -- not touching an
// orphan *is* keeping it; only "discard" hits the network.
// ===========================================================================

let orphansRootEl = null;

function ensureOrphansRootEl() {
  if (orphansRootEl) return orphansRootEl;
  orphansRootEl = createEl('section', { className: 'orphans-section' });
  orphansRootEl.id = 'orphans-root';
  orphansRootEl.hidden = true;
  // Appended after changepointsRootEl (its only sibling inside main-pane),
  // so orphans read as an appendix at the end of the primary review flow
  // rather than something the user has to scroll past first.
  mainPaneEl.appendChild(orphansRootEl);
  return orphansRootEl;
}

function renderOrphans() {
  const root = ensureOrphansRootEl();
  root.textContent = '';

  const orphans = (appState.tree && appState.tree.orphans) || [];
  if (orphans.length === 0) {
    root.hidden = true;
    return;
  }
  root.hidden = false;

  root.appendChild(
    createEl('h2', { className: 'orphans-heading', text: `Orphaned comments (${orphans.length})` }),
  );
  root.appendChild(
    createEl('p', {
      className: 'orphans-note',
      text:
        'These change points no longer exist in the current diff -- the code was edited or removed. ' +
        'Leaving an entry alone keeps it; only "Discard" deletes it.',
    }),
  );

  for (const orphan of orphans) {
    root.appendChild(buildOrphanCard(orphan));
  }
}

function buildOrphanCard(orphan) {
  const card = createEl('div', { className: 'orphan-card' });
  card.dataset.key = orphan.key;

  const meta = createEl('div', { className: 'orphan-meta' });
  meta.appendChild(createEl('span', { className: 'orphan-file', text: orphan.filePath || '(unknown file)' }));
  if (orphan.functionName) {
    meta.appendChild(createEl('span', { className: 'orphan-fn', text: orphan.functionName }));
  }
  card.appendChild(meta);

  const diffPre = createEl('pre', { className: 'orphan-diff' });
  diffPre.textContent = orphan.diffText || '';
  card.appendChild(diffPre);

  card.appendChild(createEl('p', { className: 'orphan-comment', text: orphan.text }));

  const actions = createEl('div', { className: 'orphan-actions' });
  const discardBtn = createEl('button', { className: 'comment-btn comment-btn-danger', text: 'Discard' });
  discardBtn.type = 'button';
  discardBtn.addEventListener('click', () => discardOrphan(orphan.key, card));
  actions.append(discardBtn, createEl('span', { className: 'orphan-keep-hint', text: 'leave it alone to keep it' }));
  card.appendChild(actions);

  return card;
}

async function discardOrphan(key, cardEl) {
  clearError();
  try {
    await api.discardOrphan(appState.repo, key);
  } catch (err) {
    showError(err.message);
    return;
  }
  if (appState.tree) {
    appState.tree.orphans = appState.tree.orphans.filter((o) => o.key !== key);
  }
  cardEl.remove();
  if (orphansRootEl && (!appState.tree || appState.tree.orphans.length === 0)) {
    orphansRootEl.hidden = true;
  }
}

// ===========================================================================
// Export -- two clipboard-only exports (never writes a file). Buttons live
// in the top bar, appended after the stats badge (whose margin-left: auto
// already pushes everything from that point on to the right edge -- see
// style.css). navigator.clipboard.writeText() is tried first; if it throws
// (permission denied, insecure context, or simply unavailable) a fallback
// panel with a select-all-able textarea is shown instead, with the reason.
// ===========================================================================

const exportGroupEl = createEl('div', { className: 'topbar-group export-group' });
const exportClaudeBtnEl = createEl('button', { className: 'export-btn', text: '匯出我的疑問（Claude）' });
exportClaudeBtnEl.type = 'button';
const exportMarkdownBtnEl = createEl('button', { className: 'export-btn', text: '匯出筆記（Markdown）' });
exportMarkdownBtnEl.type = 'button';
exportGroupEl.append(exportClaudeBtnEl, exportMarkdownBtnEl);
topbarEl.appendChild(exportGroupEl);

exportClaudeBtnEl.addEventListener('click', () => handleExportClick('claude', exportClaudeBtnEl));
exportMarkdownBtnEl.addEventListener('click', () => handleExportClick('markdown', exportMarkdownBtnEl));

async function handleExportClick(format, btnEl) {
  if (!appState.repo || !appState.base || !appState.target) return;
  clearError();

  let text;
  try {
    text = await api.exportReview(appState.repo, appState.base, appState.target, format);
  } catch (err) {
    showError(err.message);
    return;
  }

  await copyToClipboardWithFeedback(text, btnEl);
}

async function copyToClipboardWithFeedback(text, btnEl) {
  const originalText = btnEl.textContent;
  try {
    if (!navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') {
      throw new Error('clipboard API not available in this browser context');
    }
    await navigator.clipboard.writeText(text);
    hideClipboardFallback();
    btnEl.textContent = '已複製';
    btnEl.classList.add('copied');
    btnEl.disabled = true;
    setTimeout(() => {
      btnEl.textContent = originalText;
      btnEl.classList.remove('copied');
      btnEl.disabled = false;
    }, 1600);
  } catch (err) {
    showClipboardFallback(text, err);
  }
}

let clipboardFallbackEl = null;

function ensureClipboardFallbackEl() {
  if (clipboardFallbackEl) return clipboardFallbackEl;
  clipboardFallbackEl = createEl('div', { className: 'clipboard-fallback' });
  clipboardFallbackEl.hidden = true;
  // Same band as #error-banner -- inserted right before #body so it reads
  // as a persistent, full-width notice rather than a floating overlay.
  appEl.insertBefore(clipboardFallbackEl, bodyEl);
  return clipboardFallbackEl;
}

function showClipboardFallback(text, err) {
  const el = ensureClipboardFallbackEl();
  el.textContent = '';
  el.hidden = false;

  const reason = err && err.message ? err.message : 'clipboard access was blocked';
  el.appendChild(
    createEl('p', {
      className: 'clipboard-fallback-reason',
      text: `Couldn't copy to the clipboard automatically (${reason}). Select all and copy manually:`,
    }),
  );

  const textarea = document.createElement('textarea');
  textarea.className = 'clipboard-fallback-textarea';
  textarea.readOnly = true;
  textarea.rows = 8;
  textarea.value = text;
  el.appendChild(textarea);

  const closeBtn = createEl('button', { className: 'comment-btn', text: 'Close' });
  closeBtn.type = 'button';
  closeBtn.addEventListener('click', hideClipboardFallback);
  el.appendChild(closeBtn);

  textarea.focus();
  textarea.select();
}

function hideClipboardFallback() {
  if (clipboardFallbackEl) clipboardFallbackEl.hidden = true;
}

// ===========================================================================
// Empty state -- first run, no repos configured yet. Points at the
// add-repo form that already lives in the top bar (see EXTENSION POINT
// above `addRepoToggleEl`) instead of duplicating that UI here.
// ===========================================================================

function showEmptyState() {
  changepointsRootEl.textContent = '';
  changepointsRootEl.appendChild(
    createEl('p', {
      className: 'empty-state',
      text: 'No repos configured yet. Click "+" next to the repo selector above to add one.',
    }),
  );
}

// ===========================================================================
// Keyboard shortcuts + help overlay -- final unit. Single-key shortcuts
// (j/k/x/u/c/f/1/2/?) live in one document-level keydown handler, gated by
// two independent checks per the brief: appState.isEditing (true for the
// whole life of an open comment textarea -- see EXTENSION POINT 5) and the
// event's own target (input/textarea/contenteditable), so a comment field
// losing track of isEditing for any reason still can't leak keystrokes into
// navigation. `space` is deliberately never handled here -- the browser's
// own scroll behavior for it is exactly what the addendum's target user
// wants, and intercepting it would be a regression, not a feature.
//
// All the actions below reuse selectChangePoint()/moveSelection() (EXTENSION
// POINT 3) and the existing click-driven handlers (onToggleCheck,
// enterCommentEdit, toggleCollapse, setViewMode) -- no parallel navigation
// or state model is introduced here.
// ===========================================================================

// <input type="checkbox|radio|button"> does not accept text entry, so it
// must not count as a "typing target" -- doing so left every single-key
// shortcut dead after an ordinary mouse click on a review checkbox, until
// focus moved elsewhere. <button> elements were never affected (tagName is
// 'BUTTON', not 'INPUT') -- this only narrows the INPUT branch. Only
// genuine text-entry contexts count: text-like <input> types, <textarea>,
// and contenteditable.
const NON_TEXT_INPUT_TYPES = new Set(['checkbox', 'radio', 'button']);

function isTypingTarget(target) {
  if (!target) return false;
  const tag = target.tagName;
  if (tag === 'INPUT') return !NON_TEXT_INPUT_TYPES.has(target.type);
  if (tag === 'TEXTAREA') return true;
  return Boolean(target.isContentEditable);
}

// `f`: fold/unfold the tree node the current change point lives under. Most
// change points hang under a function group; the file-level bucket (group
// === null, see renderFileNode) has no function level, so this falls back
// to folding the file itself instead of doing nothing.
function handleToggleCurrentFold() {
  const key = appState.currentKey;
  if (!key) return;
  const entry = dom.changePoints.get(key);
  if (!entry) return;
  if (entry.groupKey) {
    toggleCollapse(`group:${entry.groupKey}`, 'group', entry.groupKey);
  } else {
    toggleCollapse(`file:${entry.file.path}`, 'file', entry.file.path);
  }
}

// `x`: asymmetric by design (brief) -- checking advances to the next change
// point, unchecking stays put, because unchecking means "wait, I need to
// look at this again" and jumping away at that moment is exactly wrong.
async function handleToggleCurrentChecked() {
  const key = appState.currentKey;
  if (!key) return;
  const entry = dom.changePoints.get(key);
  if (!entry) return;
  const wasChecked = entry.changePoint.checked;
  await onToggleCheck(key, !wasChecked);
  // Read the post-request state rather than assuming the toggle succeeded --
  // onToggleCheck leaves changePoint.checked untouched on a failed request
  // (see its catch block), so a failed check naturally does not advance.
  if (!wasChecked && entry.changePoint.checked) {
    moveSelection(1);
  }
}

function handleOpenCommentForCurrent() {
  const key = appState.currentKey;
  if (!key) return;
  const entry = dom.changePoints.get(key);
  if (!entry) return;
  enterCommentEdit(entry);
}

// `u`: cyclic search starting just after the current change point, so a
// change point the user unchecked earlier ("wait, I need to look again") is
// still reachable even after scrolling past it -- not just a forward-only
// scan from the top. Gives explicit feedback (a toast) when nothing is
// unread, per the brief -- silently doing nothing on `u` would look broken.
function jumpToNextUnread() {
  const order = appState.order;
  if (order.length === 0) return;
  const currentIdx = appState.currentKey ? order.indexOf(appState.currentKey) : -1;
  for (let step = 1; step <= order.length; step++) {
    const key = order[(currentIdx + step) % order.length];
    const entry = dom.changePoints.get(key);
    if (entry && !entry.changePoint.checked) {
      selectChangePoint(key, { scroll: true });
      return;
    }
  }
  showToast('All caught up — nothing unread left.');
}

function handleGlobalKeydown(e) {
  // The overlay owns Escape unconditionally while it is open. This branch
  // can't fire from inside the comment textarea itself -- that field's own
  // keydown handler calls stopPropagation for every key (see
  // enterCommentEdit) -- so it is safe to check before the isEditing guard
  // below without reopening the "typing leaks into shortcuts" hole.
  if (shortcutOverlayOpen) {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeShortcutOverlay();
    }
    return;
  }

  // Two independent guards, per brief: appState.isEditing covers the whole
  // lifetime of an open comment textarea; the target check covers focus
  // being in *any* input/textarea/contenteditable even if isEditing were
  // somehow stale. Either one alone is enough to bail out -- see brief's
  // "正在編輯 comment 時... 焦點在任何 input/textarea/contenteditable 內時也
  // 一律不觸發".
  if (appState.isEditing) return;
  if (isTypingTarget(e.target)) return;
  // Leave modified key combos (Cmd/Ctrl/Alt+letter) to the browser/OS --
  // these are single, unmodified keys only.
  if (e.metaKey || e.ctrlKey || e.altKey) return;

  switch (e.key) {
    case 'j':
      e.preventDefault();
      moveSelection(1);
      break;
    case 'k':
      e.preventDefault();
      moveSelection(-1);
      break;
    case 'x':
      e.preventDefault();
      handleToggleCurrentChecked();
      break;
    case 'u':
      e.preventDefault();
      jumpToNextUnread();
      break;
    case 'c':
      e.preventDefault();
      handleOpenCommentForCurrent();
      break;
    case 'f':
      e.preventDefault();
      handleToggleCurrentFold();
      break;
    case 'b':
      e.preventDefault();
      toggleSidebar();
      break;
    case '1':
      e.preventDefault();
      setViewMode('unified');
      break;
    case '2':
      e.preventDefault();
      setViewMode('side-by-side');
      break;
    case '?':
      e.preventDefault();
      openShortcutOverlay();
      break;
    default:
      // Deliberately no case for ' ' (space) -- see block comment above.
      break;
  }
}

document.addEventListener('keydown', handleGlobalKeydown);

// ---------------------------------------------------------------------------
// Transient toast -- feedback for shortcuts with no visible change to show
// (currently only `u` with nothing unread left). Note-colored, matching
// .hint's semantics (attention, not error/destructive).
// ---------------------------------------------------------------------------

let toastEl = null;
let toastTimeoutId = null;

function ensureToastEl() {
  if (toastEl) return toastEl;
  toastEl = createEl('div', { className: 'shortcut-toast' });
  toastEl.setAttribute('role', 'status');
  toastEl.setAttribute('aria-live', 'polite');
  appEl.appendChild(toastEl);
  return toastEl;
}

function showToast(message) {
  const el = ensureToastEl();
  el.textContent = message;
  el.classList.remove('visible');
  void el.offsetWidth; // restart the transition if a toast is already showing
  el.classList.add('visible');
  if (toastTimeoutId) clearTimeout(toastTimeoutId);
  toastTimeoutId = setTimeout(() => el.classList.remove('visible'), 1800);
}

// ---------------------------------------------------------------------------
// Shortcut overlay -- the "?" table. Built lazily (same pattern as the
// clipboard fallback above) and reused across opens/closes rather than
// rebuilt each time.
// ---------------------------------------------------------------------------

const SHORTCUT_TABLE = [
  ['j / k', 'next / previous change point'],
  ['x', 'mark reviewed — checking advances, unchecking stays'],
  ['u', 'jump to next unread change point'],
  ['c', 'edit comment on the current change point'],
  ['f', 'collapse / expand the current function'],
  ['b', 'collapse / expand the whole sidebar'],
  ['1 / 2', 'unified / side-by-side view'],
  ['?', 'toggle this help'],
  ['space', 'browser scroll — not intercepted'],
];

let shortcutOverlayEl = null;
let shortcutOverlayOpen = false;
let lastFocusedBeforeOverlay = null;

function ensureShortcutOverlayEl() {
  if (shortcutOverlayEl) return shortcutOverlayEl;

  const backdrop = createEl('div', { className: 'shortcut-overlay-backdrop' });
  backdrop.hidden = true;
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) closeShortcutOverlay();
  });

  const dialog = createEl('div', { className: 'shortcut-overlay' });
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-label', 'Keyboard shortcuts');

  const header = createEl('div', { className: 'shortcut-overlay-header' });
  header.appendChild(createEl('h2', { className: 'shortcut-overlay-heading', text: 'Keyboard shortcuts' }));
  const closeBtn = createEl('button', { className: 'shortcut-overlay-close', text: '×' });
  closeBtn.type = 'button';
  closeBtn.setAttribute('aria-label', 'close');
  closeBtn.addEventListener('click', () => closeShortcutOverlay());
  header.appendChild(closeBtn);
  dialog.appendChild(header);

  const list = createEl('dl', { className: 'shortcut-overlay-list' });
  for (const [key, desc] of SHORTCUT_TABLE) {
    list.appendChild(createEl('dt', { text: key }));
    list.appendChild(createEl('dd', { text: desc }));
  }
  dialog.appendChild(list);

  backdrop.appendChild(dialog);
  appEl.appendChild(backdrop);

  shortcutOverlayEl = backdrop;
  shortcutOverlayEl._closeBtn = closeBtn;
  return backdrop;
}

function openShortcutOverlay() {
  const el = ensureShortcutOverlayEl();
  lastFocusedBeforeOverlay = document.activeElement;
  el.hidden = false;
  shortcutOverlayOpen = true;
  el._closeBtn.focus();
}

function closeShortcutOverlay() {
  if (shortcutOverlayEl) shortcutOverlayEl.hidden = true;
  shortcutOverlayOpen = false;
  if (lastFocusedBeforeOverlay && typeof lastFocusedBeforeOverlay.focus === 'function') {
    lastFocusedBeforeOverlay.focus();
  }
  lastFocusedBeforeOverlay = null;
}

// The footer's "?" hint (public/index.html) ships as inert markup -- this
// upgrades it into the real, always-available entry point the brief asks
// for ("這個按鈕不是裝飾，是主要入口") without touching index.html: same
// element position, same class (style.css's `#shortcut-bar .shortcut-help`
// rule still applies unchanged), just swapped from a <span> to a real
// <button> so it is keyboard-focusable and clickable for free.
const shortcutHelpSourceEl = document.querySelector('#shortcut-bar .shortcut-help');
if (shortcutHelpSourceEl) {
  const shortcutHelpBtn = createEl('button', {
    className: 'shortcut-help',
    text: shortcutHelpSourceEl.textContent,
  });
  shortcutHelpBtn.type = 'button';
  shortcutHelpBtn.setAttribute('aria-label', 'keyboard shortcuts');
  shortcutHelpBtn.addEventListener('click', () => openShortcutOverlay());
  shortcutHelpSourceEl.replaceWith(shortcutHelpBtn);
}

// ===========================================================================
// Init
// ===========================================================================

async function init() {
  restoreSavedSelection();
  setViewMode(appState.viewMode);
  setSidebarCollapsed(localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1');
  await loadRepos();

  if (appState.repos.length === 0) {
    showEmptyState();
    return;
  }
  if (!appState.repo || !appState.repos.some((r) => r.id === appState.repo)) {
    appState.repo = appState.repos[0].id;
  }
  repoSelectEl.value = appState.repo;

  await loadRefsForRepo();
}

init();
