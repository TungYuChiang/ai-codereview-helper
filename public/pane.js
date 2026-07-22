// pane.js -- builds one change point's left-tree row AND its right-pane
// container, plus (single-file-view unit) everything about which ONE file
// is currently shown in the right pane: openFile()/renderFilePane() build
// that file's change points on demand instead of every file's change
// points being concatenated into one long scroll.
//
// Why tree-row and right-pane building live in the same file: the brief's
// suggested table groups "tree 與右側渲染" (tree + right-pane rendering)
// into one file. A stash sitting on this branch (two agents' entangled,
// unverified work -- see the unit brief's "why this matters") showed
// exactly what goes wrong with that: one agent's sidebar-prominence change
// and the other's single-file-view change both needed to touch the same
// function (the original renderChangePoint) because it did both jobs at
// once. Splitting "build the left tree row" (renderChangePointTreeRow) from
// "build the right-pane container" (renderChangePointPane) here means a
// future sidebar-only change (label/disclosure-triangle work, in tree.js)
// stays out of this file, and this file owns the right-pane/single-file
// concern end to end.
//
// Dependency direction, and why nav.js does NOT import from here: nav.js's
// selectChangePoint() is a low-level primitive that assumes the target's
// file is already displayed. This file's openChangePoint() is the
// file-aware wrapper everyone else (tree row clicks, j/k, u) actually
// calls -- it opens the right file first (if needed), then delegates to
// nav.js's selectChangePoint(). That means THIS file imports from nav.js
// (onToggleCheck, selectChangePoint, setupScrollSpy), never the reverse --
// nav.js importing openChangePoint back from here would recreate exactly
// the import cycle the frontend-modules brief warns is a sign of a wrong
// seam. tree.js imports renderChangePointTreeRow/openFile from here; this
// file imports from diff.js (render/re-render a change point's content),
// nav.js (checking, low-level selection, scroll-spy), comments.js (attach
// comment UI once a file's change points exist), and prefs.js (persist
// which file is open) -- nothing here imports tree.js back, no cycle.

import {
  appState,
  dom,
  createEl,
  buildFunctionLabel,
  changepointsRootEl,
  mainPaneEl,
  filePaneHeaderEl,
} from './state.js';
import { renderChangePointContent, runGapExpand, makeGap, EXPAND_AUTO_THRESHOLD } from './diff.js';
import { onToggleCheck, selectChangePoint, setupScrollSpy } from './nav.js';
import { renderAllComments, renderOrphans } from './comments.js';
import { persistCurrentFile } from './prefs.js';

// key -> { prev: ChangePoint|null, next: ChangePoint|null }, by newStart
// order across the whole file (every group, not just one). "prev"/"next"
// are the boundaries expansion is allowed to reach: the gap between a
// change point and its neighbor is unmodified code by construction (if it
// weren't, there would be a change point in between), so it is always safe
// to pull as context.
export function buildChangePointNeighbors(file) {
  const all = [];
  for (const group of file.groups) {
    for (const changePoint of group.changePoints) all.push(changePoint);
  }
  all.sort((a, b) => a.newStart - b.newStart);

  const neighbors = new Map();
  for (let i = 0; i < all.length; i++) {
    neighbors.set(all[i].id, {
      prev: i > 0 ? all[i - 1] : null,
      next: i < all.length - 1 ? all[i + 1] : null,
    });
  }
  return neighbors;
}

// Builds ONLY the left tree row for one change point, and registers it in
// dom.changePoints with its right-pane fields left null -- those are filled
// in later, by renderChangePointPane, whenever this change point's file is
// the one open in the right pane (possibly never, if the user scrolls past
// it in the tree without opening that file). This split is what lets the
// tree always list every change point in every file while the right pane
// renders only one file's worth of DOM at a time.
export function renderChangePointTreeRow(changePoint, group, file, groupKey, parentUl) {
  const key = changePoint.id;
  const rangeLabel = `+${changePoint.newStart}..${changePoint.newEnd}`;

  const li = createEl('li', { className: 'tree-changepoint' });
  li.dataset.key = key;

  const label = createEl('span', { className: 'tree-label', text: rangeLabel });
  const leftCheckbox = document.createElement('input');
  leftCheckbox.type = 'checkbox';
  leftCheckbox.checked = changePoint.checked;
  leftCheckbox.setAttribute('aria-label', `mark ${rangeLabel} reviewed`);
  leftCheckbox.addEventListener('click', (e) => e.stopPropagation());
  leftCheckbox.addEventListener('change', () => onToggleCheck(key, leftCheckbox.checked));

  li.append(label, leftCheckbox);
  li.addEventListener('click', () => openChangePoint(key, { scroll: true }));
  parentUl.appendChild(li);

  dom.changePoints.set(key, {
    changePoint,
    group,
    file,
    groupKey,
    leftRow: li,
    leftCheckbox,
    // Right-pane fields -- populated by renderChangePointPane() only while
    // this change point's file is the one displayed, nulled back out by
    // renderFilePane() when it stops being displayed. Any code touching
    // these on a key that isn't appState.currentKey must null-check first.
    rightContainer: null,
    rightCheckbox: null,
    contentEl: null,
    commentEl: null,
    commentBodyEl: null,
    noteBodyEl: null,
    gapAbove: null,
    gapBelow: null,
  });
  appState.order.push(key);
}

// What the right-pane header names a change point by, now that the pane
// shows exactly one file's code at a time: the line range it used to show
// (+1207..1219) is close to noise on its own -- nobody remembers what line
// 1207 was, and the diff rows directly below already carry line numbers in
// the gutter, so repeating the range up here was pure duplication. What the
// header uniquely knows that the gutter doesn't is which FUNCTION the code
// on screen belongs to (entry.group.name), or, for a change point outside
// any function -- entry.group.name is null both for a non-JS file and for
// an edit between two functions, see model.js's groupChangePoints -- which
// FILE it's in (the tree already shows this, but the tree isn't visible
// while your eye is on the code). A function can own more than one change
// point (SelectList.prototype.listMulti has four in the fixture used to
// verify this), and four identical "listMulti" headers in a row would be
// exactly the noise this replaces, so a "(2/4)"-style ordinal -- this
// change point's position within entry.group.changePoints, that group's own
// total -- is appended whenever the owning group has more than one.
function buildChangePointHeaderLabel(entry) {
  const { changePoint, group, file } = entry;
  const total = group.changePoints.length;
  const ordinal =
    total > 1 ? ` (${group.changePoints.findIndex((cp) => cp.id === changePoint.id) + 1}/${total})` : '';

  if (group.name !== null) {
    // Reuses tree.js's own long-name fix (de-emphasized owner prefix, never-
    // truncated identifying tail, full name on title) rather than inventing
    // a second truncation scheme -- see buildFunctionLabel's own comment in
    // state.js for why it lives there instead of being duplicated here.
    // 'changepoint-label' (in place of tree.js's 'tree-label') is what lets
    // this header's own flex/ellipsis rule apply instead of the tree row's.
    const label = buildFunctionLabel(group.name, 'changepoint-label');
    label.lastElementChild.textContent += ordinal;
    return label;
  }

  // File-level change point: no owning function, so the file is the only
  // thing left that answers "what is this". Just the basename, not the full
  // path -- the directory is already sitting right above in the sticky
  // .file-pane-header (renderFilePaneHeader below), so repeating it here
  // would be the same kind of duplication this whole label is fixing.
  const slash = file.path.lastIndexOf('/');
  const baseName = slash === -1 ? file.path : file.path.slice(slash + 1);
  const label = createEl('span', { className: 'changepoint-label', text: baseName + ordinal });
  label.title = file.path;
  return label;
}

// Builds the right-pane container for one change point that has already
// been through renderChangePointTreeRow (so `entry` already exists in
// dom.changePoints) -- called only for change points belonging to whichever
// file renderFilePane is currently building. Fills in entry's right-pane
// fields in place rather than replacing the entry object, so any reference
// to it captured before the file was opened (see openChangePoint) is still
// valid afterward.
function renderChangePointPane(entry, neighborMap) {
  const { changePoint, group, file } = entry;
  const key = changePoint.id;

  // EXTENSION POINT 4: data-key is how the comment unit locates this
  // container to attach its comment UI.
  const container = createEl('div', { className: 'changepoint' });
  container.dataset.key = key;

  const header = createEl('div', { className: 'changepoint-header' });
  const headerLabel = buildChangePointHeaderLabel(entry);
  const rightCheckbox = document.createElement('input');
  rightCheckbox.type = 'checkbox';
  rightCheckbox.checked = changePoint.checked;
  // The visible header now names the function/file (see
  // buildChangePointHeaderLabel above), not the line range -- but the range
  // is still the one unambiguous, always-available fact about WHERE this is
  // (a function name repeats across its "(i/N)" siblings; a screen-reader
  // user isn't reading the diff gutter's line numbers the way a sighted
  // user is), so it's kept here, non-visually, for that.
  const target = group.name !== null ? group.name : file.path;
  rightCheckbox.setAttribute(
    'aria-label',
    `mark ${target}, lines ${changePoint.newStart}-${changePoint.newEnd} reviewed`,
  );
  rightCheckbox.addEventListener('change', () => onToggleCheck(key, rightCheckbox.checked));
  header.append(headerLabel, rightCheckbox);
  container.appendChild(header);

  container.classList.toggle('checked', changePoint.checked);
  container.classList.toggle('current', key === appState.currentKey);

  const content = createEl('div', { className: 'changepoint-content' });
  container.appendChild(content);

  changepointsRootEl.appendChild(container);

  // --- gap state (ui-expand-context unit) --------------------------------
  // "Expand above/below" pulls in the surrounding unmodified file content,
  // GitHub/GitLab-style. Ownership is per-GAP, not per-change-point-side:
  // gapAbove is the unmodified stretch immediately above this change point,
  // down to (exclusive) the previous change point's end, or down to line 1
  // if there is none -- both edges are always known for free, so this
  // exists for EVERY change point, including the first in the file (whose
  // gapAbove simply has top === 1). gapBelow only exists on the LAST change
  // point in the file: the region below it has no knowable lower edge
  // without asking the server (see makeGap/diff.js's block comment), so it
  // cannot be a bounded two-directional gap the way gapAbove always is.
  //
  // Because the gap between two change points is now built exactly once,
  // by exactly one of them (the later one's gapAbove), the previous
  // design's bug class -- two entries independently computing the same
  // [prev.newEnd+1 .. next.newStart-1] window and fetching it twice
  // (confirmed live: the network log showed the identical
  // `/api/lines?...start=6&end=10` request fire twice, once from each
  // side) -- cannot happen: there is only one place holding the state and
  // rendering it, so nothing needs deduplicating.
  const neighbor = (neighborMap && neighborMap.get(key)) || { prev: null, next: null };
  const aboveTop = neighbor.prev ? neighbor.prev.newEnd + 1 : 1;
  const isLastInFile = !neighbor.next;

  entry.rightContainer = container;
  entry.rightCheckbox = rightCheckbox;
  entry.contentEl = content;
  entry.gapAbove = makeGap(file.path, aboveTop, changePoint.newStart - 1);
  entry.gapBelow = isLastInFile ? makeGap(file.path, changePoint.newEnd + 1, null) : null;

  renderChangePointContent(entry);

  // Small gaps read worse behind a click than just shown (brief: "collapsing
  // a three-line gap behind a click is worse than just showing it"), so a
  // gapAbove within EXPAND_AUTO_THRESHOLD lines loads immediately instead of
  // waiting for a click -- for every change point now, not just the first in
  // its file, since every change point's gapAbove is a real, singly-owned
  // gap. gapBelow (the EOF case) is deliberately excluded regardless of
  // size: whether it's small is unknowable without a request (its lower
  // edge isn't known until the server answers), so the last change point in
  // a file always gets a real button, never a silent auto-load.
  if (entry.gapAbove) {
    const size = entry.gapAbove.bottom - entry.gapAbove.top + 1;
    if (size <= EXPAND_AUTO_THRESHOLD) {
      runGapExpand(entry, entry.gapAbove, 'top', size);
    }
  }
}

// ===========================================================================
// Single-file-view unit -- openFile()/renderFilePane() render the right
// pane's content for exactly one file at a time, VSCode-style, instead of
// concatenating every file's change points into one long scroll. The left
// tree (tree.js) is unaffected -- it always lists every file, every
// function, every change point, same as before.
//
// The important invariant this unit maintains: whenever a file is open,
// appState.currentKey always points at a change point INSIDE that file (or
// is null only when the file has zero change points). That's what lets
// moveSelection (j/k) and jumpToNextUnread (u, in keyboard.js) -- which
// both search/walk appState.order, the flattened order across every file,
// starting from appState.currentKey -- cross a file boundary for free: they
// just call openChangePoint(key) same as a tree-row click does, and
// openChangePoint itself notices when `key` belongs to a different file
// than the one currently shown and opens it first. Without the invariant,
// the first j/k/u after switching files by clicking a file header (which
// has no specific target change point) could resolve relative to a stale
// key left over from whatever file was open before, and silently snap back
// to it.
// ===========================================================================

// The file-crossing-aware entry point for "the user wants to look at this
// change point" -- opens its file first if it isn't already the one shown,
// then delegates to nav.js's selectChangePoint for the actual
// highlight/scroll. This is what tree.js's row click, moveSelection (j/k,
// below), and jumpToNextUnread (u, keyboard.js) all call instead of
// nav.js's selectChangePoint directly.
export function openChangePoint(key, { scroll = false } = {}) {
  if (!key) return;
  const entry = dom.changePoints.get(key);
  if (!entry) return;

  const switchedFile = entry.file.path !== appState.currentFile;
  if (switchedFile) {
    renderFilePane(entry.file.path);
  }
  // renderFilePane mutates `entry` in place (see renderChangePointPane) --
  // it's the same object dom.changePoints.get(key) would return now, so
  // entry.rightContainer below is already populated. Defensive only: bail
  // out rather than throw if that invariant is ever violated.
  if (!entry.rightContainer) return;

  if (switchedFile && scroll) {
    // Set state/highlight without letting nav.js's own selectChangePoint
    // scroll -- then scroll here ourselves, instantly. The target change
    // point can be anywhere in the freshly-opened file, including its very
    // last entry (crossing a file boundary backward always lands on the
    // previous file's last change point), which right after
    // renderFilePane's own scrollTop = 0 reset can mean animating the full
    // height of the file. A smooth scroll that long overlaps for hundreds
    // of ms with the scroll-spy's IntersectionObserver (setupScrollSpy,
    // just (re)created by renderFilePane for this file) -- every transient
    // mid-scroll intersection re-invokes selectChangePoint with
    // scroll:false for whatever happens to be passing through the top band
    // at that instant, which can leave the animation settling on a
    // different entry than the one actually requested. There is no
    // continuous content to "perceive direction" through here anyway -- the
    // old file's content is already gone -- so an instant jump is both
    // correct and, if anything, clearer.
    selectChangePoint(key, { scroll: false });
    entry.rightContainer.scrollIntoView({ block: 'start' });
    return;
  }

  selectChangePoint(key, { scroll });
}

// j/k: walks appState.order (already in tree/scroll order, across every
// file) and hands the result to openChangePoint, which crosses a file
// boundary for free when the target isn't in the currently displayed file.
export function moveSelection(delta) {
  const order = appState.order;
  if (order.length === 0) return;
  const currentIdx = appState.currentKey ? order.indexOf(appState.currentKey) : -1;
  const nextIdx = Math.min(Math.max(currentIdx + delta, 0), order.length - 1);
  openChangePoint(order[nextIdx], { scroll: true });
}

// Opens `path` in the right pane, or clears the pane entirely if `path` is
// null (used for the empty-diff case, and internally by tree.js's
// renderTree). No-op if `path` is already the displayed file, so redundant
// clicks on an already-open file's tree row don't disturb its scroll
// position.
export function openFile(path) {
  if (!path) {
    for (const entry of dom.changePoints.values()) {
      if (!entry.rightContainer) continue;
      entry.rightContainer = null;
      entry.rightCheckbox = null;
      entry.contentEl = null;
      entry.commentEl = null;
      entry.commentBodyEl = null;
      entry.noteBodyEl = null;
      entry.gapAbove = null;
      entry.gapBelow = null;
    }
    if (dom.scrollObserver) {
      dom.scrollObserver.disconnect();
      dom.scrollObserver = null;
    }
    appState.currentFile = null;
    appState.currentKey = null;
    persistCurrentFile();
    updateActiveFileInTree(null);
    changepointsRootEl.textContent = '';
    filePaneHeaderEl.hidden = true;
    filePaneHeaderEl.textContent = '';
    if (appState.tree && appState.tree.files.length === 0) {
      changepointsRootEl.appendChild(
        createEl('p', { className: 'empty-state', text: 'No differences between these two revisions.' }),
      );
    }
    // With no file open the section can still have content: orphans whose
    // file left the diff show whatever the selection. See renderOrphans.
    renderOrphans();
    return;
  }

  if (path === appState.currentFile) return;

  renderFilePane(path);
  // The history section is an appendix to this pane and is scoped to the file
  // it sits under, so it has to be rebuilt alongside it.
  renderOrphans();

  // Land on the file's first change point (if it has one) so
  // appState.currentKey keeps pointing at something inside whichever file
  // is actually displayed -- see the invariant explained in the block
  // comment above this section.
  const file = appState.tree.files.find((f) => f.path === path);
  const firstKey =
    file && file.groups.length > 0 && file.groups[0].changePoints.length > 0
      ? file.groups[0].changePoints[0].id
      : null;
  if (firstKey) {
    openChangePoint(firstKey, { scroll: false });
  } else {
    appState.currentKey = null;
  }
}

// Tears down the previously-open file's right-pane DOM (if any) and builds
// the new one. Never called directly for the "no file" case -- see
// openFile's own null branch above, which this function assumes has
// already been ruled out by its caller.
function renderFilePane(path) {
  // The previously displayed file's right-pane DOM is about to be
  // discarded below (changepointsRootEl.textContent = ''), so any
  // in-progress comment edit is over too -- same as a full tree rebuild
  // already did before this unit split tree/pane rendering apart.
  for (const entry of dom.changePoints.values()) {
    if (!entry.rightContainer) continue;
    entry.rightContainer = null;
    entry.rightCheckbox = null;
    entry.contentEl = null;
    entry.commentEl = null;
    entry.commentBodyEl = null;
    entry.noteBodyEl = null;
    entry.gapAbove = null;
    entry.gapBelow = null;
  }
  if (appState.isEditing) {
    appState.isEditing = false;
    appState.editingKey = null;
    appState.editingKind = null;
  }
  if (dom.scrollObserver) {
    dom.scrollObserver.disconnect();
    dom.scrollObserver = null;
  }

  appState.currentFile = path;
  persistCurrentFile();
  updateActiveFileInTree(path);

  changepointsRootEl.textContent = '';
  mainPaneEl.scrollTop = 0;

  const file = appState.tree.files.find((f) => f.path === path);
  if (!file) {
    // Shouldn't happen in practice (tree.js's renderTree/openFile only
    // ever pass a path that's actually in appState.tree.files), but fail
    // toward an empty pane rather than throwing.
    filePaneHeaderEl.hidden = true;
    filePaneHeaderEl.textContent = '';
    return;
  }

  renderFilePaneHeader(file);

  if (file.total === 0) {
    // e.g. a rename or mode-only change with no line-level diff.
    changepointsRootEl.appendChild(
      createEl('p', { className: 'empty-state', text: 'This file has no reviewable change points.' }),
    );
    return;
  }

  // Computed once per file open, not per change point: which change point
  // (if any) sits immediately before/after this one *by line number* in the
  // file. This is deliberately independent of the function/group tree
  // structure -- expansion is about what the file itself looks like top to
  // bottom, not about which function owns a change point -- so it is built
  // from a flat, newStart-sorted view of every change point in the file.
  const neighborMap = buildChangePointNeighbors(file);

  const fileEntries = [];
  for (const group of file.groups) {
    for (const changePoint of group.changePoints) {
      const entry = dom.changePoints.get(changePoint.id);
      if (!entry) continue; // defensive -- the tree render always creates this first
      renderChangePointPane(entry, neighborMap);
      fileEntries.push(entry);
    }
  }

  renderAllComments();
  if (fileEntries.length > 0) setupScrollSpy(fileEntries);
}

// Sticky header naming the currently-open file (see .file-pane-header in
// style.css) -- the visual anchor that used to come for free from scrolling
// past a file boundary, now that there's only ever one file's worth of
// content in the pane. Mirrors tree.js's buildFileLabel dir/name split so
// the same file reads identically here and in the tree. The badge is
// refreshed in place by nav.js's updateFileDom() whenever this file's
// checked count changes, same as the tree's own per-file badge.
function renderFilePaneHeader(file) {
  filePaneHeaderEl.textContent = '';
  filePaneHeaderEl.hidden = false;

  const label = buildFileLabel(file.path);
  label.classList.add('file-pane-header-label');
  const badge = createEl('span', {
    className: 'tree-badge file-pane-header-badge',
    text: `${file.checked}/${file.total}`,
  });
  if (file.allChecked) badge.classList.add('all-checked');

  filePaneHeaderEl.append(label, badge);
  dom.filePaneHeaderBadgeEl = badge;
}

// Same dir/name split as tree.js's buildFileLabel -- duplicated rather than
// imported to avoid tree.js <-> pane.js needing to agree on which of them
// owns it; both call sites want the exact same rendering, but neither
// module needs the other's internals for anything else.
function buildFileLabel(path) {
  const label = createEl('span', { className: 'tree-label tree-path-label' });
  label.title = path;
  const slash = path.lastIndexOf('/');
  if (slash === -1) {
    label.appendChild(createEl('span', { className: 'tree-name', text: path }));
    return label;
  }
  label.appendChild(createEl('span', { className: 'tree-dir', text: path.slice(0, slash + 1) }));
  label.appendChild(createEl('span', { className: 'tree-name', text: path.slice(slash + 1) }));
  return label;
}

// Marks which file is currently open in the tree itself (distinct from
// "current change point", .tree-changepoint.current) -- see .file-open in
// style.css.
export function updateActiveFileInTree(path) {
  for (const [p, entry] of dom.files) {
    entry.headerEl.classList.toggle('file-open', p === path);
  }
}
