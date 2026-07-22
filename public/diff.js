// diff.js -- render a single change point's content area (diff lines, Prism
// highlighting, unified/side-by-side layout) and its on-demand context
// expansion above/below. Split out of app.js as a pure move (see state.js's
// header comment).
//
// These two concerns (content rendering, expand-context) were split into
// separate files (diff.js / expand.js) in the brief's suggested table, but
// runGapExpand() re-renders a change point's content in place after a fetch
// (calling straight back into renderChangePointContent), and
// renderChangePointContent() builds the gap rows around it (calling into
// buildGapAboveSegments/buildGapBelowRow) -- each direction needs the other,
// which is exactly the "two modules import each other" cycle the brief
// calls out as a sign the seam is in the wrong place. Kept together here
// instead: one coherent responsibility ("how a change point's body renders,
// including pulling in more of the file around it"), no cycle.

import { appState, createEl, mainPaneEl } from './state.js';
import { api } from './api.js';

// ===========================================================================
// EXTENSION POINT 1 -- render a single change point's content area.
//
// Reads appState.viewMode to pick unified vs. side-by-side. Signature
// changed by the ui-expand-context unit: (entry) -> void, reading
// entry.contentEl (already appended to the DOM) and entry.gapAbove /
// entry.gapBelow (the per-change-point gap state added below). It used to
// be (changePoint, contentEl) -- widened to the whole dom.changePoints
// entry because expansion needs entry.gapAbove/gapBelow, which only exist
// per-entry, not on the changePoint object itself (that object is shared
// with server state, see the comment on the next block, and must not gain
// ad-hoc UI fields). Called from pane.js's renderChangePoint() (initial
// render), topbar.js's setViewMode() (re-render in place on mode switch),
// and runGapExpand() below (re-render in place after a gap fetch
// starts/finishes) -- never a refetch, never a scroll reset, in all three
// cases.
//
// Security: diff content comes from the reviewed repo and may contain
// anything, including literal HTML. Every path below writes text via
// textContent/createEl, with exactly one exception: buildCodeSpan() may
// assign to innerHTML, but only ever with the *return value* of
// Prism.highlight(text, grammar, lang) -- Prism's tokenizer HTML-escapes
// the source text itself before wrapping matched tokens in spans, so the
// result is always safe markup. Raw `line.text` is never assigned to
// innerHTML anywhere. Lines fetched via GET /api/lines for expansion go
// through the exact same buildCodeSpan()/buildUnifiedRow()/
// buildSideBySideRow() path as the diff's own lines -- no second rendering
// path, no second security story to keep in sync.
// ===========================================================================

// Line objects come from git.js and are shared by reference with server
// state (see model.js/state.js comments) -- read-only, never mutated here.

const EXT_TO_PRISM_LANG = {
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  css: 'css',
  html: 'markup',
  htm: 'markup',
  xml: 'markup',
  svg: 'markup',
  // Grammar comes from its own <script> in index.html, not the vendored
  // bundle, which ships only markup/css/clike/javascript. Both halves are
  // needed and each is inert alone: without the grammar this entry names a
  // language Prism does not have and getPrismLanguage's own guard returns
  // null; without this entry the grammar loads but nothing ever asks for it.
  // Java rendered as plain text until both were in place.
  java: 'java',
};

// Resolves a Prism language name for a file path, or null if the extension
// is unknown or the vendored Prism bundle doesn't have that grammar loaded.
// Callers must treat null as "render as plain text" -- never throw.
//
// Exported for comments.js's history-annotation snapshots, which render the
// stored diffText through the same buildUnifiedDiff() below rather than as
// flat text -- see the note on buildUnifiedDiff.
export function getPrismLanguage(filePath) {
  const match = /\.([^./]+)$/.exec(filePath || '');
  const ext = match ? match[1].toLowerCase() : '';
  const lang = EXT_TO_PRISM_LANG[ext];
  if (!lang) return null;
  if (typeof Prism === 'undefined' || !Prism.languages || !Prism.languages[lang]) return null;
  return lang;
}

// Builds the inline text/code carrier for one line's content. Highlighted
// path uses Prism.highlight() (escapes internally, see block comment
// above); everything else -- including any Prism failure -- falls back to
// plain textContent so an unknown/broken grammar degrades instead of
// crashing the render.
function buildCodeSpan(text, lang) {
  const span = createEl('span', { className: 'diff-code-text' });
  if (lang) {
    try {
      span.innerHTML = Prism.highlight(text, Prism.languages[lang], lang);
      return span;
    } catch {
      // fall through to plain text below
    }
  }
  span.textContent = text;
  return span;
}

function diffRowTypeClass(type) {
  if (type === '+') return 'add';
  if (type === '-') return 'del';
  return 'ctx';
}

// Builds the ordered list of render segments for one change point: any
// loaded gap-above context, then that gap's control element(s) -- placed at
// the boundary each one actually operates on, see buildGapAboveSegments --
// the change point's own diff lines, then any loaded gap-below context and
// its control row. Adjacent `lines` segments are merged into one array
// before rendering so a fully-loaded gap (or a gap whose control row has
// already disappeared on one side) reads as a single seamless diff block --
// exactly like the change point's own lines always have -- instead of an
// arbitrary seam wherever this function happened to push a new array.
function buildSegments(entry) {
  const { changePoint, gapAbove, gapBelow } = entry;
  const raw = [];

  if (gapAbove) {
    // down/mid/up map onto three possible positions within the gap, not
    // three rows that always coexist -- see buildGapAboveSegments for which
    // combination applies. `down` sits right where gapAbove.topLines stops
    // (i.e. flush under whatever is above this gap), `up` sits right where
    // gapAbove.bottomLines starts (flush above this change point), and
    // `mid` sits between them regardless of whether one or both of the
    // others are present.
    const segs = buildGapAboveSegments(entry);
    if (gapAbove.topLines.length) raw.push({ type: 'lines', lines: gapAbove.topLines });
    if (segs?.down) raw.push({ type: 'el', el: segs.down });
    if (segs?.mid) raw.push({ type: 'el', el: segs.mid });
    if (segs?.up) raw.push({ type: 'el', el: segs.up });
    if (gapAbove.bottomLines.length) raw.push({ type: 'lines', lines: gapAbove.bottomLines });
  }

  raw.push({ type: 'lines', lines: changePoint.lines });

  if (gapBelow) {
    if (gapBelow.topLines.length) raw.push({ type: 'lines', lines: gapBelow.topLines });
    const el = buildGapBelowRow(entry);
    if (el) raw.push({ type: 'el', el });
  }

  const merged = [];
  for (const seg of raw) {
    const prev = merged[merged.length - 1];
    if (seg.type === 'lines' && prev && prev.type === 'lines') {
      prev.lines = prev.lines.concat(seg.lines);
    } else if (seg.type === 'lines') {
      merged.push({ type: 'lines', lines: seg.lines });
    } else {
      merged.push(seg);
    }
  }
  return merged;
}

// ===========================================================================
// EXTENSION POINT 6 -- line anchoring (comment on one line, or a run of
// lines, inside a change point -- the GitHub/GitLab PR-review idiom).
//
// -- Why a registry instead of an import --------------------------------
// The anchor affordance lives in the diff rows (this file), but the editor
// and the rendered anchored comments are comments.js's job -- and comments.js
// already imports buildUnifiedDiff/getPrismLanguage from here for its history
// snapshots. Importing back would be exactly the cycle this codebase's module
// briefs treat as a sign of a wrong seam, so comments.js REGISTERS its two
// entry points here at module load instead. Nothing in this file knows what a
// comment is; it only knows "there is a place to click, and something else
// decides what that means".
//
// -- What an anchor addresses -------------------------------------------
// A 0-based inclusive index range into the change point's own diffText lines
// (see state.js on the server). diffText holds the CHANGED lines only, while
// `changePoint.lines` also carries context, so the mapping between them is
// "the k-th non-context line of `lines` is diffText line k" -- computed once
// per render into anchorIndexByLine below, keyed by the line OBJECT (those
// objects are shared by reference through the whole pipeline, and are the
// only thing that reliably distinguishes a change point's own context line
// from an identical-looking gap-expansion context line spliced in beside it).
//
// -- Unified only, deliberately ------------------------------------------
// See renderAnchorFallback below for the side-by-side story and why.
// ===========================================================================

let anchorUi = null;

export function registerAnchorUi(handlers) {
  anchorUi = handlers;
}

function anchorIndexByLine(changePoint) {
  const map = new Map();
  let changedIndex = 0;
  for (const line of changePoint.lines ?? []) {
    if (line.type === ' ') continue;
    map.set(line, changedIndex);
    changedIndex += 1;
  }
  return map;
}

// The line-number label an anchor button announces. Real file line numbers
// where the line has one; a deleted line has only an old-side number, and
// claiming a new-side one would be inventing it (same rule as everywhere else
// in this app).
function anchorLineDescription(line) {
  if (line.newLine != null) return `line ${line.newLine}`;
  if (line.oldLine != null) return `deleted line ${line.oldLine}`;
  return 'this line';
}

export function renderChangePointContent(entry) {
  const { changePoint, contentEl } = entry;
  contentEl.textContent = '';

  const lang = getPrismLanguage(changePoint.filePath);
  const segments = buildSegments(entry);

  // Rebuilt from scratch on every render (this function is also the
  // re-render path for gap expansion and view-mode switching), so a stale
  // row element can never be handed to the anchored-comment renderer.
  entry.anchorRows = new Map();

  const anchorCtx =
    appState.viewMode === 'side-by-side' || !anchorUi
      ? null
      : { indexByLine: anchorIndexByLine(changePoint), entry };

  const body = createEl('div', { className: 'diff-body' });
  for (const segment of segments) {
    if (segment.type === 'lines') {
      body.appendChild(
        appState.viewMode === 'side-by-side'
          ? buildSideBySideDiff(segment.lines, lang)
          : buildUnifiedDiff(segment.lines, lang, anchorCtx),
      );
    } else {
      body.appendChild(segment.el);
    }
  }

  contentEl.appendChild(body);

  // Anchored comments render last, into rows that now exist. In side-by-side
  // there are no anchor rows at all, so this falls back to a flat list under
  // the diff -- see comments.js's renderAnchoredComments.
  if (anchorUi) anchorUi.renderAnchored(entry);
}

// ---------------------------------------------------------------------------
// Unified: one row per line, old-line# | new-line# | marker | code.
// ---------------------------------------------------------------------------

// Renamed from renderUnified(changePoint, contentEl): now takes one segment
// of the combined [...gap-above lines, ...diff lines, ...gap-below lines]
// render and returns the element instead of appending it directly, so the
// caller can place gap control rows between segments.
//
// Exported (with getPrismLanguage above) so comments.js can render a history
// annotation's stored diffText snapshot with the same rows, tints and Prism
// highlighting as the live diff instead of keeping a second, drifting copy
// of this. It only needs `line` objects shaped like git.js's -- {type,
// oldLine, newLine, text} -- and buildUnifiedRow already renders a null
// oldLine/newLine as an empty gutter cell, which is exactly what a snapshot
// (deliberately stored without line numbers, see state.js) must show.
// `anchorCtx` (optional, unified rendering of a live change point only) is
// { indexByLine, entry } -- see EXTENSION POINT 6. When absent the output is
// byte-for-byte what it always was, which is what keeps comments.js's history
// snapshots (no live change point behind them, nothing to anchor to) and
// gap-expansion context rows unchanged.
export function buildUnifiedDiff(lines, lang, anchorCtx = null) {
  const container = createEl('div', { className: 'diff-unified' });
  if (anchorCtx) container.classList.add('diff-anchorable');
  for (const line of lines) {
    container.appendChild(buildUnifiedRow(line, lang, anchorCtx));
  }
  return container;
}

function buildUnifiedRow(line, lang, anchorCtx = null) {
  const row = createEl('div', { className: `diff-row diff-row-${diffRowTypeClass(line.type)}` });
  // The anchor cell is added to EVERY row whenever anchoring is on, even the
  // rows that cannot be anchored (gap context spliced in around the change
  // point) -- an empty placeholder keeps every row's columns aligned, which a
  // cell that appears only on some rows would not.
  if (anchorCtx) row.appendChild(buildAnchorCell(line, anchorCtx));
  row.appendChild(
    createEl('span', {
      className: 'diff-gutter',
      text: line.oldLine != null ? String(line.oldLine) : '',
    }),
  );
  row.appendChild(
    createEl('span', {
      className: 'diff-gutter',
      text: line.newLine != null ? String(line.newLine) : '',
    }),
  );
  row.appendChild(createEl('span', { className: 'diff-marker', text: line.type }));
  const code = createEl('span', { className: 'diff-code' });
  code.appendChild(buildCodeSpan(line.text, lang));
  row.appendChild(code);
  return row;
}

// One row's anchor affordance: a real <button> (Tab/Enter/Space work for
// free, and a shift-click arrives here with e.shiftKey already set, so
// shift-Enter from the keyboard extends a range for free too), or an inert
// placeholder for a row that is not part of this change point's own diff.
//
// Only ONE of these buttons per change point is in the tab order at a time
// (roving tabindex): a 67-line change point would otherwise put 67 tab stops
// between the diff and the comment box below it. Arrow Up/Down move between
// them once focus is inside -- the standard composite-widget pattern, and the
// same level of keyboard/ARIA care the splitter above already commits to.
function buildAnchorCell(line, anchorCtx) {
  const index = anchorCtx.indexByLine.get(line);
  if (index === undefined) return createEl('span', { className: 'diff-anchor-cell' });

  const cell = createEl('span', { className: 'diff-anchor-cell' });
  const btn = createEl('button', { className: 'diff-anchor-btn', text: '+' });
  btn.type = 'button';
  btn.tabIndex = index === 0 ? 0 : -1;
  btn.dataset.anchorIndex = String(index);
  btn.setAttribute(
    'aria-label',
    `comment on ${anchorLineDescription(line)} (shift to extend from the last line you picked)`,
  );
  // Activation. A keyboard Enter/Space arrives here as a click too, so mouse
  // and keyboard share one path: `shiftKey` covers shift-click and
  // shift-Enter, and a pending Shift+Arrow selection covers plain Enter after
  // extending. See resolveAnchorRange.
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    const entry = anchorCtx.entry;
    // A live text selection spanning diff rows wins over the clicked line.
    // Selecting the lines you mean and then asking to comment is the gesture
    // people arrive with, and the first version of this unit ignored it: you
    // could select ten lines, click, and get "comment on line 319" with
    // nothing to say the selection had been dropped.
    //
    // This does not make selecting text *do* anything by itself -- copying
    // code is untouched, which was the original objection to reading the
    // selection at all. It is consulted only at the moment you explicitly
    // ask for a comment.
    const range = selectionAnchorRange(entry) ?? resolveAnchorRange(entry, index, e.shiftKey);
    entry.anchorPendingStart = null;
    if (!e.shiftKey) entry.anchorLastPick = index;
    anchorUi.openEditor(entry, range);
  });
  btn.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    // Stopped from reaching keyboard.js's global handler: nothing typed while
    // aiming at a line should navigate away from it.
    e.stopPropagation();
    const entry = anchorCtx.entry;
    // Shift+Arrow extends a pending range from wherever the walk started;
    // a plain arrow abandons any pending range and just moves.
    if (e.shiftKey) {
      if (entry.anchorPendingStart == null) entry.anchorPendingStart = index;
    } else {
      entry.anchorPendingStart = null;
    }
    moveAnchorFocus(entry, index, e.key === 'ArrowDown' ? 1 : -1);
  });
  cell.appendChild(btn);
  // `cell` only, not its row: the row does not exist as this cell's parent
  // yet (buildUnifiedRow appends it a moment later). Consumers read
  // cell.parentElement at insertion time, by which point it does.
  anchorCtx.entry.anchorRows.set(index, { cell, btn });
  return cell;
}

// The range an activation means:
//   plain            -> just this line
//   shift            -> from the last line picked (mouse) back to this one
//   pending Shift+Arrow -> from where the arrow walk started to this one
// Shift with nothing to extend from degrades to a single line rather than
// doing something surprising.
function resolveAnchorRange(entry, index, shiftKey) {
  const origin = shiftKey
    ? entry.anchorLastPick ?? entry.anchorPendingStart ?? index
    : entry.anchorPendingStart ?? index;
  return { start: Math.min(origin, index), end: Math.max(origin, index) };
}

// The anchor range implied by the current text selection, or null when there
// isn't one to speak of.
//
// Only rows this change point owns are considered, so a selection dragged
// across two change points anchors within the one whose gutter you clicked
// rather than producing a range that spans a boundary the data model has no
// way to express.
//
// Context lines are skipped for free: anchorRows only ever holds rows that
// have an index, and only changed lines get one (diffText is built from
// changedLines -- see model.js). So selecting a whole screen of code anchors
// to the changed lines inside it, which is the only thing an anchor can
// address.
function selectionAnchorRange(entry) {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  if (!entry.anchorRows) return null;

  let min = null;
  let max = null;
  for (const [index, { cell }] of entry.anchorRows) {
    const row = cell.parentElement;
    if (!row || !selectionCoversRow(selection, row)) continue;
    if (min === null || index < min) min = index;
    if (max === null || index > max) max = index;
  }
  return min === null ? null : { start: min, end: max };
}

// True when the selection actually covers some of `row`'s content.
//
// containsNode(row, true) alone is not enough: a drag that stops at the very
// start of the next line still reports that line as partially contained, so a
// selection of 308-318 would anchor 308-319 -- an off-by-one that only shows
// up on the last line and would be easy to ship. Comparing boundary points
// against a range over the row's own contents asks the precise question
// instead: does the selection end after this row begins, AND begin before
// this row ends.
function selectionCoversRow(selection, row) {
  const rowRange = document.createRange();
  rowRange.selectNodeContents(row);
  try {
    for (let i = 0; i < selection.rangeCount; i++) {
      const sel = selection.getRangeAt(i);
      // Naming per the DOM spec, which is the opposite way round from how the
      // constants read: END_TO_START compares *this* range's start against
      // sourceRange's end, and START_TO_END compares this range's end against
      // sourceRange's start.
      const startsBeforeRowEnds = sel.compareBoundaryPoints(Range.END_TO_START, rowRange) < 0;
      const endsAfterRowStarts = sel.compareBoundaryPoints(Range.START_TO_END, rowRange) > 0;
      if (startsBeforeRowEnds && endsAfterRowStarts) return true;
    }
  } catch {
    // Ranges in different documents throw WrongDocumentError. Nothing here can
    // produce that, but a selection is user-driven state and this runs on
    // every anchor click -- degrading to "no selection" is always safe.
    return false;
  }
  return false;
}

// Roving tabindex: the focused button becomes the single tab stop, so leaving
// and re-entering the diff comes back to where the user was. Also repaints the
// pending Shift+Arrow range, which is the only feedback a keyboard user gets
// that they are building a range rather than picking one line.
function moveAnchorFocus(entry, fromIndex, delta) {
  const next = entry.anchorRows.get(fromIndex + delta);
  if (!next) return;
  for (const { btn } of entry.anchorRows.values()) btn.tabIndex = -1;
  next.btn.tabIndex = 0;
  next.btn.focus();
  paintPendingAnchorRange(entry, fromIndex + delta);
}

function paintPendingAnchorRange(entry, focusedIndex) {
  const start = entry.anchorPendingStart;
  for (const [index, { cell }] of entry.anchorRows) {
    const row = cell.parentElement;
    if (!row) continue;
    const inRange =
      start != null &&
      index >= Math.min(start, focusedIndex) &&
      index <= Math.max(start, focusedIndex);
    row.classList.toggle('diff-row-anchor-pending', inRange);
  }
}

// Puts keyboard focus on a change point's first anchor button -- the entry
// point for the `a` shortcut (keyboard.js), which is what makes this feature
// reachable without a mouse at all.
export function focusFirstAnchor(entry) {
  const first = entry.anchorRows && entry.anchorRows.get(0);
  if (!first) return false;
  entry.anchorPendingStart = null;
  for (const { btn } of entry.anchorRows.values()) btn.tabIndex = -1;
  first.btn.tabIndex = 0;
  first.btn.focus();
  return true;
}

// ---------------------------------------------------------------------------
// Side-by-side: old lines on the left, new lines on the right, aligned row
// by row. Context lines appear on both sides. A run of N '-' lines directly
// followed by a run of M '+' lines pairs the first min(N,M) rows; the
// leftover rows are single-sided (empty cell on the other side).
// ---------------------------------------------------------------------------

function pairLinesForSideBySide(lines) {
  const rows = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    if (line.type === ' ') {
      rows.push({ left: line, right: line });
      i++;
      continue;
    }

    if (line.type === '-') {
      const dels = [];
      while (i < lines.length && lines[i].type === '-') {
        dels.push(lines[i]);
        i++;
      }
      const adds = [];
      while (i < lines.length && lines[i].type === '+') {
        adds.push(lines[i]);
        i++;
      }
      const pairCount = Math.min(dels.length, adds.length);
      for (let k = 0; k < pairCount; k++) rows.push({ left: dels[k], right: adds[k] });
      for (let k = pairCount; k < dels.length; k++) rows.push({ left: dels[k], right: null });
      for (let k = pairCount; k < adds.length; k++) rows.push({ left: null, right: adds[k] });
      continue;
    }

    if (line.type === '+') {
      // '+' run with no immediately preceding '-' run (e.g. a pure addition).
      const adds = [];
      while (i < lines.length && lines[i].type === '+') {
        adds.push(lines[i]);
        i++;
      }
      for (const add of adds) rows.push({ left: null, right: add });
      continue;
    }

    // Unrecognised line type: git.js only ever emits '+' / '-' / ' ' today,
    // but if that ever changes, skip the line rather than falling through
    // into the '+' branch above -- which only advances `i` while
    // lines[i].type === '+' and would otherwise spin forever on anything
    // else. Same precaution model.js already takes for this class of input
    // (see its buildAnnotated line-type handling: "寧可跳過這行也不要讓
    // cursor 被污染").
    i++;
  }
  return rows;
}

// Renamed from renderSideBySide(changePoint, contentEl) for the same reason
// as buildUnifiedDiff above.
function buildSideBySideDiff(lines, lang) {
  const rows = pairLinesForSideBySide(lines);

  const container = createEl('div', { className: 'diff-sidebyside' });
  const leftCol = createEl('div', { className: 'diff-side diff-side-left' });
  const rightCol = createEl('div', { className: 'diff-side diff-side-right' });

  for (const { left, right } of rows) {
    leftCol.appendChild(buildSideBySideRow(left, lang, 'old'));
    rightCol.appendChild(buildSideBySideRow(right, lang, 'new'));
  }

  // The divider between the two columns is the drag handle -- see the
  // splitter block below. It is a real flex item between the columns (not
  // an overlay) so each column's own width, and therefore its own
  // horizontal overflow, stays exactly what CSS says it is: nothing about
  // scrolling changes, only how the available width is divided.
  container.append(leftCol, buildSplitter(), rightCol);
  return container;
}

function buildSideBySideRow(line, lang, side) {
  if (!line) {
    const row = createEl('div', { className: 'diff-row diff-row-empty' });
    row.appendChild(createEl('span', { className: 'diff-gutter' }));
    row.appendChild(createEl('span', { className: 'diff-marker' }));
    row.appendChild(createEl('span', { className: 'diff-code' }));
    return row;
  }

  const row = createEl('div', { className: `diff-row diff-row-${diffRowTypeClass(line.type)}` });
  const lineNo = side === 'old' ? line.oldLine : line.newLine;
  row.appendChild(
    createEl('span', { className: 'diff-gutter', text: lineNo != null ? String(lineNo) : '' }),
  );
  row.appendChild(createEl('span', { className: 'diff-marker', text: line.type }));
  const code = createEl('span', { className: 'diff-code' });
  code.appendChild(buildCodeSpan(line.text, lang));
  row.appendChild(code);
  return row;
}

// ===========================================================================
// EXTENSION POINT 3 -- the side-by-side column splitter (ui-sbs-splitter
// unit). VS Code's diff editor lets you drag the divider to widen whichever
// side you are reading; the complaint that prompted this was a long CJK
// comment cut off mid-sentence in the new-version column.
//
// -- One ratio, globally ----------------------------------------------------
// The ratio is NOT per change point. A file with forty change points would
// otherwise need forty drags to read one over-long line, which is a chore,
// not a feature. So the ratio lives in exactly one place -- the
// `--sbs-ratio` custom property on #main-pane -- and every .diff-sidebyside
// block's columns are sized from it in CSS (see the matching block in
// style.css). One drag therefore moves every change point at once for free:
// a pointermove writes ONE property on ONE element and the style engine
// does the rest. Nothing here walks the DOM per change point during a drag,
// deliberately -- per-element work on every pointermove is exactly the cost
// that scales with change-point count and turns a 40-hunk file into a
// stutter (and this app already has one unexplained freeze report from a
// large real-world repo; see diag.js).
//
// The one thing that genuinely is per-element -- each splitter's
// aria-valuenow -- is therefore NOT updated on every move. During a drag
// only the splitter actually being dragged (the one assistive tech is
// following) is updated, O(1); the rest are resynced once at commit time
// (pointerup / keyup / reset), a single bounded pass that never runs inside
// the move loop.
//
// -- Why a splitter per block rather than one global control ---------------
// A .diff-sidebyside block is built per render segment (gap context and
// diff lines are separate blocks, see buildSegments), and each one already
// draws its own divider between the columns. Making that divider itself
// draggable is the affordance the screenshot shows and users expect -- you
// grab the line you can see. They all drive the same single value, so which
// one you grab does not matter. All interaction is bound with ONE delegated
// listener per event type on `document`, never listeners per splitter: the
// splitter count follows the change-point count, and so would the listener
// count.
//
// -- Scrolling is untouched -------------------------------------------------
// The two columns' horizontal scrolling stays synchronised exactly as it
// was: this unit adds no scroll listener, reads no scrollLeft, and changes
// no overflow property. It only changes how wide each column is.
//
// -- Mode switching ---------------------------------------------------------
// Splitters exist only inside buildSideBySideDiff's output, so unified mode
// never builds one -- there is nothing to tear down and nothing that can be
// stranded. The ratio itself lives on #main-pane and in localStorage, both
// untouched by a mode switch, so switching to unified and back restores the
// same split. A drag cannot survive a mode switch either: the only ways to
// switch are the top bar and `1`/`2`, neither reachable while the pointer
// is captured by a splitter.
// ===========================================================================

export const SBS_RATIO_KEY = 'lcr.sbsRatio';
export const SBS_RATIO_DEFAULT = 0.5;

// Clamp -- neither side can be dragged to nothing. 20% of a typical main
// pane is still ~8-10 monospace columns: narrow enough to work as "get out
// of my way", wide enough that the shrunken side stays a recognisable strip
// of code with its gutter, and wide enough that the splitter never ends up
// flush against the pane edge where it would be awkward to grab back.
export const SBS_RATIO_MIN = 0.2;
export const SBS_RATIO_MAX = 0.8;

// Arrow key = 2 percentage points. On a ~1100px content area that is ~22px,
// about three JetBrains Mono 12px characters -- the smallest step that
// reads as an intentional change (1 point is roughly one character and
// feels like nothing happened), while 50% -> 80% takes 15 presses instead
// of 30. Shift raises it to 10 points for coarse moves, Home/End jump
// straight to the clamp bounds, and Enter resets to 50/50 (the keyboard
// twin of the double-click reset). Space is deliberately not handled -- see
// keyboard.js's note on never intercepting it.
const SBS_KEY_STEP = 0.02;
const SBS_KEY_STEP_COARSE = 0.1;

let sbsRatio = SBS_RATIO_DEFAULT;

function clampSbsRatio(ratio) {
  if (!Number.isFinite(ratio)) return SBS_RATIO_DEFAULT;
  return Math.min(SBS_RATIO_MAX, Math.max(SBS_RATIO_MIN, ratio));
}

function sbsAriaValue(ratio) {
  return String(Math.round(ratio * 100));
}

// The whole of "apply the new ratio": one property write on one element.
// Everything that renders from it (every column of every change point)
// follows from that single write.
//
// It goes on #main-pane rather than <html> on purpose. A custom property is
// inherited, so changing it forces a style recalc on every descendant of
// whatever element it is set on -- and on a real diff the sidebar tree is
// by far the biggest descendant count (833 nodes on the file used to
// measure this, against 42 change points). #main-pane is the narrowest
// element that still contains everything that could ever read the ratio
// (#changepoints-root plus the orphan/history appendix appended beside it,
// see ensureOrphansRootEl in comments.js), so scoping it here cuts the
// whole tree pane out of the invalidation for free. Measured on a
// 42-change-point file: ~31ms mean / 62ms worst per drag step on <html>,
// ~26ms mean / 33ms worst here -- same mechanism, half the tail. The
// :root fallback in style.css keeps the columns sane if this ever runs
// before #main-pane exists.
function applySbsRatio(ratio) {
  sbsRatio = ratio;
  mainPaneEl.style.setProperty('--sbs-ratio', String(ratio));
}

// Called when a gesture ENDS, not while it runs: persist, and bring every
// other splitter's aria-valuenow back in line with the value they are all
// already rendering at.
function commitSbsRatio() {
  try {
    localStorage.setItem(SBS_RATIO_KEY, String(sbsRatio));
  } catch {
    // storage unavailable -- the ratio still works for this session
  }
  const value = sbsAriaValue(sbsRatio);
  for (const el of document.querySelectorAll('.diff-splitter')) {
    el.setAttribute('aria-valuenow', value);
  }
}

// Restored at module load (before any diff renders) rather than from an
// init() call, so the first side-by-side paint is already at the saved
// ratio -- no 50/50 flash. A malformed or out-of-range stored value falls
// back to the default rather than throwing or wedging a column shut.
function restoreSbsRatio() {
  let stored = null;
  try {
    stored = localStorage.getItem(SBS_RATIO_KEY);
  } catch {
    stored = null;
  }
  const parsed = stored == null ? NaN : Number.parseFloat(stored);
  applySbsRatio(Number.isFinite(parsed) ? clampSbsRatio(parsed) : SBS_RATIO_DEFAULT);
}
restoreSbsRatio();

function buildSplitter() {
  const el = createEl('div', { className: 'diff-splitter' });
  // role="separator" plus a tab stop is the standard focusable window
  // splitter: assistive tech announces an adjustable separator with a
  // value. aria-orientation is "vertical" because the separator itself is
  // vertical (it divides left from right), per the ARIA window-splitter
  // pattern -- not because the movement is horizontal.
  el.setAttribute('role', 'separator');
  el.setAttribute('aria-orientation', 'vertical');
  el.setAttribute('aria-label', '左右欄寬');
  el.setAttribute('aria-valuemin', sbsAriaValue(SBS_RATIO_MIN));
  el.setAttribute('aria-valuemax', sbsAriaValue(SBS_RATIO_MAX));
  el.setAttribute('aria-valuenow', sbsAriaValue(sbsRatio));
  el.tabIndex = 0;
  el.title = '拖曳調整左右欄寬；雙擊還原 50/50（方向鍵微調，Shift 加大）';
  return el;
}

// Drag state. `originX` and `usableWidth` are measured ONCE at pointerdown
// and reused for the whole gesture: the container's own width does not
// change while dragging (only how its children divide it), so re-reading
// getBoundingClientRect() on every move would be a forced synchronous
// layout for a number that cannot have changed -- the same precaution
// nav.js takes in its scroll path.
let sbsDrag = null;

function splitterFromEvent(e) {
  const target = e.target;
  if (!target || typeof target.closest !== 'function') return null;
  return target.closest('.diff-splitter');
}

document.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  const el = splitterFromEvent(e);
  if (!el) return;

  const container = el.parentElement;
  if (!container) return;
  const rect = container.getBoundingClientRect();
  const splitterWidth = el.offsetWidth;
  const usableWidth = rect.width - splitterWidth;
  if (usableWidth <= 0) return;

  // The splitter's own width sits between the columns, so the ratio the
  // pointer expresses is measured against the splitter's CENTRE: the left
  // column is usableWidth * ratio wide, putting the centre at
  // usableWidth * ratio + splitterWidth / 2 from the container's left edge.
  sbsDrag = { el, originX: rect.left + splitterWidth / 2, usableWidth };
  el.classList.add('dragging');
  document.body.classList.add('sbs-dragging');
  // Capture keeps the gesture attached to this splitter once the pointer
  // leaves the 7px strip, which it does immediately. It can legitimately
  // fail (setPointerCapture throws NotFoundError if the browser no longer
  // tracks this pointer id), and an uncaught throw here would abort the
  // handler *after* sbsDrag was set -- leaving a drag running with no
  // .dragging class and no way to see it. The document-level
  // pointermove/pointerup listeners below work with or without capture, so
  // losing it costs nothing except the drag ending early if the pointer
  // leaves the window.
  try {
    el.setPointerCapture(e.pointerId);
  } catch {
    // no capture -- see above
  }
  // Keep the drag from turning into a text selection of the code either
  // side of it.
  e.preventDefault();
});

document.addEventListener('pointermove', (e) => {
  if (!sbsDrag) return;
  const ratio = clampSbsRatio((e.clientX - sbsDrag.originX) / sbsDrag.usableWidth);
  applySbsRatio(ratio);
  // Only the dragged splitter -- see the block comment above for why the
  // other N-1 wait for commit.
  sbsDrag.el.setAttribute('aria-valuenow', sbsAriaValue(ratio));
});

function endSbsDrag() {
  if (!sbsDrag) return;
  sbsDrag.el.classList.remove('dragging');
  document.body.classList.remove('sbs-dragging');
  sbsDrag = null;
  commitSbsRatio();
}

document.addEventListener('pointerup', endSbsDrag);
document.addEventListener('pointercancel', endSbsDrag);

// Double-click resets to 50/50 -- the standard splitter affordance, and the
// cheapest way out of a drag that landed somewhere unhelpful.
document.addEventListener('dblclick', (e) => {
  if (!splitterFromEvent(e)) return;
  e.preventDefault();
  applySbsRatio(SBS_RATIO_DEFAULT);
  commitSbsRatio();
});

document.addEventListener('keydown', (e) => {
  const el = splitterFromEvent(e);
  if (!el) return;

  const step = e.shiftKey ? SBS_KEY_STEP_COARSE : SBS_KEY_STEP;
  let next;
  switch (e.key) {
    case 'ArrowLeft':
      next = sbsRatio - step;
      break;
    case 'ArrowRight':
      next = sbsRatio + step;
      break;
    case 'Home':
      next = SBS_RATIO_MIN;
      break;
    case 'End':
      next = SBS_RATIO_MAX;
      break;
    case 'Enter':
      next = SBS_RATIO_DEFAULT;
      break;
    default:
      return; // every other key, j/k/x/... included, still reaches keyboard.js
  }

  e.preventDefault();
  const ratio = clampSbsRatio(next);
  applySbsRatio(ratio);
  el.setAttribute('aria-valuenow', sbsAriaValue(ratio));
});

// Auto-repeat fires many keydowns and exactly one keyup, so committing here
// keeps the localStorage write and the full aria resync out of the repeat
// loop, for the same reason pointerup does for a drag.
document.addEventListener('keyup', (e) => {
  if (!splitterFromEvent(e)) return;
  commitSbsRatio();
});

// ===========================================================================
// Expand context above/below a change point -- GET /api/lines, GitHub/GitLab-
// style. Reads like the file itself around each diff block, without turning
// the surrounding unmodified code into checkable/commentable change points:
// everything loaded here lives only in a gap's topLines/bottomLines and is
// spliced into the *rendered* segment list in renderChangePointContent -- it
// never touches changePoint.lines, appState.order, group/file totals, or the
// scroll-spy's observed targets (still one per change point, see
// setupScrollSpy in nav.js). j/k/u/checked-count/progress-rail are therefore
// untouched by construction, not by care taken here.
//
// -- The gap model --------------------------------------------------------
// A "gap" is the unmodified stretch of the file between two things -- not
// owned by either of a change point's above/below sides, but its own object
// with its own state, referenced by whichever change point(s) border it.
// Two kinds exist, and they are NOT symmetric, because their boundaries
// aren't symmetric:
//
//   entry.gapAbove -- the stretch immediately above this change point, down
//     to (exclusive) the previous change point's end, or down to line 1 if
//     there is no previous change point in the file. BOTH edges are known
//     for free the moment the file's tree of change points exists (line 1
//     is always knowable; "the previous change point's end" is either a
//     real neighbor or line 1). That makes the region above the very FIRST
//     change point in a file an entirely ordinary gap in this model, not a
//     special case: makeGap(path, 1, firstChangePoint.newStart - 1) just
//     works, and offers both directions like any other gap. There is
//     exactly one gapAbove per change point (or none, if it sits flush
//     against its predecessor/line 1 with zero lines between).
//
//   entry.gapBelow -- ONLY exists on the last change point in a file (see
//     makeGap's `bottom: null` case, constructed in pane.js). The region
//     below the last change point is fundamentally different: its lower
//     edge is the file's true end, which is NOT knowable without asking the
//     server (GET /api/lines' totalLines) -- unlike gapAbove, there is no
//     free source for it the way line 1 is free. Because that edge is
//     unknown, there is nothing to grow *up from*: only one direction
//     ("top", grow-downward-toward-EOF) is offered, the "expand all"
//     control never appears (there's no true count to promise), and this
//     gap never auto-loads regardless of size (see pane.js's
//     renderChangePointPane) -- a small EOF gap looks identical to a huge
//     one until asked.
//
// Because a gap between two change points is now owned by exactly one of
// them (the LATER one's gapAbove -- see pane.js), and never additionally by
// the earlier one's "below" (that field no longer exists for any change
// point except the file's last), the exact same [start..end] range can
// never be requested from two places: there is only one place that holds
// the state and only one place that renders it. This is what the previous
// design's "only the first change point in a file gets an above side"
// carve-out was working around from the other end -- solved here by
// removing the second owner instead of disabling one of the two directions
// a user might want from the surviving owner.
//
// -- Growth directions within one gap --------------------------------------
// A bounded gap (gapAbove) tracks two independently-growable loaded
// stretches that grow toward each other:
//   topLines / topLoaded    -- grown from `top` downward (the "↓" button).
//   bottomLines / bottomLoaded -- grown from `bottom` upward (the "↑"
//                                 button) -- this is what lets a user
//                                 expand upward from a change point and see
//                                 the N lines immediately above it, without
//                                 first walking through the whole gap from
//                                 its top edge.
// gapRemaining() is the count of lines strictly between the two frontiers;
// 0 (or less) means they have met and the gap is fully loaded -- at that
// point buildSegments() stops emitting a control-row segment for it at all
// (see there), so "the controls disappear when the gap is full" falls out
// of the same remaining-count check that decides the button labels, not a
// separate "done" flag that could disagree with it.
//
// A gap only ever has ONE fetch in flight at a time (see runGapExpand's
// `gap.loading` guard, checked before either direction's button can fire
// another one) -- not per-direction, deliberately: a bounded gap's request
// ranges are computed from topLoaded/bottomLoaded at the moment the request
// is built (computeGapRange), and if both directions could be in flight
// concurrently, a gap with less than 2*EXPAND_STEP lines remaining could
// have both requests computed from the *same* stale frontier and overlap
// (confirmed by hand: a 25-line gap, both directions clicked before either
// resolves, both compute a 20-line request off the untouched
// topLoaded/bottomLoaded -- 15 lines requested twice). Serializing the
// whole gap behind one `loading` flag removes that race by construction,
// the same way single ownership removes the two-change-points-race by
// construction above.
//
// gapBelow (the EOF case) reuses this same request/apply machinery with
// `direction: 'top'` only -- there is no 'bottom' direction possible
// without a known lower edge -- so it shares runGapExpand/computeGapRange/
// applyGapResult rather than needing a parallel single-direction copy of
// them.
//
// Three lines still control the whole feature, same as before:
//   EXPAND_STEP            -- lines the *primary* button reveals per click,
//                            GitHub/GitLab-style. Previously the primary
//                            button revealed the *entire* remaining gap in
//                            one click (e.g. "Show 588 lines below"), which
//                            weighed the costs wrong: a few extra clicks are
//                            cheap, while 588 lines landing at once shoves
//                            whatever the user was reading off screen, and
//                            scrolling back to find it is far more annoying
//                            than clicking twice more. A fixed 20-line step
//                            keeps each click's blast radius small.
//   EXPAND_REQUEST_CAP    -- max lines pulled in one request (mirrors the
//                            server's own MAX_LINES_PER_REQUEST). Both the
//                            step-sized primary buttons and the "expand
//                            all" secondary control clamp to this, so
//                            "expand all" on a gap wider than 2000 lines
//                            still needs repeat clicks, each pulling
//                            another 2000-line chunk until the gap is
//                            exhausted.
//   EXPAND_AUTO_THRESHOLD -- gapAbove gaps this small or smaller (to a
//                            neighboring change point, or to the top of the
//                            file) load immediately with no button at all,
//                            because a handful of lines is not worth a
//                            click (brief: "collapsing a three-line gap
//                            behind a click is worse than just showing
//                            it"). 8 is double GitHub's own 3-line default
//                            merge context -- enough to absorb the common
//                            one-or-two-line gap between adjacent hunks
//                            with room to spare, without silently
//                            pre-loading anything a user would call "a real
//                            expand". gapBelow (EOF) is deliberately
//                            excluded from auto-load regardless of size --
//                            see its comment above: the size isn't knowable
//                            without asking, so there's nothing to compare
//                            against the threshold.
export const EXPAND_STEP = 20;
export const EXPAND_REQUEST_CAP = 2000;
export const EXPAND_AUTO_THRESHOLD = 8;

// -- Where each control sits (ui-expand-layout unit) ------------------------
// The complaint this addresses: "上下20會放在一起，這樣很不直覺" -- both
// directional buttons used to render together in the middle of the gap, so
// reading which one did what meant reading the arrow glyph, not the
// position. Position now carries the meaning instead:
//
//   [change point A]
//   [↓ 20 行]          <- flush under A: grows gapAbove.topLines downward
//        (全部, if room)
//   [↑ 20 行]          <- flush above B: grows gapAbove.bottomLines upward
//   [change point B]
//
// buildGapAboveSegments() below returns up to three elements keyed by where
// they go -- `down` (right after whatever gapAbove.topLines is already
// loaded), `mid` (between the two), and `up` (right before whatever
// gapAbove.bottomLines is already loaded) -- and buildSegments() (above)
// splices them into exactly those slots. Because the slot is recomputed
// from gap.topLines/gap.bottomLines on every render, a partial expansion
// naturally moves each control to the new boundary it now operates on --
// there is no separately-tracked "where did I draw this button last time"
// to fall out of sync.
//
// "全部（N 行）" is direction-agnostic (it doesn't grow one frontier over the
// other, it just fills whatever is left), so it belongs at `mid` -- between
// the two directional controls it complements, not glued to either one.
// Below EXPAND_STEP remaining, though, `down` and `up` would produce the
// *identical* visible result (a click on either fully closes the gap, see
// runGapExpand/computeGapRange's request math), so showing two buttons
// that do the same thing is worse than showing one: buildGapAboveSegments
// collapses to a single `mid` control at that point, and it keeps the
// "全部（N 行）" wording (never "剩 N 行" split across two redundant
// buttons) since that is exactly what it does. This reuses EXPAND_STEP
// (20) as the threshold rather than inventing a second magic number -- it
// is already the exact point past which one directional click empties the
// gap, which is the real reason two directional buttons stop making sense.
//
// A 9-19 line gap (the smallest that ever reaches this code -- 8 and under
// auto-load, see EXPAND_AUTO_THRESHOLD) therefore draws exactly one control
// row, never two stacked ones: two ~29px chrome bars around a 9-line gap
// would rival or dwarf the content they are hiding, on top of offering a
// meaningless choice. The EOF gapBelow row is untouched by any of this: it
// only ever had one direction and already rendered flush under the change
// point it belongs to (there is nothing above it to be "flush against"
// instead), so its layout was never the problem this addresses.

// Builds a gap's state, or null if there is no gap (the two edges are flush
// -- e.g. a change point starting at line 1, or two change points with no
// unmodified line between them). `bottom` is null for the one unbounded
// case, the EOF gap below a file's last change point -- see the block
// comment above for why that one can't be treated like an ordinary bounded
// gap.
export function makeGap(filePath, top, bottom) {
  if (bottom != null && bottom - top + 1 <= 0) return null;
  return {
    filePath,
    top,
    bottom, // null => unbounded (EOF); otherwise the fixed last line of this gap
    topLoaded: top - 1, // highest line loaded growing down from `top`; top-1 = none yet
    bottomLoaded: bottom != null ? bottom + 1 : null, // lowest line loaded growing up from `bottom`; bottom+1 = none yet. Stays null for the EOF case -- there is no bottom edge to grow up from.
    topLines: [], // ascending, appended as the "↓" direction grows
    bottomLines: [], // ascending, prepended as the "↑" direction grows
    eofReached: false, // only meaningful when bottom === null: true once a fetch confirms there is nothing left past topLoaded
    loading: false, // true while ANY fetch for this gap (either direction) is in flight -- see the serialization note above
    error: null,
    pendingDirection: null, // 'top' | 'bottom' -- which direction the in-flight/last-failed fetch was, so retry repeats it rather than guessing
    pendingWanted: null, // lines requested by that fetch, so a retry after an error repeats the same-sized request (see the retry button below)
  };
}

// How many lines are still unloaded between the two frontiers of a gap.
// <= 0 means they've met (or the EOF gap has confirmed it hit the true end)
// -- fully loaded, no control row left to show. For the EOF gap (bottom ===
// null), the true remaining count is unknowable until eofReached, so this
// returns Infinity (not 0, not a guess) until then -- callers only ever
// compare it against 0 or EXPAND_STEP, both of which Infinity compares
// correctly against without needing a special case at every call site.
function gapRemaining(gap) {
  if (gap.bottom == null) return gap.eofReached ? 0 : Infinity;
  return gap.bottomLoaded - gap.topLoaded - 1;
}

// GET /api/lines returns { n, text } pairs -- n is the target-ref line
// number, which is all an expansion request can honestly claim. It is NOT
// converted into an oldLine guess: the old/new line numbers only stay in
// lockstep while no diff activity has occurred, and re-deriving that offset
// from unrelated hunk data risks being *wrong* rather than merely absent --
// exactly the failure mode the brief warns is worse than showing nothing.
// So expanded rows show a populated "new" gutter and a blank "old" gutter,
// same as any other line this app can't attribute an old-side number to.
function toContextLine(line) {
  return { type: ' ', oldLine: null, newLine: line.n, text: line.text };
}

// Range to request for one direction of one gap. `wanted` is how many lines
// this particular click is asking for -- EXPAND_STEP for a primary button,
// the true remaining count for "expand all" (see buildGapAboveSegments) -- and
// is always further clamped to EXPAND_REQUEST_CAP (the server rejects
// anything larger, see MAX_LINES_PER_REQUEST in server.js) and to the
// opposite frontier, so a request can never cross into lines the other
// direction (or the gap's own fixed boundary) already owns.
function computeGapRange(gap, direction, wanted) {
  const size = Math.min(wanted, EXPAND_REQUEST_CAP);
  if (direction === 'top') {
    const requestStart = gap.topLoaded + 1;
    const requestEnd =
      gap.bottom != null
        ? Math.min(gap.bottomLoaded - 1, gap.topLoaded + size)
        : gap.topLoaded + size; // unbounded: server clamps to totalLines
    return { requestStart, requestEnd };
  }
  // direction === 'bottom' -- only ever called on a gap with a known
  // `bottom` (gapAbove); gapBelow's control row never offers this
  // direction in the first place.
  const requestEnd = gap.bottomLoaded - 1;
  const requestStart = Math.max(gap.topLoaded + 1, gap.bottomLoaded - size);
  return { requestStart, requestEnd };
}

// Merges a successful GET /api/lines response into a gap. Filters to only
// genuinely new lines (rather than trusting the request bounds blindly)
// specifically to guard the EOF case: a gapBelow whose topLoaded already
// *is* the last line of the file has no lines left below it, but asking for
// "topLoaded+1 .. topLoaded+2000" against a file that short still gets a
// 200 back (the server clamps start down to totalLines rather than
// rejecting -- see /api/lines' clamping contract), which would otherwise
// silently re-append the last line as a duplicate and leave the button
// clickable forever. Filtering by n and checking for zero new lines catches
// that instead of trusting the response's own start/end -- and for a
// bounded gapAbove, the same filter (now bounded on both sides) is what
// keeps a request that raced past the opposite frontier from ever
// re-appending a line the other direction already claimed.
function applyGapResult(gap, direction, data) {
  if (direction === 'top') {
    const upperBound = gap.bottom != null ? gap.bottomLoaded - 1 : Infinity;
    const newLines = data.lines.filter((l) => l.n > gap.topLoaded && l.n <= upperBound).map(toContextLine);
    if (newLines.length === 0) {
      if (gap.bottom == null) gap.eofReached = true; // EOF gap: nothing past topLoaded => the true end of the file
      return;
    }
    gap.topLines = gap.topLines.concat(newLines);
    gap.topLoaded = newLines[newLines.length - 1].newLine;
    if (gap.bottom == null && data.totalLines <= gap.topLoaded) gap.eofReached = true;
    return;
  }

  // direction === 'bottom'
  const newLines = data.lines.filter((l) => l.n < gap.bottomLoaded && l.n > gap.topLoaded).map(toContextLine);
  if (newLines.length === 0) return; // defensive; shouldn't happen for a gap with remaining > 0
  gap.bottomLines = newLines.concat(gap.bottomLines);
  gap.bottomLoaded = newLines[0].newLine;
}

// Fires a GET /api/lines for one direction of one gap and re-renders this
// gap's owning change point's content in place at each state change (start
// loading, success, error) -- the same "no refetch, no scroll reset"
// discipline as onToggleCheck/saveComment elsewhere in this app, just
// scoped to a single change point's content instead of the tree. ref is
// read live from appState.target (the diff's target -- see api.getLines'
// own comment for why base would be wrong) rather than frozen at
// gap-creation time, same as every other API call. A gap only survives
// until the next tree rebuild anyway (renderTree in tree.js clears
// dom.changePoints).
//
// `wanted` is how many lines this click asked for -- defaults to
// EXPAND_REQUEST_CAP for the auto-load call site in pane.js's
// renderChangePoint (small gaps only, always well under the cap either
// way) and is passed explicitly by buildGapAboveSegments/buildGapBelowRow's
// primary/all/retry buttons. It is only a request, not a promise:
// computeGapRange still clamps it to EXPAND_REQUEST_CAP and to the
// opposite frontier, and applyGapResult still filters the response down to
// genuinely new lines, so a `wanted` larger than what is actually left
// (e.g. clicking primary with 7 lines remaining) terminates the gap
// correctly rather than overshooting.
export async function runGapExpand(entry, gap, direction, wanted = EXPAND_REQUEST_CAP) {
  if (gap.loading || gapRemaining(gap) <= 0) return;

  gap.loading = true;
  gap.error = null;
  gap.pendingDirection = direction;
  gap.pendingWanted = wanted;
  renderChangePointContent(entry);

  try {
    const { requestStart, requestEnd } = computeGapRange(gap, direction, wanted);
    const data = await api.getLines(appState.repo, appState.target, gap.filePath, requestStart, requestEnd);
    applyGapResult(gap, direction, data);
  } catch (err) {
    gap.error = err.message;
  } finally {
    gap.loading = false;
    renderChangePointContent(entry);
  }
}

// A full-width chrome bar wrapping one primary button -- the shape shared
// by every directional control (down, up, the small-gap combined control,
// and gapBelow's single button).
function buildPrimaryRow(extraClass, label, onClick) {
  const row = createEl('div', { className: `diff-expand-row ${extraClass}` });
  const controls = createEl('div', { className: 'diff-expand-controls' });
  const btn = createEl('button', { className: 'diff-expand-btn diff-expand-btn-primary', text: label });
  btn.type = 'button';
  btn.addEventListener('click', onClick);
  controls.appendChild(btn);
  row.appendChild(controls);
  return row;
}

// Loading/error states are transient and gap-wide (only one fetch is ever
// in flight for a gap, see gap.loading's block comment above), so both
// render at `mid` regardless of which direction is actually pending --
// there is no stable "which edge is this for" to point at while it's still
// in flight, and the buttons themselves simply disappear for the moment
// instead of claiming to still be clickable.
function buildLoadingRow(extraClass) {
  const row = createEl('div', { className: `diff-expand-row loading${extraClass ? ` ${extraClass}` : ''}` });
  row.appendChild(createEl('span', { className: 'diff-expand-status', text: '載入中…' }));
  return row;
}

function buildErrorRow(entry, gap, direction, extraClass) {
  const row = createEl('div', { className: `diff-expand-row error${extraClass ? ` ${extraClass}` : ''}` });
  row.appendChild(createEl('span', { className: 'diff-expand-status diff-expand-error', text: gap.error }));
  const retryBtn = createEl('button', { className: 'diff-expand-btn diff-expand-btn-primary', text: '重試' });
  retryBtn.type = 'button';
  retryBtn.addEventListener('click', () =>
    runGapExpand(entry, gap, direction, gap.pendingWanted ?? EXPAND_REQUEST_CAP),
  );
  row.appendChild(retryBtn);
  return row;
}

// Builds the up-to-three control elements for the gap immediately above a
// change point, keyed by the slot buildSegments() should splice each one
// into (`down` / `mid` / `up` -- see the block comment above EXPAND_STEP).
// Returns null if there is nothing to show at all (no gap, or already
// fully loaded -- see gapRemaining).
function buildGapAboveSegments(entry) {
  const gap = entry.gapAbove;
  if (!gap || gapRemaining(gap) <= 0) return null;

  if (gap.loading) return { mid: buildLoadingRow() };
  if (gap.error) return { mid: buildErrorRow(entry, gap, gap.pendingDirection ?? 'top') };

  const remaining = gapRemaining(gap);

  // Below EXPAND_STEP remaining, a click on EITHER direction requests
  // exactly `remaining` lines and closes the gap -- same visible result
  // either way (see runGapExpand/computeGapRange). Two buttons offering an
  // identical outcome is a false choice, and two ~29px chrome bars around
  // as few as 9 remaining lines would rival the content they hide (see the
  // block comment above). One direction-agnostic control instead, still
  // showing the real remainder rather than promising EXPAND_STEP.
  if (remaining < EXPAND_STEP) {
    return {
      mid: buildPrimaryRow('diff-expand-combined', `全部（${remaining} 行）`, () =>
        runGapExpand(entry, gap, 'top', remaining),
      ),
    };
  }

  const down = buildPrimaryRow('diff-expand-down', `↓ ${EXPAND_STEP} 行`, () =>
    runGapExpand(entry, gap, 'top', EXPAND_STEP),
  );
  const up = buildPrimaryRow('diff-expand-up', `↑ ${EXPAND_STEP} 行`, () =>
    runGapExpand(entry, gap, 'bottom', EXPAND_STEP),
  );

  // "全部" is direction-agnostic (fills whatever is left, in
  // EXPAND_REQUEST_CAP chunks if needed, rather than growing one frontier
  // over the other) -- it belongs between the two directional controls it
  // complements, not glued to either one. Styled subtler than the
  // directional buttons (see .diff-expand-mid / .diff-expand-btn-all) so it
  // reads as "also available" rather than competing with them.
  const mid = createEl('div', { className: 'diff-expand-mid' });
  const allBtn = createEl('button', {
    className: 'diff-expand-btn diff-expand-btn-all',
    text: `全部（${remaining} 行）`,
  });
  allBtn.type = 'button';
  allBtn.addEventListener('click', () => runGapExpand(entry, gap, 'top', remaining));
  mid.appendChild(allBtn);

  return { down, mid, up };
}

// Builds the control row for the EOF gap below a file's last change point,
// or returns null if there is nothing to show (not the last change point,
// or the gap already reached end-of-file). Same three states as
// buildGapAboveSegments, but only ever the single "↓" direction, and it was
// already flush against the change point it belongs to before this unit --
// see the gapBelow block comment above for why: the lower edge isn't
// knowable without asking, so there is no count to show, no "expand all" to
// offer, and nothing on the far side to be flush against instead.
function buildGapBelowRow(entry) {
  const gap = entry.gapBelow;
  if (!gap || gapRemaining(gap) <= 0) return null;

  if (gap.loading) return buildLoadingRow('diff-expand-below');
  if (gap.error) return buildErrorRow(entry, gap, 'top', 'diff-expand-below');

  return buildPrimaryRow('diff-expand-below', `↓ ${EXPAND_STEP} 行`, () =>
    runGapExpand(entry, gap, 'top', EXPAND_STEP),
  );
}
