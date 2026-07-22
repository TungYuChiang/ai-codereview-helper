// load.js -- the repos -> refs -> diff loading pipeline, plus the top-bar
// listeners that kick it off (repo/base/target change, add-repo submit).
// Split out of app.js as a pure move (see state.js's header comment; see
// topbar.js's header comment for why those particular listeners live here
// instead of alongside the rest of the top bar).

import { appState, repoSelectEl, addRepoFormEl,
  addRepoInputEl, addRepoErrorEl, treeRootEl, changepointsRootEl, filePaneHeaderEl } from './state.js';
import { api, clearError, showError } from './api.js';
import { saveSelection, annotationStateId, pruneAnnotationExpanded,
  ORPHAN_CARD_KIND, ORPHAN_SECTION_KIND, ORPHAN_SECTION_KEY } from './prefs.js';
import { populateRepoSelect, updateRepoSelectTitle, dedupeRepos, populateBaseTargetSelects,
  pickDefaultBase, updateRefSelectTitles, updateWorkingTreeHint, setMergedBranches,
  baseCombo, targetCombo } from './topbar.js';
import { renderTree } from './tree.js';

// ===========================================================================
// Loading pipeline: repos -> refs -> diff
// ===========================================================================

export async function loadRepos() {
  try {
    appState.repos = await api.listRepos();
  } catch (err) {
    showError(err.message);
    appState.repos = [];
  }
  populateRepoSelect();
}

export async function loadRefsForRepo() {
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

  // Revalidation of the restored selection against the new repo's refs is
  // unchanged in behaviour -- only the shape is. /api/refs now returns
  // { name, date } objects instead of bare strings (git.js switched from
  // `branch --list` to a date-sorted `for-each-ref`), so the membership sets
  // are built from .name.
  const branchNames = refs.branches.map((b) => b.name);
  const validRefs = new Set([...branchNames, ...refs.tags.map((t) => t.name)]);
  if (!appState.base || !validRefs.has(appState.base)) {
    appState.base = pickDefaultBase(refs.branches);
  }

  const validTargets = new Set(['WORKING_TREE', ...validRefs]);
  if (!appState.target || !validTargets.has(appState.target)) {
    appState.target = branchNames.includes(refs.current) ? refs.current : 'WORKING_TREE';
  }

  baseCombo.setValue(appState.base);
  targetCombo.setValue(appState.target);
  updateRefSelectTitles();
  updateWorkingTreeHint();
  saveSelection();

  // Before the diff, not after: the merged marks say "this target will show
  // you an empty diff", and they are least useful arriving after the user
  // has already opened the picker. One cheap git call.
  await loadMergedForBase();

  await loadDiff();
}

/**
 * Refreshes which branches are marked as already merged into the current
 * base. Called on load and on every base change, because merged-ness is
 * relative to the base -- see setMergedBranches in topbar.js for why this is
 * a refetch rather than a precomputed table.
 *
 * Deliberately silent on failure: the marks are an advisory overlay on a
 * picker that works fine without them, so a failed /api/merged must not
 * raise the error banner over a diff that loaded correctly. It clears the
 * marks instead, which is the honest state -- better no marks than marks
 * describing the previous base.
 */
export async function loadMergedForBase() {
  if (!appState.repo || !appState.base) {
    setMergedBranches([]);
    return;
  }
  try {
    setMergedBranches(await api.getMerged(appState.repo, appState.base));
  } catch {
    setMergedBranches([]);
  }
}

export async function loadDiff() {
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
    filePaneHeaderEl.hidden = true;
    filePaneHeaderEl.textContent = '';
    return;
  }

  appState.tree = data;
  appState.currentKey = null;
  pruneAnnotationExpanded(collectAnnotationIds(data));
  renderTree();
}

// Every annotation id this repo can still show a collapse toggle for: the
// change points currently in the diff that actually carry a comment/note,
// plus the orphans (which are, by construction, exactly the stored
// annotations whose change point is NOT in this diff -- see buildAnnotated
// in the backend state.js). The union therefore covers the repo's whole
// comments/notes map, so pruning against it never discards state for an
// annotation the user can still reach by switching base/target back.
function collectAnnotationIds(tree) {
  const ids = new Set();
  for (const file of tree.files || []) {
    for (const group of file.groups || []) {
      for (const changePoint of group.changePoints || []) {
        if (changePoint.comment) ids.add(annotationStateId('comment', changePoint.id));
        if (changePoint.note) ids.add(annotationStateId('note', changePoint.id));
      }
    }
  }
  const orphans = tree.orphans || [];
  for (const orphan of orphans) {
    if (orphan.text) ids.add(annotationStateId('comment', orphan.key));
    if (orphan.note) ids.add(annotationStateId('note', orphan.key));
    // The card's own collapse state, which exists per orphan regardless of
    // which of the two annotations it carries.
    ids.add(annotationStateId(ORPHAN_CARD_KIND, orphan.key));
  }
  // The section's collapse state is not per-change-point, so it has nothing
  // to survive on its own -- it stays alive exactly as long as this repo has
  // a History comments section to open at all, and is dropped (back to the
  // collapsed default) once the last orphan is gone.
  if (orphans.length > 0) {
    ids.add(annotationStateId(ORPHAN_SECTION_KIND, ORPHAN_SECTION_KEY));
  }
  return ids;
}

// ===========================================================================
// Top-bar listeners that trigger this pipeline.
// ===========================================================================

repoSelectEl.addEventListener('change', async () => {
  appState.repo = repoSelectEl.value;
  updateRepoSelectTitle();
  saveSelection();
  await loadRefsForRepo();
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

// The comboboxes report a committed selection through onSelect rather than a
// DOM 'change' event; assigning the callbacks here (instead of inside
// topbar.js) keeps the same one-way dependency the header comment in
// topbar.js describes -- load.js knows about topbar.js, never the reverse.
baseCombo.onSelect = async (value) => {
  appState.base = value;
  updateRefSelectTitles();
  saveSelection();
  await loadMergedForBase();
  await loadDiff();
};

targetCombo.onSelect = async (value) => {
  appState.target = value;
  updateRefSelectTitles();
  updateWorkingTreeHint();
  saveSelection();
  await loadDiff();
};
