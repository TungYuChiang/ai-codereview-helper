// load.js -- the repos -> refs -> diff loading pipeline, plus the top-bar
// listeners that kick it off (repo/base/target change, add-repo submit).
// Split out of app.js as a pure move (see state.js's header comment; see
// topbar.js's header comment for why those particular listeners live here
// instead of alongside the rest of the top bar).

import { appState, repoSelectEl, baseSelectEl, targetSelectEl, addRepoFormEl,
  addRepoInputEl, addRepoErrorEl, treeRootEl, changepointsRootEl, filePaneHeaderEl } from './state.js';
import { api, clearError, showError } from './api.js';
import { saveSelection } from './prefs.js';
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
  renderTree();
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
