// tree.js -- the left sidebar tree (file / function-group / change-point
// rows, collapse state) and the top-level renderTree() entry point that
// walks the whole annotated diff once per load. Split out of app.js as a
// pure move (see state.js's header comment; see pane.js's header comment
// for why change-point *pane* construction lives in a separate file from
// the tree-row building here).

import {
  appState,
  dom,
  createEl,
  buildFunctionLabel,
  treeRootEl,
  changepointsRootEl,
  filePaneHeaderEl,
} from './state.js';
import {
  renderChangePointTreeRow,
  openFile,
  openChangePoint,
  autoExpandsSettled,
} from './pane.js';
import { savedCurrentKey } from './prefs.js';
import { updateStatsDom, hasUserInteracted } from './nav.js';
import { renderOrphans } from './comments.js';

// ===========================================================================
// Tree + right-pane rendering
// ===========================================================================

export function renderTree() {
  if (dom.scrollObserver) {
    dom.scrollObserver.disconnect();
    dom.scrollObserver = null;
  }
  dom.changePoints.clear();
  dom.groups.clear();
  dom.files.clear();
  appState.order = [];

  // A fresh tree means every previous DOM node (including any open comment
  // textarea) is about to be discarded, so any in-progress edit is over too.
  appState.isEditing = false;
  appState.editingKey = null;

  treeRootEl.textContent = '';
  changepointsRootEl.textContent = '';
  filePaneHeaderEl.hidden = true;
  filePaneHeaderEl.textContent = '';

  // Builds the left tree only -- every file, every function group, every
  // change point row, always (this list never shrinks to one file; only the
  // right pane does, see pane.js). See renderFileNode.
  for (const file of appState.tree.files) {
    renderFileNode(file);
  }

  updateStatsDom();
  renderOrphans();

  // Single-file-view unit: the right pane renders exactly one file's change
  // points at a time (see pane.js's openFile/renderFilePane) instead of
  // every file concatenated into one long scroll. Reopen whichever file was
  // already showing, if it still exists in this diff -- repo/ref switches
  // revalidate it the same way load.js's loadRefsForRepo already
  // revalidates base/target against the new refs -- otherwise fall back to
  // the first file in tree order. A diff with zero files (e.g.
  // base === target) opens none at all.
  // Read BEFORE openFile(). openFile lands on the newly-opened file's first
  // change point, which goes through selectChangePoint and therefore
  // persistCurrentKey -- overwriting the very value being restored. Reading it
  // afterwards returns "the first change point" every time, which is exactly
  // the behaviour this is meant to replace.
  const resumeKey = savedCurrentKey();
  const filePaths = appState.tree.files.map((f) => f.path);
  const nextFile = appState.currentFile && filePaths.includes(appState.currentFile)
    ? appState.currentFile
    : (filePaths[0] || null);
  // Force openFile() below to actually (re)render even when nextFile's path
  // string happens to match what was already open before this reload -- the
  // tree/pane DOM above was just torn down and rebuilt from scratch, so
  // openFile's own "already open, skip" guard must not apply here.
  appState.currentFile = null;
  openFile(nextFile);
  restoreReadingPosition(resumeKey);
}

// Scrolls back to whatever change point was current when the page was last
// alive, so a reload resumes where reading stopped instead of at the top of
// the file. The spec's whole premise is that a review gets interrupted and
// picked up later ("中斷後能接著看"); restoring the file but not the position
// left you hunting for your place on every refresh.
//
// The saved key is a content hash, so it only still matches when that exact
// change point survived the diff being recomputed (see state.js's
// changePointKey). If the code moved on, or the key belongs to some other
// file, openFile's own landing spot -- the file's first change point --
// simply stands. No staleness check of its own is needed: a key that no
// longer identifies anything cannot be found in dom.changePoints.
// Two animation frames -- the first lets style/layout settle after a render,
// the second runs once that layout has actually been performed -- but racing a
// timer, because requestAnimationFrame does not fire at all in a background
// tab. Without the race the promise chain below never settles there, and the
// .finally that re-enables position tracking never runs: restoring in a tab
// you had not looked at yet would silently stop the position being saved for
// the rest of the session.
function afterTwoFrames(timeoutMs = 250) {
  return new Promise((resolve) => {
    const done = () => resolve();
    requestAnimationFrame(() => requestAnimationFrame(done));
    setTimeout(done, timeoutMs);
  });
}

function restoreReadingPosition(key) {
  if (!key) return;
  const entry = dom.changePoints.get(key);
  if (!entry || entry.file.path !== appState.currentFile) return;

  // Select immediately so the tree highlight is right from the first frame,
  // but defer the scroll: the right pane's rows exist without having been laid
  // out yet, and scrolling into a geometry that is still moving lands nowhere
  // useful -- measured, it left the pane at the top of the file with the
  // correct row highlighted, which is the worst of both.
  openChangePoint(key, { scroll: false });

  // Wait for this file's auto-expands before scrolling, rather than a fixed
  // two frames. Two frames was enough for layout to settle but not for the
  // fetches those small gaps kick off: each lands later and inserts height
  // ABOVE this change point, so a scroll timed before them aims at a geometry
  // that is still moving. On a file with dozens of change points that is most
  // of them, which is why the position kept coming back wrong.
  autoExpandsSettled()
    .then(() => afterTwoFrames())
    .then(() => {
      // Re-read rather than closing over the entry: a repo/ref switch can land
      // another render in between, and scrolling to a row from the previous
      // tree would yank the user somewhere arbitrary.
      // Abandoned if the reader already started moving on their own -- being
      // yanked somewhere else a second after you began reading is worse than
      // landing at the top.
      if (hasUserInteracted()) return;
      const still = dom.changePoints.get(key);
      if (still && appState.currentKey === key) {
        openChangePoint(key, { scroll: true, instant: true });
      }
    });
}

// Splits a file path into "dir/" (muted) + "name" (foreground) so a single
// tree row reads as path + emphasis without relying on indentation --
// addendum: the file level must be visually distinguishable from function
// and change-point levels by typeface/weight, not just indent depth.
function buildFileLabel(path) {
  // tree-path-label is the modifier that turns on shrink-the-directory,
  // never-shrink-the-filename -- the same split .tree-fn-label already does
  // for `SelectList.prototype.` + `listAll`. Deliberately not folded into
  // .tree-label itself: a label holding one plain text node needs the
  // ordinary overflow/ellipsis path, which a flex container does not give it.
  const label = createEl('span', { className: 'tree-label tree-path-label' });
  // The directory half is now elidable, so the full path has to stay
  // reachable somewhere. buildFunctionLabel titles itself with the un-elided
  // name for exactly this reason.
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

// Thin 2px progress rail shown under file / function rows (addendum:
// "how much is left" should be scannable, not read off a small grey
// counter). Returns the outer track element; caller keeps the fill ref to
// update its width in place as checks come in, without re-rendering.
function buildProgressRail(checked, total) {
  const track = createEl('div', { className: 'tree-progress' });
  const fill = createEl('span', { className: 'tree-progress-fill' });
  fill.style.width = total > 0 ? `${Math.round((checked / total) * 100)}%` : '0%';
  track.appendChild(fill);
  return { track, fill };
}

// Builds ONLY the left tree's file node (row + collapse + progress rail +
// its function/change-point children). This used to also build the right
// pane's change-point containers in the same pass -- split apart by the
// single-file-view unit, since the tree always lists every file but the
// right pane now shows only one at a time (see pane.js's
// openFile/renderFilePane). The right-pane content for whichever file is
// open is built separately, from this same file/group/changePoint model,
// when that file is opened.
function renderFileNode(file) {
  const li = createEl('li', { className: 'tree-file' });

  // File row + its progress rail live together in one sticky header (see
  // .tree-file-header in style.css) -- addendum: the file level is a
  // container, and a container should stay labeled while its contents
  // scroll past. Everything sticks as one unit so the progress rail stays
  // visible too, not just the name.
  const header = createEl('div', { className: 'tree-file-header' });
  const row = createEl('div', { className: 'tree-row tree-file-row' });

  const collapseId = `file:${file.path}`;
  const collapsed = appState.collapsed.has(collapseId);

  const toggleBtn = createEl('button', { className: 'toggle-btn', text: collapsed ? '▸' : '▾' });
  toggleBtn.type = 'button';
  toggleBtn.addEventListener('click', (e) => {
    // Don't let this also open the file below -- the triangle's job is
    // purely fold/unfold, independent of which file is displayed.
    e.stopPropagation();
    toggleCollapse(collapseId, 'file', file.path);
  });

  const label = buildFileLabel(file.path);
  const badge = createEl('span', { className: 'tree-badge', text: `${file.checked}/${file.total}` });
  if (file.allChecked) badge.classList.add('all-checked');

  row.append(toggleBtn, label, badge);
  header.appendChild(row);

  // Clicking anywhere on the sticky header (except the toggle above) opens
  // this file in the right pane -- the single-file-view unit's primary way
  // of switching files "from the tree" (also reachable via j/k/u/clicking a
  // change point row, all of which route through pane.js's
  // openChangePoint).
  header.addEventListener('click', () => openFile(file.path));

  const { track: progressTrack, fill: progressFill } = buildProgressRail(file.checked, file.total);
  header.appendChild(progressTrack);
  li.appendChild(header);

  const childUl = createEl('ul', { className: 'tree-children' });
  childUl.hidden = collapsed;
  li.appendChild(childUl);

  dom.files.set(file.path, {
    file,
    badgeEl: badge,
    progressFillEl: progressFill,
    toggleBtn,
    childUl,
    headerEl: header, // toggled .file-open by pane.js's updateActiveFileInTree
  });
  treeRootEl.appendChild(li);

  file.groups.forEach((group, groupIdx) => {
    if (group.name === null) {
      // The file-level bucket: no extra tree level, its change points hang
      // directly under the file (this is how non-JS files render as two
      // levels instead of three -- see model.js).
      for (const changePoint of group.changePoints) {
        renderChangePointTreeRow(changePoint, group, file, null, childUl);
      }
      return;
    }

    const groupKey = `${file.path}::g${groupIdx}`;
    renderGroupNode(group, groupKey, file, childUl);
  });
}

function renderGroupNode(group, groupKey, file, parentUl) {
  const li = createEl('li', { className: 'tree-group' });
  const row = createEl('div', { className: 'tree-row tree-group-row' });

  const collapseId = `group:${groupKey}`;
  const collapsed = appState.collapsed.has(collapseId);

  const toggleBtn = createEl('button', { className: 'toggle-btn', text: collapsed ? '▸' : '▾' });
  toggleBtn.type = 'button';
  toggleBtn.addEventListener('click', () => toggleCollapse(collapseId, 'group', groupKey));

  const label = buildFunctionLabel(group.name);
  const badge = createEl('span', { className: 'tree-badge', text: `${group.checked}/${group.total}` });
  if (group.allChecked) badge.classList.add('all-checked');

  row.append(toggleBtn, label, badge);
  li.appendChild(row);

  const { track: progressTrack, fill: progressFill } = buildProgressRail(group.checked, group.total);
  li.appendChild(progressTrack);

  const childUl = createEl('ul', { className: 'tree-children' });
  childUl.hidden = collapsed;
  li.appendChild(childUl);

  dom.groups.set(groupKey, { group, badgeEl: badge, progressFillEl: progressFill, toggleBtn, childUl });
  parentUl.appendChild(li);

  for (const changePoint of group.changePoints) {
    renderChangePointTreeRow(changePoint, group, file, groupKey, childUl);
  }
}

export function toggleCollapse(collapseId, kind, id) {
  const entry = kind === 'file' ? dom.files.get(id) : dom.groups.get(id);
  if (!entry) return;

  const nowCollapsed = !appState.collapsed.has(collapseId);
  if (nowCollapsed) {
    appState.collapsed.add(collapseId);
  } else {
    appState.collapsed.delete(collapseId);
  }
  entry.childUl.hidden = nowCollapsed;
  entry.toggleBtn.textContent = nowCollapsed ? '▸' : '▾';
}
