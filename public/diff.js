// diff.js -- render a single change point's content area (diff lines, Prism
// highlighting, unified/side-by-side layout) and its on-demand context
// expansion above/below. Split out of app.js as a pure move (see state.js's
// header comment).
//
// These two concerns (content rendering, expand-context) were split into
// separate files (diff.js / expand.js) in the brief's suggested table, but
// runExpand() re-renders a change point's content in place after a fetch
// (calling straight back into renderChangePointContent), and
// renderChangePointContent() builds the expand-above/below button row
// (calling into buildExpandRow) -- each direction needs the other, which is
// exactly the "two modules import each other" cycle the brief calls out as
// a sign the seam is in the wrong place. Kept together here instead: one
// coherent responsibility ("how a change point's body renders, including
// pulling in more of the file around it"), no cycle.

import { appState, createEl } from './state.js';
import { api } from './api.js';

// ===========================================================================
// EXTENSION POINT 1 -- render a single change point's content area.
//
// Reads appState.viewMode to pick unified vs. side-by-side. Signature
// changed by the ui-expand-context unit: (entry) -> void, reading
// entry.contentEl (already appended to the DOM) and entry.expand (the
// per-change-point expand-above/below state added below). It used to be
// (changePoint, contentEl) -- widened to the whole dom.changePoints entry
// because expansion needs entry.expand, which only exists per-entry, not on
// the changePoint object itself (that object is shared with server state,
// see the comment on the next block, and must not gain ad-hoc UI fields).
// Called from pane.js's renderChangePoint() (initial render), topbar.js's
// setViewMode() (re-render in place on mode switch), and runExpand() below
// (re-render in place after an expand-above/below fetch starts/finishes) --
// never a refetch, never a scroll reset, in all three cases.
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

export function renderChangePointContent(entry) {
  const { changePoint, contentEl, expand } = entry;
  contentEl.textContent = '';

  const lang = getPrismLanguage(changePoint.filePath);
  // Loaded context is just more Line-like objects, spliced in ahead of/
  // behind the diff's own lines -- everything downstream (pairing for
  // side-by-side, row building, Prism highlighting) treats them exactly
  // like the lines the diff itself produced. This is what keeps expanded
  // context lined up column-for-column with the diff rows around it: it is
  // the *same* row-building code, not a lookalike.
  const allLines = [...expand.aboveLines, ...changePoint.lines, ...expand.belowLines];

  const body = createEl('div', { className: 'diff-body' });
  const aboveRow = buildExpandRow(entry, 'above');
  if (aboveRow) body.appendChild(aboveRow);

  if (appState.viewMode === 'side-by-side') {
    body.appendChild(buildSideBySideDiff(allLines, lang));
  } else {
    body.appendChild(buildUnifiedDiff(allLines, lang));
  }

  const belowRow = buildExpandRow(entry, 'below');
  if (belowRow) body.appendChild(belowRow);

  contentEl.appendChild(body);
}

// ---------------------------------------------------------------------------
// Unified: one row per line, old-line# | new-line# | marker | code.
// ---------------------------------------------------------------------------

// Renamed from renderUnified(changePoint, contentEl): now takes the combined
// [...context-above, ...diff lines, ...context-below] array built by
// renderChangePointContent and returns the element instead of appending it
// directly, so the caller can place expand-above/below rows around it.
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
// everything loaded here lives only in entry.expand.{above,below}Lines and is
// spliced into the *rendered* line list in renderChangePointContent -- it
// never touches changePoint.lines, appState.order, group/file totals, or the
// scroll-spy's observed targets (still one per change point, see
// setupScrollSpy in nav.js). j/k/u/checked-count/progress-rail are therefore
// untouched by construction, not by care taken here.
//
// Three lines control the whole feature:
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
//                            step-sized primary button and the "expand all"
//                            secondary control clamp to this, so "expand
//                            all" on a gap wider than 2000 lines still
//                            needs repeat clicks, each pulling another
//                            2000-line chunk until the gap is exhausted.
//   EXPAND_AUTO_THRESHOLD -- gaps this small or smaller (to a neighboring
//                            change point, or to the top of the file) render
//                            immediately with no button at all, because a
//                            handful of lines is not worth a click (brief:
//                            "collapsing a three-line gap behind a click is
//                            worse than just showing it"). 8 is double
//                            GitHub's own 3-line default merge context --
//                            enough to absorb the common one-or-two-line
//                            gap between adjacent hunks with room to spare,
//                            without silently pre-loading anything a user
//                            would call "a real expand".
export const EXPAND_STEP = 20;
export const EXPAND_REQUEST_CAP = 2000;
export const EXPAND_AUTO_THRESHOLD = 8;

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

// Range to request for one expand click/auto-load. `wanted` is how many
// lines this particular click is asking for -- EXPAND_STEP for the primary
// button, the true remaining count for the "expand all" button (see
// buildExpandRow) -- and is always further clamped to EXPAND_REQUEST_CAP
// (the server rejects anything larger, see MAX_LINES_PER_REQUEST in
// server.js) and to this change point's aboveLimit/belowLimit so a request
// can never cross into a neighboring change point's own territory.
function computeExpandRange(entry, direction, wanted) {
  const state = entry.expand;
  const size = Math.min(wanted, EXPAND_REQUEST_CAP);
  if (direction === 'above') {
    const requestEnd = state.aboveLoaded - 1;
    const requestStart = Math.max(state.aboveLimit, requestEnd - size + 1);
    return { requestStart, requestEnd };
  }
  const requestStart = state.belowLoaded + 1;
  const requestEnd =
    state.belowLimit != null
      ? Math.min(state.belowLimit, requestStart + size - 1)
      : requestStart + size - 1; // unbounded: server clamps to totalLines
  return { requestStart, requestEnd };
}

// Merges a successful GET /api/lines response into entry.expand. Filters to
// only genuinely new lines (rather than trusting the request bounds blindly)
// specifically to guard the EOF case: a change point whose newEnd already
// *is* the last line of the file has no lines left below it, but asking for
// "belowLoaded+1 .. belowLoaded+2000" against a file that short still gets a
// 200 back (the server clamps start down to totalLines rather than
// rejecting -- see /api/lines' clamping contract), which would otherwise
// silently re-append the last line as a duplicate and leave the button
// clickable forever. Filtering by n and checking for zero new lines catches
// that instead of trusting the response's own start/end.
function applyExpandResult(entry, direction, data) {
  const state = entry.expand;
  if (direction === 'above') {
    const newLines = data.lines.filter((l) => l.n < state.aboveLoaded).map(toContextLine);
    if (newLines.length === 0) {
      state.aboveDone = true;
      return;
    }
    state.aboveLines = [...newLines, ...state.aboveLines];
    state.aboveLoaded = newLines[0].newLine;
    if (state.aboveLoaded <= state.aboveLimit) state.aboveDone = true;
    return;
  }

  const newLines = data.lines.filter((l) => l.n > state.belowLoaded).map(toContextLine);
  if (newLines.length === 0) {
    state.belowDone = true;
    return;
  }
  state.belowLines = [...state.belowLines, ...newLines];
  state.belowLoaded = newLines[newLines.length - 1].newLine;
  if (state.belowLimit != null) {
    if (state.belowLoaded >= state.belowLimit) state.belowDone = true;
  } else if (data.totalLines <= state.belowLoaded) {
    state.belowDone = true; // reached the true end of the file
  }
}

// Fires a GET /api/lines for one direction and re-renders this one change
// point's content in place at each state change (start loading, success,
// error) -- the same "no refetch, no scroll reset" discipline as
// onToggleCheck/saveComment elsewhere in this app, just scoped to a single
// change point's content instead of the tree. ref is read live from
// appState.target (the diff's target -- see api.getLines' own comment for
// why base would be wrong) rather than frozen at entry-creation time, same
// as every other API call. An entry only survives until the next tree
// rebuild anyway (renderTree in tree.js clears dom.changePoints).
//
// `wanted` is how many lines this click asked for -- defaults to
// EXPAND_REQUEST_CAP for the auto-load call sites in pane.js's
// renderChangePoint (small gaps only, always well under the cap either way)
// and is passed explicitly by buildExpandRow's primary/all/retry buttons. It
// is only a request, not a promise: computeExpandRange still clamps it to
// EXPAND_REQUEST_CAP and to aboveLimit/belowLimit, and applyExpandResult
// still filters the response down to genuinely new lines, so a `wanted`
// larger than what is actually left (e.g. clicking primary with 7 lines
// remaining) terminates the gap correctly rather than overshooting.
export async function runExpand(entry, direction, wanted = EXPAND_REQUEST_CAP) {
  const state = entry.expand;
  const loadingKey = direction === 'above' ? 'aboveLoading' : 'belowLoading';
  const doneKey = direction === 'above' ? 'aboveDone' : 'belowDone';
  const errorKey = direction === 'above' ? 'aboveError' : 'belowError';
  const wantedKey = direction === 'above' ? 'aboveWanted' : 'belowWanted';

  if (state[loadingKey] || state[doneKey]) return;

  state[loadingKey] = true;
  state[errorKey] = null;
  state[wantedKey] = wanted;
  renderChangePointContent(entry);

  try {
    const { requestStart, requestEnd } = computeExpandRange(entry, direction, wanted);
    const data = await api.getLines(appState.repo, appState.target, state.filePath, requestStart, requestEnd);
    applyExpandResult(entry, direction, data);
  } catch (err) {
    state[errorKey] = err.message;
  } finally {
    state[loadingKey] = false;
    renderChangePointContent(entry);
  }
}

// Builds the expand-above/below control for one side of one change point, or
// returns null to render nothing on that side (fully expanded already, or
// there was never a gap there to begin with -- e.g. the very first change
// point in a file starting at line 1). Three mutually exclusive states:
// loading / error (with retry) / a real button row.
//
// The button row itself has three shapes, all in Traditional Chinese to
// match the rest of the UI (footer hint bar, export buttons):
//   - remaining unknown (only the "below" side of the last change point in
//     a file before its first fetch, see belowLimit in pane.js's
//     renderChangePoint): just the EXPAND_STEP-sized primary button, e.g.
//     "↓ 20 行" -- there is no true count to show on an "expand all" control
//     yet.
//   - remaining < EXPAND_STEP: primary alone, showing the true remaining
//     count instead of promising 20, e.g. "↑ 剩 7 行" -- a secondary
//     "expand all" control would be redundant (the primary already clears
//     the whole gap in one click) so it is dropped.
//   - remaining >= EXPAND_STEP: primary shows the fixed step, e.g.
//     "↓ 20 行", plus a secondary "全部（588 行）" control on the same row
//     that expands the whole remaining gap (in EXPAND_REQUEST_CAP-sized
//     chunks if it's over the server's per-request cap -- see runExpand).
//     The secondary is visually subordinate (.diff-expand-btn-all in
//     style.css): it's the occasional choice, not the default.
function buildExpandRow(entry, direction) {
  const state = entry.expand;
  const done = direction === 'above' ? state.aboveDone : state.belowDone;
  if (done) return null;

  const loading = direction === 'above' ? state.aboveLoading : state.belowLoading;
  const error = direction === 'above' ? state.aboveError : state.belowError;
  const wanted = direction === 'above' ? state.aboveWanted : state.belowWanted;

  const row = createEl('div', { className: `diff-expand-row diff-expand-${direction}` });

  if (loading) {
    row.classList.add('loading');
    row.appendChild(createEl('span', { className: 'diff-expand-status', text: '載入中…' }));
    return row;
  }

  if (error) {
    row.classList.add('error');
    row.appendChild(createEl('span', { className: 'diff-expand-status diff-expand-error', text: error }));
    const retryBtn = createEl('button', { className: 'diff-expand-btn diff-expand-btn-primary', text: '重試' });
    retryBtn.type = 'button';
    // Reuse whatever size the failed attempt asked for, so a retry doesn't
    // silently turn a 20-line primary click into a much larger request.
    retryBtn.addEventListener('click', () => runExpand(entry, direction, wanted ?? EXPAND_REQUEST_CAP));
    row.appendChild(retryBtn);
    return row;
  }

  const loaded = direction === 'above' ? state.aboveLoaded : state.belowLoaded;
  const limit = direction === 'above' ? state.aboveLimit : state.belowLimit;
  const arrow = direction === 'above' ? '↑' : '↓';

  const controls = createEl('div', { className: 'diff-expand-controls' });

  if (limit == null) {
    // Only reachable for "below" on the last change point in a file: the
    // true distance to end-of-file isn't known until asked (see belowLimit
    // in pane.js's renderChangePoint), so no count -- and no "expand all" --
    // can be shown up front.
    const primaryBtn = createEl('button', {
      className: 'diff-expand-btn diff-expand-btn-primary',
      text: `${arrow} ${EXPAND_STEP} 行`,
    });
    primaryBtn.type = 'button';
    primaryBtn.addEventListener('click', () => runExpand(entry, direction, EXPAND_STEP));
    controls.appendChild(primaryBtn);
    row.appendChild(controls);
    return row;
  }

  const remaining = direction === 'above' ? loaded - limit : limit - loaded;

  if (remaining < EXPAND_STEP) {
    const primaryBtn = createEl('button', {
      className: 'diff-expand-btn diff-expand-btn-primary',
      text: `${arrow} 剩 ${remaining} 行`,
    });
    primaryBtn.type = 'button';
    primaryBtn.addEventListener('click', () => runExpand(entry, direction, remaining));
    controls.appendChild(primaryBtn);
    row.appendChild(controls);
    return row;
  }

  const primaryBtn = createEl('button', {
    className: 'diff-expand-btn diff-expand-btn-primary',
    text: `${arrow} ${EXPAND_STEP} 行`,
  });
  primaryBtn.type = 'button';
  primaryBtn.addEventListener('click', () => runExpand(entry, direction, EXPAND_STEP));

  const allBtn = createEl('button', {
    className: 'diff-expand-btn diff-expand-btn-all',
    text: `全部（${remaining} 行）`,
  });
  allBtn.type = 'button';
  allBtn.addEventListener('click', () => runExpand(entry, direction, remaining));

  controls.append(primaryBtn, allBtn);
  row.appendChild(controls);
  return row;
}
