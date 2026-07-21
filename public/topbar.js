// topbar.js -- top bar controls: repo picker + add-repo form, base/target
// ref pickers, view-mode toggle, code color theme. Split out of app.js as a
// pure move (see state.js's header comment).
//
// Deviation from the brief's suggested split: the repo/base/target 'change'
// listeners and the add-repo form's 'submit' listener are NOT here -- they
// live in load.js instead. Those handlers need to kick off the load
// pipeline (loadRefsForRepo/loadDiff), and load.js already needs to call
// back into this file's populate/update functions once refs/repos come
// back. Keeping the listeners here too would make topbar.js and load.js
// import each other -- exactly the cycle the brief warns is a sign of a
// wrong seam. This file now only ever reads from state.js/prefs.js/diff.js;
// nothing here imports load.js, so the dependency runs one way.

import { appState, createEl, repoSelectEl, addRepoToggleEl, addRepoFormEl, addRepoInputEl,
  addRepoCancelEl, addRepoErrorEl, baseSelectEl, targetSelectEl, workingTreeHintEl,
  viewUnifiedBtnEl, viewSideBySideBtnEl, codeThemeSelectEl, dom } from './state.js';
import { saveSelection } from './prefs.js';
import { renderChangePointContent } from './diff.js';

// ===========================================================================
// Top bar: repo picker + add-repo form
// ===========================================================================

export function populateRepoSelect() {
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
export function updateRepoSelectTitle() {
  const repo = appState.repos.find((r) => r.id === appState.repo);
  repoSelectEl.title = repo ? repo.path : '';
}

export function dedupeRepos(repos) {
  const seen = new Set();
  const out = [];
  for (const r of repos) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    out.push(r);
  }
  return out;
}

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

// ===========================================================================
// Top bar: base / target picker
// ===========================================================================

export function populateBaseTargetSelects(refs) {
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

  updateRefSelectTitles();
}

// Branch/tag names are user-controlled and can be long (ticket-prefixed
// branches especially) -- capped by #base-select/#target-select's max-width
// in style.css, same treatment as #repo-select. The <select> itself carries
// the full name as a title so the closed, ellipsis-truncated control still
// reveals it on hover, matching updateRepoSelectTitle() above.
export function updateRefSelectTitles() {
  baseSelectEl.title = baseSelectEl.value;
  targetSelectEl.title = targetSelectEl.value === 'WORKING_TREE'
    ? 'Working Tree'
    : targetSelectEl.value;
}

export function pickDefaultBase(branches) {
  for (const candidate of ['main', 'master', 'dev', 'develop']) {
    if (branches.includes(candidate)) return candidate;
  }
  return branches[0] ?? null;
}

export function updateWorkingTreeHint() {
  workingTreeHintEl.hidden = appState.target !== 'WORKING_TREE';
}

// ===========================================================================
// Top bar: view mode toggle (unified / side-by-side). This unit only wires
// up the control and the state field -- actual diff re-rendering per mode
// belongs to the diff-rendering unit (EXTENSION POINT 1 in diff.js).
// ===========================================================================

export function setViewMode(mode) {
  appState.viewMode = mode;
  viewUnifiedBtnEl.classList.toggle('active', mode === 'unified');
  viewSideBySideBtnEl.classList.toggle('active', mode === 'side-by-side');
  viewUnifiedBtnEl.setAttribute('aria-pressed', String(mode === 'unified'));
  viewSideBySideBtnEl.setAttribute('aria-pressed', String(mode === 'side-by-side'));
  saveSelection();
  // Re-render each change point's content in place -- deliberately not a
  // tree rebuild and not a refetch, so the main pane's scroll position
  // (and the tree/scroll-spy state) is untouched. See EXTENSION POINT 1.
  // appState.viewMode itself is global (read fresh by pane.js's
  // renderChangePointPane whenever a file is later opened/reopened), so
  // only the change points that currently have rendered content -- i.e.
  // belong to whichever file is open right now (single-file-view unit) --
  // need re-rendering here.
  for (const entry of dom.changePoints.values()) {
    if (entry.contentEl) renderChangePointContent(entry);
  }
}

viewUnifiedBtnEl.addEventListener('click', () => setViewMode('unified'));
viewSideBySideBtnEl.addEventListener('click', () => setViewMode('side-by-side'));

// ===========================================================================
// Top bar: code-area color theme (ui-code-themes unit).
//
// Deliberately the cheapest possible "switch" in this file: a theme is
// nothing but a set of CSS custom properties scoped to
// :root[data-code-theme="..."] (see style.css). Applying one is one
// attribute write -- no re-render, no DOM rebuild, no refetch, so scroll
// position, tree-scroll-spy state, and checked/current change-point state
// are untouched by construction, not by care taken here. Contrast with
// setViewMode() above, which *does* need to rebuild each change point's
// content because unified vs. side-by-side is a structural layout change,
// not a color change.
// ===========================================================================

const CODE_THEMES = [
  'default', 'github-dark', 'one-dark', 'dracula', 'monokai', 'nord',
  'github-light', 'solarized-light',
];
export const CODE_THEME_KEY = 'lcr.codeTheme';

export function setCodeTheme(theme) {
  const value = CODE_THEMES.includes(theme) ? theme : 'default';
  appState.codeTheme = value;
  document.documentElement.setAttribute('data-code-theme', value);
  codeThemeSelectEl.value = value;
  localStorage.setItem(CODE_THEME_KEY, value);
}

codeThemeSelectEl.addEventListener('change', () => setCodeTheme(codeThemeSelectEl.value));
