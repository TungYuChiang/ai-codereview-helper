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
  addRepoCancelEl, addRepoErrorEl, basePickerEl, targetPickerEl, workingTreeHintEl,
  viewUnifiedBtnEl, viewSideBySideBtnEl, codeThemeSelectEl, dom } from './state.js';
import { createCombobox } from './combobox.js';
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
// Top bar: base / target ref pickers.
//
// Both are type-to-filter comboboxes (combobox.js), not native <select>s.
// The <select> version listed branches in `git branch --list` order --
// alphabetical -- which on the target repo (35+ `fix/<issue-number>`
// branches) put the numerically-lowest, i.e. oldest and least relevant,
// branch first and buried the one created today. Refs now arrive from
// /api/refs already sorted newest-first with a commit date attached, and
// this file turns that into the picker's item list.
//
// Three things the item list encodes beyond "a name":
//
//   1. A relative date per ref ("3 天前"), so recency ordering is legible
//      rather than just asserted.
//   2. Merged branches pushed below the rest and de-emphasized, under a
//      heading that says what that MEANS. This is not "the branch is
//      stale" decoration: the tool diffs `base...target` (three-dot), so a
//      target already merged into base produces an EMPTY diff. The marking
//      exists to tell the user that picking that entry will show them
//      nothing.
//   3. The Working Tree sentinel, which is not a ref at all (see getDiff in
//      git.js) and therefore has no date and no merged-ness.
//
// Merged marking is applied to the TARGET picker only. Merged-ness is
// defined relative to the base, so "is this branch merged into base?" asked
// about a candidate *base* would be a different and much less useful
// question; the empty-diff consequence the marking warns about is purely a
// property of the target.
// ===========================================================================

export const baseCombo = createCombobox({ id: 'base-select', label: 'base ref', placeholder: 'base' });
export const targetCombo = createCombobox({ id: 'target-select', label: 'target ref', placeholder: 'target' });
basePickerEl.appendChild(baseCombo.rootEl);
targetPickerEl.appendChild(targetCombo.rootEl);

// The last ref list and merged set handed to us, kept so that a base change
// can re-mark the target picker without refetching the refs themselves.
let currentRefs = { branches: [], tags: [], current: '' };
let mergedBranches = new Set();

// The Working Tree entry. Not a ref: `getDiff` special-cases this value into
// `git diff <base>` (see git.js), so it has no commit date to sort by and no
// merged-ness. It is pinned to the top of the target picker rather than
// being sorted among the dated refs -- but it does participate in text
// filtering like every other entry, which is what makes typing an issue
// number narrow the list to exactly one row.
const WORKING_TREE_ITEM = {
  value: 'WORKING_TREE',
  label: 'Working Tree',
  meta: '未 commit 的改動',
  title: 'Working Tree — diff 會隨你編輯而變',
};

// ---------------------------------------------------------------------------
// Relative dates. Intl.RelativeTimeFormat is built into the browser, so this
// costs no dependency. `numeric: 'always'` on purpose: 'auto' would render
// -1 day as 「昨天」 and -2 days as 「前天」 while everything else stayed
// 「N 天前」, and a column of dates that changes shape at the top is harder
// to scan than one that does not.
//
// zh-TW to match the top bar's existing language (「複製 Comment」,
// 「Working Tree: diff 會隨你編輯而變」) -- Chinese prose around English
// proper nouns, rather than a third style invented here.
// ---------------------------------------------------------------------------

const relativeTimeFormat = new Intl.RelativeTimeFormat('zh-TW', { numeric: 'always' });

const RELATIVE_UNITS = [
  ['year', 365 * 24 * 60 * 60 * 1000],
  ['month', 30 * 24 * 60 * 60 * 1000],
  ['day', 24 * 60 * 60 * 1000],
  ['hour', 60 * 60 * 1000],
  ['minute', 60 * 1000],
];

export function formatRelativeDate(isoDate, now = Date.now()) {
  if (!isoDate) return '';
  const then = Date.parse(isoDate);
  if (Number.isNaN(then)) return '';
  const elapsed = now - then;
  // A clock-skewed or future-dated commit would otherwise read as
  // 「-3 天前」; clamp to "just now" rather than showing nonsense.
  if (elapsed < 60 * 1000) return relativeTimeFormat.format(0, 'minute');
  for (const [unit, ms] of RELATIVE_UNITS) {
    if (elapsed >= ms) return relativeTimeFormat.format(-Math.floor(elapsed / ms), unit);
  }
  return relativeTimeFormat.format(0, 'minute');
}

// ---------------------------------------------------------------------------
// Item-list construction (pure, given refs + merged set)
// ---------------------------------------------------------------------------

function refItem(ref, { merged = false } = {}) {
  const when = formatRelativeDate(ref.date);
  return {
    value: ref.name,
    label: ref.name,
    meta: when,
    badge: merged ? '已合併 · diff 會是空的' : '',
    dimmed: merged,
    title: when ? `${ref.name} — ${when}` : ref.name,
  };
}

export function buildRefItems(refs, { includeWorkingTree, merged, baseName }) {
  const items = [];
  if (includeWorkingTree) items.push(WORKING_TREE_ITEM);

  const mergedSet = merged || new Set();
  const unmergedBranches = [];
  const mergedBranchRefs = [];
  for (const branch of refs.branches) {
    // The base itself is trivially "merged into" the base; listing it under
    // the empty-diff warning would be true but useless noise, so it stays
    // with the ordinary branches.
    if (mergedSet.has(branch.name) && branch.name !== baseName) mergedBranchRefs.push(branch);
    else unmergedBranches.push(branch);
  }

  for (const branch of unmergedBranches) items.push(refItem(branch));

  if (mergedBranchRefs.length > 0) {
    items.push({
      separator: true,
      label: baseName
        ? `已合併進 ${baseName} — 選了 diff 會是空的`
        : '已合併 — 選了 diff 會是空的',
    });
    for (const branch of mergedBranchRefs) items.push(refItem(branch, { merged: true }));
  }

  if (refs.tags.length > 0) {
    items.push({ separator: true, label: 'Tags' });
    for (const tag of refs.tags) items.push(refItem(tag));
  }

  return items;
}

/** Called once per repo load, with /api/refs's response. */
export function populateBaseTargetSelects(refs) {
  currentRefs = refs;
  refreshRefItems();
}

/**
 * Called whenever the base changes (and once after the initial base is
 * resolved) with the branch names /api/merged reported for that base.
 *
 * Refetching per base change, rather than precomputing merged-ness for every
 * (ref, base) pair up front, is the deliberate trade: one extra git call per
 * base change is cheap and bounded, whereas precomputing is O(refs^2) git
 * work to answer a question about the one base actually selected -- and the
 * alternative of not refetching at all would leave the marks describing the
 * PREVIOUS base, i.e. actively lying about which targets produce an empty
 * diff. See loadMergedForBase in load.js for the call site.
 */
export function setMergedBranches(names) {
  mergedBranches = new Set(names || []);
  refreshRefItems();
}

function refreshRefItems() {
  baseCombo.setItems(
    buildRefItems(currentRefs, { includeWorkingTree: false, merged: null, baseName: null }),
  );
  targetCombo.setItems(
    buildRefItems(currentRefs, {
      includeWorkingTree: true,
      merged: mergedBranches,
      baseName: appState.base,
    }),
  );
  updateRefSelectTitles();
}

// Branch/tag names are user-controlled and can be long (ticket-prefixed
// branches especially) -- capped by .combobox-input's max-width in
// style.css, same treatment as #repo-select. The input itself carries the
// full name as a title so the truncated control still reveals it on hover,
// matching updateRepoSelectTitle() above.
export function updateRefSelectTitles() {
  baseCombo.inputEl.title = baseCombo.getValue() ?? '';
  targetCombo.inputEl.title = targetCombo.getValue() === 'WORKING_TREE'
    ? 'Working Tree'
    : (targetCombo.getValue() ?? '');
}

export function pickDefaultBase(branches) {
  const names = branches.map((b) => b.name);
  for (const candidate of ['main', 'master', 'dev', 'develop']) {
    if (names.includes(candidate)) return candidate;
  }
  return names[0] ?? null;
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
