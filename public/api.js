// api.js -- fetch wrapper + typed calls to the local-code-review server.
// Split out of app.js as a pure move (see state.js's header comment).

import { errorBannerEl } from './state.js';

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

export const api = {
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
  setComment: (repoId, key, text, context) =>
    apiFetch('/api/comment', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repo: repoId, key, text, context }),
    }),
  setNote: (repoId, key, text, context) =>
    apiFetch('/api/note', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repo: repoId, key, text, context }),
    }),
  discardOrphan: (repoId, key) =>
    apiFetch('/api/orphan/discard', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repo: repoId, key }),
    }),
  // ref must be the diff's *target* (appState.target: a real ref name or the
  // literal 'WORKING_TREE') -- that is the version newStart/newEnd/lines are
  // expressed in. Passing base here would silently show the wrong revision's
  // code, which the brief calls out as worse than showing nothing.
  getLines: (repoId, ref, path, start, end) =>
    apiFetch(
      `/api/lines?repo=${encodeURIComponent(repoId)}&ref=${encodeURIComponent(ref)}&path=${encodeURIComponent(path)}&start=${start}&end=${end}`,
    ),
  exportReview: (repoId, base, target, format) =>
    apiFetch(
      `/api/export?repo=${encodeURIComponent(repoId)}&base=${encodeURIComponent(base)}&target=${encodeURIComponent(target)}&format=${encodeURIComponent(format)}`,
    ).then((b) => b.text),
};

// ===========================================================================
// Error banner
// ===========================================================================

export function showError(message) {
  errorBannerEl.textContent = message;
  errorBannerEl.hidden = false;
}

export function clearError() {
  errorBannerEl.textContent = '';
  errorBannerEl.hidden = true;
}
