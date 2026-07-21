// nav.js -- checking a change point, moving the current selection, and
// scroll-spy (right-pane scroll -> left tree highlight). Split out of
// app.js as a pure move (see state.js's header comment).

import { appState, dom, mainPaneEl, statsBadgeEl } from './state.js';
import { api, clearError, showError } from './api.js';

// ===========================================================================
// Checking a change point -- POST /api/check, then update the tree in place.
// Deliberately does not refetch /api/diff: that would reset scroll position.
// ===========================================================================

export async function onToggleCheck(key, checked) {
  clearError();
  try {
    await api.setChecked(appState.repo, key, checked);
    applyCheckedChange(key, checked);
  } catch (err) {
    showError(err.message);
    // Request failed: put both checkboxes back to the pre-click state. The
    // right-side one only exists while this change point's file is open in
    // the main pane (single-file-view unit, see pane.js) -- the left tree
    // checkbox can always be clicked regardless of which file is displayed.
    const entry = dom.changePoints.get(key);
    if (entry) {
      entry.leftCheckbox.checked = !checked;
      if (entry.rightCheckbox) entry.rightCheckbox.checked = !checked;
    }
  }
}

export function applyCheckedChange(key, checked) {
  const entry = dom.changePoints.get(key);
  if (!entry) return;
  const { changePoint, group, file, groupKey } = entry;
  if (changePoint.checked === checked) return;

  changePoint.checked = checked;
  const delta = checked ? 1 : -1;

  group.checked += delta;
  group.allChecked = group.total > 0 && group.checked === group.total;

  file.checked += delta;
  file.allChecked = file.total > 0 && file.checked === file.total;

  appState.tree.stats.checked += delta;

  // The tree's own checkbox always exists (the tree lists every change
  // point in every file); the right-pane checkbox/container only exist
  // while this change point's file happens to be the one open (see
  // state.js's dom.changePoints block comment) -- checking a change point
  // from the tree while a *different* file is displayed must still update
  // counts correctly without touching a DOM node that doesn't currently
  // exist.
  entry.leftCheckbox.checked = checked;
  if (entry.rightCheckbox) entry.rightCheckbox.checked = checked;
  if (entry.rightContainer) entry.rightContainer.classList.toggle('checked', checked);
  updateGroupDom(groupKey);
  updateFileDom(file.path);
  updateStatsDom();
}

function progressPercent(checked, total) {
  return total > 0 ? `${Math.round((checked / total) * 100)}%` : '0%';
}

function updateGroupDom(groupKey) {
  if (!groupKey) return;
  const entry = dom.groups.get(groupKey);
  if (!entry) return;
  entry.badgeEl.textContent = `${entry.group.checked}/${entry.group.total}`;
  entry.badgeEl.classList.toggle('all-checked', entry.group.allChecked);
  entry.progressFillEl.style.width = progressPercent(entry.group.checked, entry.group.total);
}

export function updateFileDom(path) {
  const entry = dom.files.get(path);
  if (!entry) return;
  entry.badgeEl.textContent = `${entry.file.checked}/${entry.file.total}`;
  entry.badgeEl.classList.toggle('all-checked', entry.file.allChecked);
  entry.progressFillEl.style.width = progressPercent(entry.file.checked, entry.file.total);

  // Single-file-view unit: #file-pane-header's own badge (see pane.js's
  // renderFilePaneHeader) echoes the same count for whichever file is
  // currently open -- refresh it in place too, same "no rebuild"
  // discipline as the tree badge above.
  if (dom.filePaneHeaderBadgeEl && appState.currentFile === path) {
    dom.filePaneHeaderBadgeEl.textContent = `${entry.file.checked}/${entry.file.total}`;
    dom.filePaneHeaderBadgeEl.classList.toggle('all-checked', entry.file.allChecked);
  }
}

export function updateStatsDom() {
  if (!appState.tree) return;
  statsBadgeEl.textContent = `${appState.tree.stats.checked}/${appState.tree.stats.total}`;
}

// ===========================================================================
// EXTENSION POINT 3 -- current change point + moving it.
//
// selectChangePoint() is the single place that changes appState.currentKey
// and the highlight it drives.
//
// Single-file-view unit: this is now the LOW-LEVEL primitive -- it assumes
// `key`'s file is *already* the one displayed (entry.rightContainer exists).
// The user-facing, file-crossing-aware entry point is pane.js's
// openChangePoint(), which opens the right file first (if needed) and then
// calls this. moveSelection() (j/k) and jumpToNextUnread() (u) both moved to
// pane.js/keyboard.js respectively for the same reason -- they need to be
// file-aware too, and pane.js is where "which file is open" lives. This
// file (nav.js) deliberately does NOT import from pane.js: pane.js already
// imports onToggleCheck/selectChangePoint from here, and having nav.js
// import back from pane.js would be exactly the import cycle the
// frontend-modules brief warns is a sign of a wrong seam. Splitting the
// "dumb, same-file" primitive (here) from the "file-aware" wrapper (pane.js)
// keeps the dependency one-directional.
// ===========================================================================

export function selectChangePoint(key, { scroll = false } = {}) {
  if (!key || !dom.changePoints.has(key)) return;
  if (appState.currentKey === key && !scroll) return;

  const prevKey = appState.currentKey;
  appState.currentKey = key;
  if (prevKey && prevKey !== key) setHighlight(prevKey, false);
  setHighlight(key, true);

  if (scroll) {
    const entry = dom.changePoints.get(key);
    if (!entry.rightContainer) return;
    // Addendum: j/k movement gets a 150ms smooth scroll so the user can
    // perceive direction, but prefers-reduced-motion always wins -- jump
    // instantly instead.
    const behavior = prefersReducedMotion() ? 'auto' : 'smooth';
    entry.rightContainer.scrollIntoView({ block: 'start', behavior });
  }
}

export function prefersReducedMotion() {
  return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function setHighlight(key, on) {
  const entry = dom.changePoints.get(key);
  if (!entry) return;
  entry.leftRow.classList.toggle('current', on);
  // rightContainer only exists while this change point's file is open --
  // clearing the highlight from a key whose file was just switched away
  // from (see pane.js's openChangePoint) hits this on the `off` side.
  if (entry.rightContainer) entry.rightContainer.classList.toggle('current', on);
  if (on) entry.leftRow.scrollIntoView({ block: 'nearest' });
}

// ===========================================================================
// Scroll spy: right-pane scroll -> left tree highlight, via
// IntersectionObserver (per brief). Root is the main pane's own scroll
// container, not the viewport, since the main pane scrolls independently.
// ===========================================================================

// Persistent intersection state, keyed by change-point id. An
// IntersectionObserver callback only ever reports the *delta* -- targets
// whose isIntersecting flag changed since the previous callback -- not the
// full set of everything currently intersecting. Two change points that
// render close together relative to the top band (rootMargin below) can
// both be "in play" at once, but only one of them may appear in a given
// batch (the other's state simply didn't change). Deriving the current
// selection from the batch alone therefore silently picks whichever
// change point happened to flip most recently, not whichever one is
// actually topmost right now -- and that wrong pick can even be an
// already-checked change point, which corrupts `u`'s "jump to next
// unread" guarantee. Tracking cumulative state in this map and deriving
// the selection from the whole map, every time, fixes that: every batch
// updates the map, then the topmost currently-intersecting entry (by
// boundingClientRect.top) is recomputed from the full map, not just the
// entries the batch happened to mention.
const intersectionState = new Map(); // key -> { isIntersecting, top }

// `entries` -- the change points belonging to whichever file is currently
// open (single-file-view unit: no longer every change point in every file,
// since only the open file's containers exist in the DOM at all -- see
// pane.js's renderFilePane, the only caller).
export function setupScrollSpy(entries) {
  intersectionState.clear();
  dom.scrollObserver = new IntersectionObserver(handleIntersections, {
    root: mainPaneEl,
    // Treat "current" as whichever change point occupies the top band of
    // the main pane, not merely "any pixel visible".
    rootMargin: '0px 0px -70% 0px',
    threshold: 0,
  });
  for (const entry of entries) {
    dom.scrollObserver.observe(entry.rightContainer);
  }
}

function handleIntersections(batch) {
  for (const e of batch) {
    const key = e.target.dataset.key;
    if (!key) continue;
    intersectionState.set(key, {
      isIntersecting: e.isIntersecting,
      top: e.boundingClientRect.top,
    });
  }

  let topKey = null;
  let topValue = Infinity;
  for (const [key, state] of intersectionState) {
    if (!state.isIntersecting) continue;
    if (state.top < topValue) {
      topValue = state.top;
      topKey = key;
    }
  }
  if (topKey) selectChangePoint(topKey, { scroll: false });
}
