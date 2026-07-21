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

sidebarToggleBtnEl.addEventListener('click', toggleSidebar);
