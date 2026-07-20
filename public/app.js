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
};

// DOM index rebuilt every time the tree is (re)rendered. Not part of
// appState because it holds live element references, not serializable
// application state.
const dom = {
  changePoints: new Map(), // key -> { changePoint, group, file, groupKey, leftRow, leftCheckbox, rightContainer, rightCheckbox }
  groups: new Map(),       // groupKey -> { group, badgeEl, toggleBtn, childUl }
  files: new Map(),        // path -> { file, badgeEl, toggleBtn, childUl }
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
// Top bar: repo picker + add-repo form
// ===========================================================================

function populateRepoSelect() {
  repoSelectEl.textContent = '';
  for (const repo of appState.repos) {
    const opt = createEl('option', { text: `${repo.name} (${repo.path})` });
    opt.value = repo.id;
    repoSelectEl.appendChild(opt);
  }
  if (appState.repo) repoSelectEl.value = appState.repo;
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

  treeRootEl.textContent = '';
  changepointsRootEl.textContent = '';

  for (const file of appState.tree.files) {
    renderFileNode(file);
  }

  updateStatsDom();
  setupScrollSpy();
}

function renderFileNode(file) {
  const li = createEl('li', { className: 'tree-file' });
  const row = createEl('div', { className: 'tree-row tree-file-row' });

  const collapseId = `file:${file.path}`;
  const collapsed = appState.collapsed.has(collapseId);

  const toggleBtn = createEl('button', { className: 'toggle-btn', text: collapsed ? '▸' : '▾' });
  toggleBtn.type = 'button';
  toggleBtn.addEventListener('click', () => toggleCollapse(collapseId, 'file', file.path));

  const label = createEl('span', { className: 'tree-label', text: file.path });
  const badge = createEl('span', { className: 'tree-badge', text: `${file.checked}/${file.total}` });
  if (file.allChecked) badge.classList.add('all-checked');

  row.append(toggleBtn, label, badge);
  li.appendChild(row);

  const childUl = createEl('ul', { className: 'tree-children' });
  childUl.hidden = collapsed;
  li.appendChild(childUl);

  dom.files.set(file.path, { file, badgeEl: badge, toggleBtn, childUl });
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

  const childUl = createEl('ul', { className: 'tree-children' });
  childUl.hidden = collapsed;
  li.appendChild(childUl);

  dom.groups.set(groupKey, { group, badgeEl: badge, toggleBtn, childUl });
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

    // '+' run with no immediately preceding '-' run (e.g. a pure addition).
    const adds = [];
    while (i < lines.length && lines[i].type === '+') {
      adds.push(lines[i]);
      i++;
    }
    for (const add of adds) rows.push({ left: null, right: add });
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

function updateGroupDom(groupKey) {
  if (!groupKey) return;
  const entry = dom.groups.get(groupKey);
  if (!entry) return;
  entry.badgeEl.textContent = `${entry.group.checked}/${entry.group.total}`;
  entry.badgeEl.classList.toggle('all-checked', entry.group.allChecked);
}

function updateFileDom(path) {
  const entry = dom.files.get(path);
  if (!entry) return;
  entry.badgeEl.textContent = `${entry.file.checked}/${entry.file.total}`;
  entry.badgeEl.classList.toggle('all-checked', entry.file.allChecked);
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
    entry.rightContainer.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }
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

function setupScrollSpy() {
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

function handleIntersections(entries) {
  const visible = entries.filter((e) => e.isIntersecting);
  if (visible.length === 0) return;
  visible.sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
  const key = visible[0].target.dataset.key;
  if (key) selectChangePoint(key, { scroll: false });
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
// Init
// ===========================================================================

async function init() {
  restoreSavedSelection();
  setViewMode(appState.viewMode);
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
