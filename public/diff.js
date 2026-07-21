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
// buildGapAboveRow/buildGapBelowRow) -- each direction needs the other,
// which is exactly the "two modules import each other" cycle the brief
// calls out as a sign the seam is in the wrong place. Kept together here
// instead: one coherent responsibility ("how a change point's body renders,
// including pulling in more of the file around it"), no cycle.

import { appState, createEl } from './state.js';
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
};

// Resolves a Prism language name for a file path, or null if the extension
// is unknown or the vendored Prism bundle doesn't have that grammar loaded.
// Callers must treat null as "render as plain text" -- never throw.
function getPrismLanguage(filePath) {
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
// loaded gap-above context, the gap-above control row (if that gap still
// has unloaded lines), the change point's own diff lines, then any loaded
// gap-below context and its control row. Adjacent `lines` segments are
// merged into one array before rendering so a fully-loaded gap (or a gap
// whose control row has already disappeared on one side) reads as a single
// seamless diff block -- exactly like the change point's own lines always
// have -- instead of an arbitrary seam wherever this function happened to
// push a new array.
function buildSegments(entry) {
  const { changePoint, gapAbove, gapBelow } = entry;
  const raw = [];

  if (gapAbove) {
    if (gapAbove.topLines.length) raw.push({ type: 'lines', lines: gapAbove.topLines });
    if (gapRemaining(gapAbove) > 0) raw.push({ type: 'gapAbove' });
    if (gapAbove.bottomLines.length) raw.push({ type: 'lines', lines: gapAbove.bottomLines });
  }

  raw.push({ type: 'lines', lines: changePoint.lines });

  if (gapBelow) {
    if (gapBelow.topLines.length) raw.push({ type: 'lines', lines: gapBelow.topLines });
    if (gapRemaining(gapBelow) > 0) raw.push({ type: 'gapBelow' });
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

export function renderChangePointContent(entry) {
  const { changePoint, contentEl } = entry;
  contentEl.textContent = '';

  const lang = getPrismLanguage(changePoint.filePath);
  const segments = buildSegments(entry);

  const body = createEl('div', { className: 'diff-body' });
  for (const segment of segments) {
    if (segment.type === 'lines') {
      body.appendChild(
        appState.viewMode === 'side-by-side'
          ? buildSideBySideDiff(segment.lines, lang)
          : buildUnifiedDiff(segment.lines, lang),
      );
    } else if (segment.type === 'gapAbove') {
      body.appendChild(buildGapAboveRow(entry));
    } else {
      body.appendChild(buildGapBelowRow(entry));
    }
  }

  contentEl.appendChild(body);
}

// ---------------------------------------------------------------------------
// Unified: one row per line, old-line# | new-line# | marker | code.
// ---------------------------------------------------------------------------

// Renamed from renderUnified(changePoint, contentEl): now takes one segment
// of the combined [...gap-above lines, ...diff lines, ...gap-below lines]
// render and returns the element instead of appending it directly, so the
// caller can place gap control rows between segments.
function buildUnifiedDiff(lines, lang) {
  const container = createEl('div', { className: 'diff-unified' });
  for (const line of lines) {
    container.appendChild(buildUnifiedRow(line, lang));
  }
  return container;
}

function buildUnifiedRow(line, lang) {
  const row = createEl('div', { className: `diff-row diff-row-${diffRowTypeClass(line.type)}` });
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

  container.append(leftCol, rightCol);
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
// the true remaining count for "expand all" (see buildGapAboveRow) -- and
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
// way) and is passed explicitly by buildGapAboveRow/buildGapBelowRow's
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

// Builds the control row for the gap immediately above a change point, or
// returns null if there is nothing to show (no gap at all, or it's already
// fully loaded -- see gapRemaining). Three mutually exclusive states:
// loading / error (with retry) / a real button row.
//
// The button row shows BOTH directions at once, in Traditional Chinese to
// match the rest of the UI (footer hint bar, export buttons):
//   "↑ 20 行"  -- grows the bottom-anchored frontier upward, revealing the
//                 lines immediately above the change point first. This is
//                 the direction the previous single-owner design couldn't
//                 offer on anything but the first change point in a file.
//   "↓ 20 行"  -- grows the top-anchored frontier downward, revealing the
//                 lines immediately below the previous change point (or
//                 below line 1) first.
//   "全部（58 行）" -- fills the whole remaining gap (in EXPAND_REQUEST_CAP
//                 chunks if needed), dropped once remaining < EXPAND_STEP
//                 because either directional button already clears the
//                 whole gap in one click at that point.
// When remaining < EXPAND_STEP, both directional buttons show the true
// remainder instead of promising 20 (e.g. "↑ 剩 7 行"), independently for
// each direction, since either one might be the one the user reaches for.
function buildGapAboveRow(entry) {
  const gap = entry.gapAbove;
  if (!gap || gapRemaining(gap) <= 0) return null;

  const row = createEl('div', { className: 'diff-expand-row diff-expand-above' });

  if (gap.loading) {
    row.classList.add('loading');
    row.appendChild(createEl('span', { className: 'diff-expand-status', text: '載入中…' }));
    return row;
  }

  if (gap.error) {
    row.classList.add('error');
    row.appendChild(createEl('span', { className: 'diff-expand-status diff-expand-error', text: gap.error }));
    const retryBtn = createEl('button', { className: 'diff-expand-btn diff-expand-btn-primary', text: '重試' });
    retryBtn.type = 'button';
    retryBtn.addEventListener('click', () =>
      runGapExpand(entry, gap, gap.pendingDirection, gap.pendingWanted ?? EXPAND_REQUEST_CAP),
    );
    row.appendChild(retryBtn);
    return row;
  }

  const remaining = gapRemaining(gap);
  const controls = createEl('div', { className: 'diff-expand-controls' });

  const upBtn = createEl('button', {
    className: 'diff-expand-btn diff-expand-btn-primary',
    text: remaining < EXPAND_STEP ? `↑ 剩 ${remaining} 行` : `↑ ${EXPAND_STEP} 行`,
  });
  upBtn.type = 'button';
  upBtn.addEventListener('click', () => runGapExpand(entry, gap, 'bottom', Math.min(EXPAND_STEP, remaining)));

  const downBtn = createEl('button', {
    className: 'diff-expand-btn diff-expand-btn-primary',
    text: remaining < EXPAND_STEP ? `↓ 剩 ${remaining} 行` : `↓ ${EXPAND_STEP} 行`,
  });
  downBtn.type = 'button';
  downBtn.addEventListener('click', () => runGapExpand(entry, gap, 'top', Math.min(EXPAND_STEP, remaining)));

  controls.append(upBtn, downBtn);

  if (remaining >= EXPAND_STEP) {
    const allBtn = createEl('button', {
      className: 'diff-expand-btn diff-expand-btn-all',
      text: `全部（${remaining} 行）`,
    });
    allBtn.type = 'button';
    allBtn.addEventListener('click', () => runGapExpand(entry, gap, 'top', remaining));
    controls.appendChild(allBtn);
  }

  row.appendChild(controls);
  return row;
}

// Builds the control row for the EOF gap below a file's last change point,
// or returns null if there is nothing to show (not the last change point,
// or the gap already reached end-of-file). Same three states as
// buildGapAboveRow, but only ever the single "↓" direction -- see the
// gapBelow block comment above for why: the lower edge isn't knowable
// without asking, so there is no count to show and no "expand all" to
// offer, same as the original design's belowLimit === null branch.
function buildGapBelowRow(entry) {
  const gap = entry.gapBelow;
  if (!gap || gapRemaining(gap) <= 0) return null;

  const row = createEl('div', { className: 'diff-expand-row diff-expand-below' });

  if (gap.loading) {
    row.classList.add('loading');
    row.appendChild(createEl('span', { className: 'diff-expand-status', text: '載入中…' }));
    return row;
  }

  if (gap.error) {
    row.classList.add('error');
    row.appendChild(createEl('span', { className: 'diff-expand-status diff-expand-error', text: gap.error }));
    const retryBtn = createEl('button', { className: 'diff-expand-btn diff-expand-btn-primary', text: '重試' });
    retryBtn.type = 'button';
    retryBtn.addEventListener('click', () =>
      runGapExpand(entry, gap, 'top', gap.pendingWanted ?? EXPAND_REQUEST_CAP),
    );
    row.appendChild(retryBtn);
    return row;
  }

  const controls = createEl('div', { className: 'diff-expand-controls' });
  const primaryBtn = createEl('button', {
    className: 'diff-expand-btn diff-expand-btn-primary',
    text: `↓ ${EXPAND_STEP} 行`,
  });
  primaryBtn.type = 'button';
  primaryBtn.addEventListener('click', () => runGapExpand(entry, gap, 'top', EXPAND_STEP));
  controls.appendChild(primaryBtn);
  row.appendChild(controls);
  return row;
}
