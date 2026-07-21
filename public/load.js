// load.js -- the repos -> refs -> diff loading pipeline, plus the top-bar
// listeners that kick it off (repo/base/target change, add-repo submit).
// Split out of app.js as a pure move (see state.js's header comment; see
// topbar.js's header comment for why those particular listeners live here
// instead of alongside the rest of the top bar).

import { appState, repoSelectEl, baseSelectEl, targetSelectEl, addRepoFormEl,
  addRepoInputEl, addRepoErrorEl, treeRootEl, changepointsRootEl, filePaneHeaderEl } from './state.js';
import { api, clearError, showError } from './api.js';
import { saveSelection, annotationStateId, pruneAnnotationExpanded } from './prefs.js';
import { populateRepoSelect, updateRepoSelectTitle, dedupeRepos, populateBaseTargetSelects,
  pickDefaultBase, updateRefSelectTitles, updateWorkingTreeHint } from './topbar.js';
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
  updateRefSelectTitles();
  updateWorkingTreeHint();
  saveSelection();

  await loadDiff();
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
  for (const orphan of tree.orphans || []) {
    if (orphan.text) ids.add(annotationStateId('comment', orphan.key));
    if (orphan.note) ids.add(annotationStateId('note', orphan.key));
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

baseSelectEl.addEventListener('change', async () => {
  appState.base = baseSelectEl.value;
  updateRefSelectTitles();
  saveSelection();
  await loadDiff();
});

targetSelectEl.addEventListener('change', async () => {
  appState.target = targetSelectEl.value;
  updateRefSelectTitles();
  updateWorkingTreeHint();
  saveSelection();
  await loadDiff();
});
