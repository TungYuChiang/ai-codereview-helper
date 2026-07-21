// prefs.js -- localStorage persistence (repo/base/target/view mode) and
// sidebar collapse. Split out of app.js as a pure move (see state.js's
// header comment).

import { appState, sidebarToggleBtnEl, bodyEl } from './state.js';

// ===========================================================================
// localStorage persistence -- repo / base / target / view mode
// ===========================================================================

export const LS_KEYS = {
  repo: 'lcr.repo',
  base: 'lcr.base',
  target: 'lcr.target',
  viewMode: 'lcr.viewMode',
  currentFile: 'lcr.currentFile',
};

export function restoreSavedSelection() {
  appState.repo = localStorage.getItem(LS_KEYS.repo) || null;
  appState.base = localStorage.getItem(LS_KEYS.base) || null;
  appState.target = localStorage.getItem(LS_KEYS.target) || null;
  appState.viewMode = localStorage.getItem(LS_KEYS.viewMode) || 'unified';
  appState.currentFile = localStorage.getItem(LS_KEYS.currentFile) || null;
}

export function saveSelection() {
  setOrRemove(LS_KEYS.repo, appState.repo);
  setOrRemove(LS_KEYS.base, appState.base);
  setOrRemove(LS_KEYS.target, appState.target);
  localStorage.setItem(LS_KEYS.viewMode, appState.viewMode);
}

export function setOrRemove(key, value) {
  if (value) localStorage.setItem(key, value);
  else localStorage.removeItem(key);
}

// Persisted separately from saveSelection() above -- it fires far more
// often (every file switch) than repo/base/target/viewMode do, and belongs
// to a different lifecycle (restored/validated against the *current*
// diff's file list in tree.js's renderTree, not blindly reapplied like
// base/target are against refs in load.js).
export function persistCurrentFile() {
  setOrRemove(LS_KEYS.currentFile, appState.currentFile);
}

// ===========================================================================
// Sidebar collapse -- whole #tree-pane, toggled from the top-bar button, the
// `b` keyboard shortcut (see handleGlobalKeydown in keyboard.js), and
// restored from localStorage on init (see init() in app.js). Purely a class
// toggle + a couple of attribute/label updates -- no tree rebuild, no
// change to appState.collapsed (which is the per-node fold state and is
// untouched by this).
// ===========================================================================

export const SIDEBAR_COLLAPSED_KEY = 'lcr.sidebarCollapsed';

export function setSidebarCollapsed(collapsed) {
  appState.sidebarCollapsed = collapsed;
  bodyEl.classList.toggle('sidebar-collapsed', collapsed);
  sidebarToggleBtnEl.textContent = collapsed ? '▸' : '◂'; // ▸ / ◂
  sidebarToggleBtnEl.setAttribute('aria-expanded', String(!collapsed));
  sidebarToggleBtnEl.setAttribute('aria-label', collapsed ? 'show sidebar' : 'hide sidebar');
  sidebarToggleBtnEl.title = collapsed ? 'Show sidebar (b)' : 'Hide sidebar (b)';
  localStorage.setItem(SIDEBAR_COLLAPSED_KEY, collapsed ? '1' : '0');
}

export function toggleSidebar() {
  setSidebarCollapsed(!appState.sidebarCollapsed);
}

// ===========================================================================
// Annotation collapse -- per-comment / per-note "show only a summary line"
// state, rendered by comments.js's renderCommentView/renderNoteView.
//
// Two sets, deliberately not one:
//
//   `expanded`  -- the EFFECTIVE state the renderer reads.
//   `persisted` -- the subset of it that survives a reload.
//
// They differ for exactly one case, which is the whole point of the split:
// an annotation you just saved (or just opened the editor on) stays open for
// the rest of the session so you can confirm what was stored, but that is a
// transient consequence of writing it, NOT a preference -- persisting it
// would mean every comment you ever write comes back expanded forever, which
// is the density problem this feature exists to fix. Only an explicit header
// toggle writes to localStorage.
//
// Scoped per repo, because the ids are change-point keys and those are only
// meaningful within one repo's state file (see changePointKey in state.js).
// They are content hashes, not line numbers, so they survive amends and
// base/target switches -- which is why pruning (below) is keyed on "does this
// repo still have an annotation under this key at all", not on "is this
// change point in the diff currently on screen".
// ===========================================================================

export const ANNOTATION_EXPANDED_KEY_PREFIX = 'lcr.annotationExpanded.';

const expanded = new Set();
let persisted = new Set();

function annotationStorageKey() {
  return ANNOTATION_EXPANDED_KEY_PREFIX + (appState.repo || '_none');
}

function readPersisted() {
  let raw;
  try {
    raw = localStorage.getItem(annotationStorageKey());
  } catch {
    return new Set();
  }
  if (!raw) return new Set();
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((v) => typeof v === 'string'));
  } catch {
    // Hand-edited or truncated localStorage is not worth throwing over --
    // the worst case of dropping it is that everything renders collapsed,
    // which is the default anyway.
    return new Set();
  }
}

function writePersisted() {
  if (persisted.size === 0) localStorage.removeItem(annotationStorageKey());
  else localStorage.setItem(annotationStorageKey(), JSON.stringify([...persisted]));
}

// id = "<kind>:<changePointKey>" -- one change point can carry both a comment
// and a note, and they collapse independently.
export function annotationStateId(kind, key) {
  return `${kind}:${key}`;
}

export function isAnnotationExpanded(kind, key) {
  return expanded.has(annotationStateId(kind, key));
}

// `persist: false` records the session-only expansion described above.
export function setAnnotationExpanded(kind, key, isExpanded, { persist = true } = {}) {
  const id = annotationStateId(kind, key);
  if (isExpanded) expanded.add(id);
  else expanded.delete(id);
  if (!persist) return;
  if (isExpanded) persisted.add(id);
  else persisted.delete(id);
  writePersisted();
}

// Called when the annotation itself goes away (cleared-and-saved, or its
// orphan card discarded), so the common "I deleted it" path never leaves an
// entry behind even before the next prune runs.
export function forgetAnnotationExpanded(kind, key) {
  const id = annotationStateId(kind, key);
  expanded.delete(id);
  if (persisted.delete(id)) writePersisted();
}

// Called once per GET /api/diff (see loadDiff in load.js) with every id that
// still corresponds to a real stored annotation in this repo -- live change
// points plus orphans, which together are the union of everything in the
// repo's comments/notes maps (see buildAnnotated in the backend state.js).
// Anything else is unreachable and is dropped, so entries cannot pile up as
// code is edited away. Also reloads the effective set from storage, which is
// what makes switching repos pick up that repo's own state.
export function pruneAnnotationExpanded(liveIds) {
  persisted = readPersisted();
  let changed = false;
  for (const id of [...persisted]) {
    if (!liveIds.has(id)) {
      persisted.delete(id);
      changed = true;
    }
  }
  if (changed) writePersisted();
  expanded.clear();
  for (const id of persisted) expanded.add(id);
}

sidebarToggleBtnEl.addEventListener('click', toggleSidebar);
