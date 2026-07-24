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
  commitGroupEl, commitPickerEl, commitBackBtnEl, commitHintEl,
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
// Top bar: commit picker -- "review one commit at a time".
//
// The top bar's `base … target` produces one squashed diff for the whole
// branch, in which a line touched by two different commits appears once, as
// its net effect. This picker narrows that to a single commit without
// introducing a second kind of diff: selecting a commit just points the same
// /api/diff at `<its first parent>...<it>` (see effectiveRange in state.js).
//
// Reuses combobox.js rather than being a new widget -- see the block comment
// there for why (it is the keyboard/ARIA/isEditing machinery that is hard,
// and this needs all of it). Deviations from the ref pickers, all argued:
//
//   - The first entry is the way BACK ("整條 branch"), pinned above the
//     commits exactly the way Working Tree is pinned above the refs in the
//     target picker. It is not the only way back -- there is also an explicit
//     button next to the picker -- because "the escape hatch is an item
//     inside the thing you are trying to escape" is a poor sole affordance.
//   - Merge commits are LISTED and badged, not hidden. A merge can carry real
//     conflict-resolution work, and a list that silently disagrees with
//     `git log` is worse than one that explains itself. The badge says what
//     the diff will actually be (`<sha>^` is the FIRST parent, so a merge
//     shows what it brought in from the other side -- which overlaps the
//     individual commits also listed, and the user should know that).
//   - A root commit is badged too: its diff is against git's empty tree, i.e.
//     the whole file contents as additions, because it has no parent.
//
// Every string here reaches the DOM through combobox.js's createEl, i.e.
// textContent. Commit subjects and author names come from the repo and can
// contain anything, including HTML-looking text.
// ===========================================================================

export const commitCombo = createCombobox({
  id: 'commit-select',
  label: 'commit',
  placeholder: '整條 branch',
  emptyText: '沒有符合的 commit',
  // Wider than the ref pickers' 160px: a row's committed label is
  // "<shortSha> <subject>", and 160px shows barely more than the sha.
  maxWidth: 300,
});
commitPickerEl.appendChild(commitCombo.rootEl);

// The sentinel for "no commit selected". Not `null`: the combobox's value is
// what the input displays, and the whole-branch state has to be a real,
// selectable row so it can be committed with Enter like any other.
export const WHOLE_BRANCH = 'WHOLE_BRANCH';

const WHOLE_BRANCH_ITEM = {
  value: WHOLE_BRANCH,
  label: '整條 branch',
  meta: '全部 commit 合成一份 diff',
  title: '整條 branch — base...target 的完整 diff',
};

// The last commit list handed to us, so a selection can be resolved back to
// its full record (which carries the `base` the diff needs) by sha alone.
let currentCommits = [];

// A one-shot explanation shown in place of the per-commit hint. Currently only
// used for "the commit you had selected is gone", which is the rebase case.
let commitNotice = '';

// Kept to one short line, the same length as the Working Tree hint beside it:
// the top bar is at its width budget and a paragraph here wraps it onto a
// third row. The full reasoning is on the title, one hover away.
const COMMIT_VIEW_HINT = '單一 commit：勾選進度和整條 branch 分開算，切回去就回來了';
const COMMIT_VIEW_HINT_TITLE =
  '變更點的識別碼是 diff 內容的雜湊。同一段程式碼在單一 commit 裡的 diff 文字，'
  + '和整條 branch 合起來看時不一樣（只要那幾行被改過不只一次），所以兩邊的勾是分開的。'
  + '這是正確行為，不是進度不見了 —— 切回整條 branch，原本的進度就在。';

function commitItem(commit) {
  const when = formatRelativeDate(commit.date);
  const badge = commit.isMerge
    ? 'merge · diff 只比第一個 parent'
    : (commit.isRoot ? '第一個 commit · 整份檔案都是新增' : '');
  return {
    value: commit.sha,
    label: `${commit.shortSha} ${commit.subject}`,
    meta: when ? `${commit.author} · ${when}` : commit.author,
    badge,
    // Findable by author too, without the author crowding the visible label.
    search: `${commit.shortSha} ${commit.subject} ${commit.author}`,
    title: `${commit.shortSha}  ${commit.subject}\n${commit.author} · ${commit.date}`,
  };
}

export function buildCommitItems(commits) {
  const items = [WHOLE_BRANCH_ITEM];
  if (commits.length === 0) return items;
  items.push({ separator: true, label: `這條 branch 的 ${commits.length} 個 commit` });
  for (const commit of commits) items.push(commitItem(commit));
  return items;
}

/** Called once per branch-range change, with GET /api/commits's response. */
export function setCommits(commits) {
  currentCommits = commits;
  commitCombo.setItems(buildCommitItems(commits));
  updateCommitPickerVisibility();
}

/** Resolves a sha back to the full record, or null if it is not in the list. */
export function findCommit(sha) {
  return currentCommits.find((c) => c.sha === sha) ?? null;
}

/**
 * Applies a commit selection (or `null` for the whole branch) to appState and
 * the top bar. Deliberately does NOT reload the diff -- load.js owns the
 * pipeline, the same one-way dependency the ref comboboxes already follow.
 */
export function setCommitSelection(commit) {
  appState.commit = commit;
  commitCombo.setValue(commit ? commit.sha : WHOLE_BRANCH);
  commitCombo.inputEl.title = commit
    ? `${commit.shortSha} ${commit.subject}`
    : '整條 branch';
  commitBackBtnEl.hidden = commit === null;
  updateCommitHint();
}

export function setCommitNotice(text) {
  commitNotice = text;
  updateCommitHint();
}

// The progress note. Change-point keys are content hashes of
// (filePath, functionName, diffText, ordinal) -- see changePointKey in the
// backend state.js -- so a change point in a single commit's diff and "the
// same" change in the squashed branch diff are only the same key when the
// diff TEXT is identical, which stops being true the moment a line is touched
// by more than one commit. That is correct behaviour, but a user sitting on
// 66/67 who switches views and sees unread items will read it as lost
// progress, so it is stated up front. Same slot, same styling and same
// purpose as the Working Tree hint next to it: naming a consequence of the
// current mode before it looks like a bug.
function updateCommitHint() {
  if (appState.commit) {
    commitHintEl.textContent = COMMIT_VIEW_HINT;
    commitHintEl.title = COMMIT_VIEW_HINT_TITLE;
    commitHintEl.hidden = false;
    return;
  }
  commitHintEl.textContent = commitNotice;
  commitHintEl.title = commitNotice;
  commitHintEl.hidden = commitNotice === '';
}

// The picker is hidden when it has nothing to offer beyond the entry that
// means "what you are already looking at": a WORKING_TREE target (which is not
// a commit, so there is no list) or a branch with nothing ahead of base. The
// top bar is already at its width budget -- see the combobox width note in
// style.css -- so a control that can only be a no-op does not earn a slot.
function updateCommitPickerVisibility() {
  commitGroupEl.hidden = currentCommits.length === 0;
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
