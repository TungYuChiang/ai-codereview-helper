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

// How long the scroll-spy defers to an explicit selection before it's
// allowed to reassign `current` again -- see handleIntersections' block
// comment below for why this exists. Comfortably longer than the 150ms
// smooth-scroll animation below (and than pane.js's instant cross-file
// jump, which is synchronous but whose resulting IntersectionObserver
// callback still arrives a frame or two later), with margin for observer
// delivery latency.
const SPY_SUPPRESS_MS = 400;
let spySuppressedUntil = 0;

export function selectChangePoint(key, { scroll = false, _fromSpy = false } = {}) {
  if (!key || !dom.changePoints.has(key)) return;
  if (appState.currentKey === key && !scroll) return;

  // Any call that did NOT originate from the scroll-spy itself is an
  // explicit navigation -- a tree-row click, j/k, u, or pane.js's
  // cross-file jump (which calls this with scroll:false and then does its
  // own instant scrollIntoView right after, outside this function's view).
  // All of those either animate or jump the pane to a new position; give
  // that motion a window to settle before the spy's own geometry check gets
  // a vote again, or it will "correct" the selection mid-flight to whatever
  // transient entry happens to be passing through the centre band.
  if (!_fromSpy) spySuppressedUntil = performance.now() + SPY_SUPPRESS_MS;

  const prevKey = appState.currentKey;
  appState.currentKey = key;
  if (prevKey && prevKey !== key) setHighlight(prevKey, false);
  setHighlight(key, true);

  if (scroll) {
    const entry = dom.changePoints.get(key);
    if (!entry.rightContainer) return;
    // Addendum: j/k movement gets a 150ms smooth scroll so the user can
    // perceive direction, but prefers-reduced-motion always wins -- jump
    // instantly instead. Centre (not start/top) alignment so the landing
    // spot agrees with the scroll-spy's own "current = centred" rule below
    // -- see that block comment for why mismatched alignment would fight
    // the very selection this scroll is making.
    const behavior = prefersReducedMotion() ? 'auto' : 'smooth';
    entry.rightContainer.scrollIntoView({ block: 'center', behavior });
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
// IntersectionObserver. Root is the main pane's own scroll container, not
// the viewport, since the main pane scrolls independently.
//
// "Current" means whichever change point occupies the reader's line of
// sight -- the vertical MIDDLE of the main pane -- not whichever is nearest
// the top. A reader's eyes sit near the centre of the screen, not glued to
// its top edge; anchoring "current" to a top band means a change point
// taller than that band goes stale (still "current" long after the reader
// has scrolled well past it) while a short one lower on screen -- the one
// actually being read -- never lights up until it reaches the top. See the
// task brief's screenshot: highlighted +269..275 while the reader was
// actually at +281..302, one entry behind, on a screen full of short change
// points -- exactly that.
//
// Implementation: rootMargin below shrinks the observer's effective root to
// a thin band centred on the pane's own vertical middle (see BAND_MARGIN).
// IntersectionObserver keeps doing the actual geometry work off the main
// thread (browser-native, on the compositor), firing a callback only when
// some target's membership in that band changes -- NOT on every scroll
// pixel -- which is what keeps this from doing work proportional to the
// change-point count on every scroll event (the perf constraint). A
// scroll-listener + getBoundingClientRect-per-entry alternative was
// considered and rejected for exactly that reason: it would force a
// synchronous layout read in a loop over every observed entry on every
// (throttled) scroll tick, where this does none.
//
// Persistent intersection state, keyed by change-point id, for the same
// reason as before this change: an IntersectionObserver callback only ever
// reports the *delta* -- targets whose isIntersecting flag changed since
// the previous callback -- not the full set of everything currently
// intersecting. Two change points whose combined height covers the centre
// band can both be "in play" at once, but only one of them may appear in a
// given batch (the other's state simply didn't change). Deriving the
// current selection from the batch alone would silently pick whichever
// change point happened to flip most recently rather than whichever one is
// actually centred right now -- and that wrong pick can even land on an
// already-checked change point, corrupting `u`'s "jump to next unread"
// guarantee (the bug this map originally fixed). Tracking cumulative state
// here and deriving the selection from the whole map, every time, is what
// this file already did for the top-band version; the middle-band version
// below keeps that mechanism unchanged and just changes what "best" means.
const intersectionState = new Map(); // key -> { isIntersecting, top, height }

// Thickness of the centre band, as rootMargin's shrink from each edge.
// -40% top and -40% bottom leaves the middle 20% of the pane as the
// "occupying the reader's line of sight" region. Wide enough that there is
// almost always something in it (so scrolling never has to "hunt" for a
// candidate), narrow enough that with several short change points visible
// at once, only the one or two actually near centre qualify -- the
// nearest-to-centre tie-break below (and the hysteresis bias toward the
// existing selection) resolves any overlap deterministically. A change
// point taller than the viewport spans the band for as long as any part of
// it is on screen, so it wins for the entire time it fills the screen, by
// construction.
const BAND_MARGIN = '-40% 0px -40% 0px';

// Vertical centre (viewport coordinates) of the band computed above, kept
// up to date from each callback's IntersectionObserverEntry.rootBounds --
// which is already the root's rect AFTER rootMargin is applied, i.e.
// exactly the band's own rect -- so this never needs its own
// getBoundingClientRect() call (would force a synchronous layout read).
let bandCenter = 0;

// `entries` -- the change points belonging to whichever file is currently
// open (single-file-view unit: no longer every change point in every file,
// since only the open file's containers exist in the DOM at all -- see
// pane.js's renderFilePane, the only caller).
export function setupScrollSpy(entries) {
  intersectionState.clear();
  dom.scrollObserver = new IntersectionObserver(handleIntersections, {
    root: mainPaneEl,
    rootMargin: BAND_MARGIN,
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
      height: e.boundingClientRect.height,
    });
    if (e.rootBounds) bandCenter = e.rootBounds.top + e.rootBounds.height / 2;
  }

  // Explicit navigation (tree click / j/k / u / pane.js's cross-file jump)
  // just moved the selection and may still be mid-scroll -- smooth-scroll
  // animation within a file, or an instant jump across a file boundary.
  // selectChangePoint() opened this suppression window at the moment it set
  // that selection; honour it here rather than racing the animation and
  // reassigning `current` to whatever transient entry is passing through
  // the centre band at this instant. See selectChangePoint's own comment
  // for the other half of this.
  if (performance.now() < spySuppressedUntil) return;

  // Hysteresis: if the current selection is still intersecting the band at
  // all, keep it, even if some other visible entry is now marginally closer
  // to dead centre. Without this, two change points whose shared boundary
  // sits near the band edge would trade `current` back and forth on every
  // sub-pixel scroll adjustment while the reader is essentially stationary
  // (or scrolling slowly) -- the flicker the brief warns about. Only once
  // the current selection actually leaves the band do we look for a
  // replacement, biasing toward staying put over chasing the exact centre.
  const currentKey = appState.currentKey;
  if (currentKey) {
    const cur = intersectionState.get(currentKey);
    if (cur && cur.isIntersecting) return;
  }

  let bestKey = null;
  let bestDistance = Infinity;
  for (const [key, state] of intersectionState) {
    if (!state.isIntersecting) continue;
    const center = state.top + state.height / 2;
    const distance = Math.abs(center - bandCenter);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestKey = key;
    }
  }
  // No candidate currently intersecting the band (can happen mid-fast-scroll
  // for a brief instant) -- leave the selection exactly where it was rather
  // than clearing it; the next batch will resolve it.
  if (bestKey) selectChangePoint(bestKey, { scroll: false, _fromSpy: true });
}
