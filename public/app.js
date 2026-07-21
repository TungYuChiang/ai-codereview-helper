// app.js -- front end for local-code-review. Vanilla JS, no build step, no
// dependencies, browser-native ES modules. This file is now the assembly
// layer: it imports every other public/*.js module (each of which owns one
// slice of the UI and self-registers its own DOM event listeners as a side
// effect of being loaded, exactly as this file did before the split) and
// runs init() once everything is wired up.
//
// This used to be a single ~2300-line file. It was split into modules --
// state.js, api.js, prefs.js, topbar.js, load.js, tree.js, pane.js, diff.js,
// nav.js, comments.js, export.js, keyboard.js -- so that unrelated UI
// changes land in different files instead of all queuing on this one. See
// .superpowers/sdd/task-frontend-modules-brief.md and -report.md for the
// full rationale and the module boundaries chosen (a few deviate from that
// brief's suggested table -- the report explains why, mainly to avoid
// import cycles and to keep two concrete hypothetical future changes,
// sidebar-row work and right-pane work, from landing in the same file).
//
// Hard rule carried over unchanged from the original app.js header: file
// paths and diff content come from the reviewed repo and may contain
// anything, including HTML-looking text. Never use innerHTML for that
// content -- always textContent / createElement. See state.js's createEl(),
// used everywhere a string reaches the DOM.

import { appState, repoSelectEl, changepointsRootEl, createEl } from './state.js';
import { setCodeTheme, CODE_THEME_KEY, setViewMode } from './topbar.js';
import { restoreSavedSelection, setSidebarCollapsed, SIDEBAR_COLLAPSED_KEY } from './prefs.js';
import { loadRepos, loadRefsForRepo } from './load.js';

// Side-effect-only imports: these modules have no exports app.js needs
// directly, but their top-level code registers event listeners (export
// buttons, the document-level keydown handler) that must run once at
// startup, same as every other module here.
import './export.js';
import './keyboard.js';

// ===========================================================================
// Empty state -- first run, no repos configured yet. Points at the
// add-repo form that already lives in the top bar (see topbar.js's
// addRepoToggleEl wiring) instead of duplicating that UI here.
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
  setCodeTheme(localStorage.getItem(CODE_THEME_KEY) || 'default');
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
