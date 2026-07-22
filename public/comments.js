// comments.js -- comment + note UI (add/edit/delete per change point) and
// the orphaned-annotation area. Split out of app.js as a pure move (see
// state.js's header comment); notes were added later as a second,
// independent per-change-point annotation living in the same module (see
// EXTENSION POINT 4 below for why they share one DOM wrapper).
//
// Comment vs note, per the brief: a comment means "I'm unsure about this, I
// need it checked" -- it is the whole reason the Claude-prompt export
// exists, so it is the ONLY thing that export includes (see export.js). A
// note means "I understood this, recording it for myself" -- it never
// appears in the Claude prompt, but DOES appear in the Markdown export
// (export.js again), which is the one meant for pasting into Obsidian. They
// are otherwise symmetric: independent add/edit/delete, independent
// persistence (state.js's comments/notes maps, same changePointKey), and a
// change point can have both, either, or neither at once.

import { appState, dom, createEl, mainPaneEl } from './state.js';
import { api, clearError, showError } from './api.js';
import { copyToClipboardWithFeedback } from './export.js';
import { buildUnifiedDiff, getPrismLanguage, registerAnchorUi, renderChangePointContent } from './diff.js';
import { isAnnotationExpanded, setAnnotationExpanded, forgetAnnotationExpanded,
  ORPHAN_CARD_KIND, ORPHAN_SECTION_KIND, ORPHAN_SECTION_KEY } from './prefs.js';

// ===========================================================================
// EXTENSION POINT 4 continued -- comment + note UI, attached to every change
// point via its container's data-key (set by pane.js's renderChangePointPane).
// Called once per file open (see pane.js's renderFilePane), after every one
// of that file's change points exists, so it never has to guess at DOM
// ordering.
//
// One shared outer wrapper (entry.commentEl, a.k.a. ".comment-section")
// holds two independently-rendered children, entry.commentBodyEl and
// entry.noteBodyEl. This is deliberately ONE wrapper, not two -- the common
// case across a large review is a change point with neither a comment nor a
// note, and two separate top-level sections would each show their own
// "+ Comment" / "+ Note" affordance row, doubling the vertical footprint of
// exactly the case that happens most often. With one wrapper and CSS
// flex-wrap (see .comment-section in style.css), two small unexpanded "add"
// buttons naturally sit side by side on a single line; whichever one grows
// into real content (view or edit mode) claims the full row width via
// .annotation-slot-expanded and pushes the other, still-small affordance
// onto its own line below -- so the layout adapts to how many of the two
// are actually in use without any JS coordination between them.
//
// Each of comment and note has its own two mutually exclusive render states
// (view mode / edit mode), and saving always goes through its own endpoint
// (POST /api/comment or POST /api/note) and updates the in-memory
// changePoint + DOM in place -- no refetch of the tree, same as before
// notes existed.
// ===========================================================================

export function renderAllComments() {
  for (const entry of dom.changePoints.values()) {
    if (!entry.rightContainer) continue;
    if (!entry.commentEl) {
      const section = createEl('div', { className: 'comment-section' });
      // Programmatically focusable (tabIndex -1) but not a Tab stop: this is
      // where focus lands after a save/cancel of EITHER the comment or the
      // note editor (see renderCommentView/renderNoteView's focusTrigger
      // below), instead of on whichever Edit/+Comment/+Note button triggered
      // it. Landing on an activatable <button> there means a `space` press
      // right after saving -- exactly the rhythm the brief calls out ("save
      // a comment, then press space to keep reading") -- activates the
      // button and reopens the editor instead of scrolling. A
      // non-interactive container has no activation behavior, so `space`
      // falls through to the browser's native scroll. The individual
      // buttons themselves are untouched and still reachable by tabbing
      // through the document in order.
      section.tabIndex = -1;
      entry.rightContainer.appendChild(section);
      entry.commentEl = section;

      const commentBody = createEl('div', { className: 'annotation-slot annotation-slot-comment' });
      const noteBody = createEl('div', { className: 'annotation-slot annotation-slot-note' });
      section.append(commentBody, noteBody);
      entry.commentBodyEl = commentBody;
      entry.noteBodyEl = noteBody;
    }
    renderCommentView(entry);
    renderNoteView(entry);
  }
}

// ---------------------------------------------------------------------------
// Only one editor -- comment or note, on any change point -- is ever open at
// once, exactly like the pre-notes behavior where only one comment editor
// could be open at a time. Opening a second editor discards the first one's
// unsaved text, same as Esc always has. `nextKey`/`nextKind` identify the
// editor about to open so that this is a no-op when it is called for the
// editor that is already open (defensive -- in practice the view-mode
// Edit/+Comment/+Note buttons that call enterCommentEdit/enterNoteEdit are
// themselves gone once that editor is open, so re-entry only happens
// through this function's own callers).
// ---------------------------------------------------------------------------

function closeOpenEditor(nextKey, nextKind) {
  if (!appState.editingKey) return;
  if (appState.editingKey === nextKey && appState.editingKind === nextKind) return;
  const other = dom.changePoints.get(appState.editingKey);
  if (!other) return;
  if (appState.editingKind === 'comment') renderCommentView(other);
  else if (appState.editingKind === 'note') renderNoteView(other);
  else if (appState.editingKind === 'anchored') {
    // The anchored editor is spliced into the diff body, so discarding it
    // means re-rendering that body -- which is also what puts the saved
    // anchored comments back in its place. Cheap (one change point) and it
    // cannot disturb scroll: renderChangePointContent replaces contentEl's
    // children in place, exactly as gap expansion already does.
    appState.editingAnchor = null;
    if (other.contentEl) renderChangePointContent(other);
  }
}

// ===========================================================================
// Collapsing a saved annotation -- shared by comment and note, which are the
// same kind of block and must not behave differently.
//
// Why: once written, a comment's day-to-day value is "I marked this place",
// not "show me the full text at all times". Real comments here run to many
// lines (the motivating one pasted several lines of source plus a question)
// and a handful of them crowd everything else off the screen. So a saved
// annotation renders as one header row by default, and the body is one click
// or one Enter away.
//
// The summary line is the first NON-EMPTY line, trimmed, plus a "+N lines"
// count when there are more. Deliberately not "the first N characters" (it
// cuts mid-word and mid-token) and deliberately not any attempt to find "the
// user's own words" as opposed to a pasted code line they opened with: that
// would be a guess, it would be wrong exactly on the long comments that need
// it most, and it would make the collapsed line show something that isn't at
// the top of the text when you expand it. First line + line count is honest:
// it is literally what you see first when it opens, and the count tells you
// how much more there is. Truncation of an over-wide first line is CSS
// ellipsis (see .annotation-summary), so it adapts to the pane width instead
// of a hard-coded character budget.
//
// The toggle is a real <button> -- Tab reaches it, Enter/Space activate it,
// and aria-expanded/aria-controls carry the state -- not a clickable div.
//
// Toggling never re-renders the slot: it flips hidden/aria/text on nodes
// that already exist. That keeps focus on the button the user just pressed
// (a re-render would destroy it and drop focus to <body>), and it means
// collapsing cannot touch appState.isEditing or the *other* annotation's
// open editor on the same change point, since it never runs any of the
// render/save paths that own that flag.
// ===========================================================================

let annotationDetailSeq = 0;

// ---------------------------------------------------------------------------
// The open/closed wiring itself, shared by all three collapsible blocks in
// this file: a saved comment/note (buildAnnotationBody below), one History
// comments card, and the History comments section as a whole. They differ
// only in what they summarize, so only that part is per-caller (`onApply`).
//
// Everything else is the invariant this codebase already settled on and must
// not diverge on:
//
//   * the toggle is a real <button> -- Tab reaches it, Enter/Space activate
//     it -- carrying aria-expanded plus aria-controls pointing at the detail
//     it owns. The chevron is aria-hidden because aria-expanded is the state
//     assistive tech actually reads.
//   * toggling never re-renders: it flips hidden/aria/text on nodes that
//     already exist, so focus stays on the button the user just pressed (a
//     re-render would destroy it and drop focus to <body>).
//   * every explicit toggle persists (see prefs.js). The session-only
//     `persist: false` case exists solely for annotations the user just
//     wrote or opened an editor on, which is not something a History card or
//     the section can be.
// ---------------------------------------------------------------------------
function wireCollapse({ header, chevron, detail, kind, key, onApply }) {
  function apply(isExpanded) {
    header.setAttribute('aria-expanded', String(isExpanded));
    chevron.textContent = isExpanded ? '▾' : '▸';
    detail.hidden = !isExpanded;
    if (onApply) onApply(isExpanded);
  }

  header.addEventListener('click', () => {
    const next = header.getAttribute('aria-expanded') !== 'true';
    setAnnotationExpanded(kind, key, next);
    apply(next);
  });

  apply(isAnnotationExpanded(kind, key));
}

// The chevron every one of them uses. aria-hidden -- see wireCollapse.
function buildChevron() {
  const chevron = createEl('span', { className: 'annotation-chevron', text: '▸' });
  chevron.setAttribute('aria-hidden', 'true');
  return chevron;
}

// First non-empty line + how many lines follow it. Trailing blank lines are
// dropped first so a comment ending in a newline doesn't claim "+1 lines".
function summarizeAnnotation(text) {
  const lines = String(text ?? '').split('\n');
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
  let i = 0;
  while (i < lines.length && lines[i].trim() === '') i += 1;
  return {
    first: i < lines.length ? lines[i].trim() : '',
    extra: Math.max(0, lines.length - i - 1),
  };
}

// Builds the whole view-mode body for one saved annotation: collapsible
// header + hidden detail (text + Edit/Delete). `kind` is 'comment' | 'note'
// and is what scopes the persisted state, so a change point's comment and
// note collapse independently.
// Copies ONE comment in the same format the whole-review Claude export uses.
//
// Deliberately not the comment's raw text: that is already selectable on
// screen, so a button for it would add nothing. What a lone comment lacks is
// everything that makes it answerable -- which file, which function, which
// lines. The server narrows the export ctx to this single entry and runs the
// same formatter, so there is no second rendering of an annotation to keep in
// step with the first.
function buildCopyButton(key, anchor) {
  const btn = createEl('button', { className: 'comment-btn', text: 'Copy' });
  btn.type = 'button';
  btn.title = '複製這一則（給 Claude，含所在檔案與程式碼）';
  btn.addEventListener('click', () => copyOneComment(btn, key, anchor));
  return btn;
}

async function copyOneComment(btnEl, key, anchor) {
  if (!appState.repo || !appState.base || !appState.target) return;
  clearError();
  let text;
  try {
    text = await api.exportOneComment(appState.repo, appState.base, appState.target, key, anchor);
  } catch (err) {
    showError(err.message);
    return;
  }
  await copyToClipboardWithFeedback(text, btnEl);
}

function buildAnnotationBody({ kind, key, bodyClassName, labelClassName, labelText, textClassName, text, onEdit, onDelete }) {
  const body = createEl('div', { className: bodyClassName });
  const detailId = `annotation-detail-${kind}-${(annotationDetailSeq += 1)}`;
  const { first, extra } = summarizeAnnotation(text);

  const header = createEl('button', { className: 'annotation-header' });
  header.type = 'button';
  header.setAttribute('aria-controls', detailId);
  const chevron = buildChevron();
  const summary = createEl('span', { className: 'annotation-summary', text: first });
  const more = createEl('span', { className: 'annotation-more', text: extra > 0 ? `+${extra} more` : '' });
  header.append(chevron, createEl('span', { className: labelClassName, text: labelText }), summary, more);

  const detail = createEl('div', { className: 'annotation-detail' });
  detail.id = detailId;
  detail.appendChild(createEl('p', { className: textClassName, text }));

  const actions = createEl('div', { className: 'comment-actions' });
  const editBtn = createEl('button', { className: 'comment-btn', text: 'Edit' });
  editBtn.type = 'button';
  editBtn.addEventListener('click', onEdit);
  const deleteBtn = createEl('button', { className: 'comment-btn comment-btn-danger', text: 'Delete' });
  deleteBtn.type = 'button';
  deleteBtn.addEventListener('click', onDelete);
  actions.append(editBtn, deleteBtn);
  // Comments only. A note means "I understood this, recording it for myself"
  // and is deliberately absent from the Claude export (see export.js), so a
  // button offering to copy one in that format would be offering nothing.
  if (kind === 'comment') actions.appendChild(buildCopyButton(key, null));
  detail.appendChild(actions);

  wireCollapse({
    header,
    chevron,
    detail,
    kind,
    key,
    onApply: (isExpanded) => {
      // The summary is the collapsed stand-in for the text right below it --
      // showing both at once would just be the first line twice.
      summary.hidden = isExpanded;
      more.hidden = isExpanded || extra === 0;
      body.classList.toggle('annotation-collapsed', !isExpanded);
    },
  });

  body.append(header, detail);
  return body;
}

// ===========================================================================
// The editor itself -- ONE implementation, used by all three things that can
// be written on a change point: its comment, its note, and an anchored
// comment on one of its lines. Extracted verbatim from what enterCommentEdit
// and enterNoteEdit were each doing identically (same textarea, same
// Esc/⌘Enter/clear-to-delete contract, same "stop every keystroke from
// reaching keyboard.js" rule, same focus-and-put-the-caret-at-the-end), so
// anchoring reuses the existing editor rather than growing a third copy of it
// that could drift.
// ===========================================================================

function buildAnnotationEditor({ value, ariaLabel, onSave, onCancel }) {
  const textarea = document.createElement('textarea');
  textarea.className = 'comment-textarea';
  textarea.value = value || '';
  textarea.rows = 4;
  textarea.setAttribute('aria-label', ariaLabel);

  const hint = createEl('div', {
    className: 'comment-hint',
    text: 'Esc cancel  ·  ⌘/Ctrl+Enter save  ·  clear + save = delete',
  });

  const actions = createEl('div', { className: 'comment-actions' });
  const saveBtn = createEl('button', { className: 'comment-btn comment-btn-primary', text: 'Save' });
  saveBtn.type = 'button';
  saveBtn.addEventListener('click', () => onSave(textarea.value));
  const cancelBtn = createEl('button', { className: 'comment-btn', text: 'Cancel' });
  cancelBtn.type = 'button';
  cancelBtn.addEventListener('click', () => onCancel());
  actions.append(saveBtn, cancelBtn);

  // Stop every keyboard event from leaving the textarea: this is the other
  // half of EXTENSION POINT 5 -- nothing typed here should ever be treated as
  // anything but text by the global shortcut handler.
  const stop = (e) => e.stopPropagation();
  textarea.addEventListener('keyup', stop);
  textarea.addEventListener('keypress', stop);
  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onCancel();
    } else if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      onSave(textarea.value);
    }
    stop(e);
  });

  return { textarea, hint, actions };
}

function focusEditor(textarea) {
  textarea.focus();
  textarea.setSelectionRange(textarea.value.length, textarea.value.length);
}

// ===========================================================================
// Comment -- unchanged behavior from before notes existed, just scoped to
// entry.commentBodyEl (a child of the shared wrapper) instead of owning the
// whole section.
// ===========================================================================

// View mode: shows the saved comment (via textContent only -- comment text
// comes from the reviewed repo's own diff plus whatever the user typed, and
// must never be interpreted as markup) plus Edit/Delete, or an "add
// comment" button when there is none yet.
function renderCommentView(entry, { focusTrigger = false } = {}) {
  const { commentBodyEl, changePoint } = entry;
  commentBodyEl.textContent = '';

  if (changePoint.comment) {
    commentBodyEl.classList.add('annotation-slot-expanded');
    commentBodyEl.appendChild(
      buildAnnotationBody({
        kind: 'comment',
        key: changePoint.id,
        bodyClassName: 'comment-body',
        labelClassName: 'comment-label',
        labelText: 'Comment',
        textClassName: 'comment-text',
        text: changePoint.comment,
        onEdit: () => enterCommentEdit(entry),
        onDelete: () => saveComment(entry, ''),
      }),
    );
    // Focus the shared section container, not editBtn -- see the tabIndex
    // comment in renderAllComments for why (space-reopens-editor bug).
    if (focusTrigger) entry.commentEl.focus();
  } else {
    commentBodyEl.classList.remove('annotation-slot-expanded');
    const addBtn = createEl('button', { className: 'comment-btn comment-add-btn', text: '+ Comment' });
    addBtn.type = 'button';
    addBtn.addEventListener('click', () => enterCommentEdit(entry));
    commentBodyEl.appendChild(addBtn);
    if (focusTrigger) entry.commentEl.focus();
  }
}

// Edit mode. Sets appState.isEditing -- see EXTENSION POINT 5 in state.js's
// appState declaration -- for the whole time the textarea exists.
export function enterCommentEdit(entry) {
  closeOpenEditor(entry.changePoint.id, 'comment');

  // `c` (keyboard.js) and the header's own Edit button both land here, and
  // `c` can fire on a collapsed comment -- editing something invisible would
  // be disorienting, and cancelling out of it back into a collapsed row
  // would look like the text was lost. Session-only (persist: false): being
  // opened for editing is not the same as the user asking for this comment
  // to stay open forever.
  setAnnotationExpanded('comment', entry.changePoint.id, true, { persist: false });

  appState.isEditing = true;
  appState.editingKey = entry.changePoint.id;
  appState.editingKind = 'comment';

  const { commentBodyEl, changePoint } = entry;
  commentBodyEl.textContent = '';
  commentBodyEl.classList.add('annotation-slot-expanded');

  const { textarea, hint, actions } = buildAnnotationEditor({
    value: changePoint.comment,
    ariaLabel: 'comment text',
    onSave: (value) => saveComment(entry, value),
    onCancel: () => exitCommentEdit(entry),
  });

  commentBodyEl.append(textarea, hint, actions);
  focusEditor(textarea);
}

function exitCommentEdit(entry) {
  appState.isEditing = false;
  appState.editingKey = null;
  appState.editingKind = null;
  renderCommentView(entry, { focusTrigger: true });
}

// Saves via POST /api/comment (server treats empty/whitespace-only text as
// delete -- see state.js setComment on the backend), then updates
// changePoint.comment and re-renders just this one comment section in
// place. Never refetches GET /api/diff, per the brief ("存檔後就地更新畫面，
// 不要整棵樹重抓").
async function saveComment(entry, text) {
  clearError();
  const { changePoint } = entry;
  const context = {
    filePath: changePoint.filePath,
    functionName: changePoint.functionName,
    diffText: changePoint.diffText,
  };

  try {
    await api.setComment(appState.repo, changePoint.id, text, context);
  } catch (err) {
    showError(err.message);
    return; // stay in edit mode -- the user's text is still in the textarea
  }

  const hadCommentBefore = changePoint.comment != null;
  const isEmpty = typeof text !== 'string' || text.trim() === '';
  changePoint.comment = isEmpty ? null : text;
  const hasCommentAfter = changePoint.comment != null;

  // Just-saved stays expanded so the user can confirm what was stored, but
  // session-only -- persisting it would mean every comment ever written
  // comes back expanded, which is the density problem this feature fixes.
  // A cleared-and-saved (= deleted) comment drops its state immediately
  // rather than waiting for the next load's prune.
  if (hasCommentAfter) setAnnotationExpanded('comment', changePoint.id, true, { persist: false });
  else forgetAnnotationExpanded('comment', changePoint.id);

  if (appState.tree && appState.tree.stats) {
    if (hadCommentBefore && !hasCommentAfter) appState.tree.stats.comments -= 1;
    if (!hadCommentBefore && hasCommentAfter) appState.tree.stats.comments += 1;
  }

  // Only clear the shared editing flag if `entry` + "comment" is what it
  // actually refers to. saveComment is also reached directly from the
  // view-mode Delete button (no editor open for that entry at all), so an
  // unconditional reset here can clobber appState.isEditing/editingKey/
  // editingKind out from under an *unrelated* still-open editor -- either a
  // comment editor on a different change point (the original, pre-notes
  // bug this guard already fixed), or, now that a single change point can
  // have both a comment and a note, a NOTE editor open on this very same
  // change point (its view-mode comment Delete button sits right next to a
  // note textarea that is mid-edit). The editingKind check is what tells
  // those two apart -- without it, deleting a comment while this entry's
  // note editor is open would silently end note-editing too, at which point
  // every single-key shortcut goes live while the note textarea is still
  // visibly open and still holds the user's unsaved text. Mirrors the guard
  // enterCommentEdit already applies before stealing edit mode from another
  // entry/kind.
  if (appState.editingKey === entry.changePoint.id && appState.editingKind === 'comment') {
    appState.isEditing = false;
    appState.editingKey = null;
    appState.editingKind = null;
  }
  renderCommentView(entry, { focusTrigger: true });
}

// ===========================================================================
// Note -- structurally a mirror of the comment code above (same view/edit
// states, same save-in-place/no-refetch rule, same Esc/⌘+Enter/clear-to-
// delete conventions), deliberately kept un-colored (see .note-label /
// .note-add-btn in style.css): a note is "I already understood this", not
// something that needs the reviewer's attention the way an open comment
// does, so it does not compete for the amber "comment" hue -- or green
// (diff additions) or terracotta (read state / progress / open file) -- at
// all. Text-only differentiation ("Note" vs "Comment" labels, "+ Note" vs
// "+ Comment" buttons) plus the neutral default button treatment already
// used elsewhere in this file is enough to tell the two apart while
// scanning a large review, without adding a fifth semantic color.
// ===========================================================================

function renderNoteView(entry, { focusTrigger = false } = {}) {
  const { noteBodyEl, changePoint } = entry;
  noteBodyEl.textContent = '';

  if (changePoint.note) {
    noteBodyEl.classList.add('annotation-slot-expanded');
    noteBodyEl.appendChild(
      buildAnnotationBody({
        kind: 'note',
        key: changePoint.id,
        bodyClassName: 'note-body',
        labelClassName: 'note-label',
        labelText: 'Note',
        textClassName: 'note-text',
        text: changePoint.note,
        onEdit: () => enterNoteEdit(entry),
        onDelete: () => saveNote(entry, ''),
      }),
    );
    if (focusTrigger) entry.commentEl.focus();
  } else {
    noteBodyEl.classList.remove('annotation-slot-expanded');
    const addBtn = createEl('button', { className: 'comment-btn note-add-btn', text: '+ Note' });
    addBtn.type = 'button';
    addBtn.addEventListener('click', () => enterNoteEdit(entry));
    noteBodyEl.appendChild(addBtn);
    if (focusTrigger) entry.commentEl.focus();
  }
}

export function enterNoteEdit(entry) {
  closeOpenEditor(entry.changePoint.id, 'note');

  // Same as enterCommentEdit -- see the comment there.
  setAnnotationExpanded('note', entry.changePoint.id, true, { persist: false });

  appState.isEditing = true;
  appState.editingKey = entry.changePoint.id;
  appState.editingKind = 'note';

  const { noteBodyEl, changePoint } = entry;
  noteBodyEl.textContent = '';
  noteBodyEl.classList.add('annotation-slot-expanded');

  const { textarea, hint, actions } = buildAnnotationEditor({
    value: changePoint.note,
    ariaLabel: 'note text',
    onSave: (value) => saveNote(entry, value),
    onCancel: () => exitNoteEdit(entry),
  });

  noteBodyEl.append(textarea, hint, actions);
  focusEditor(textarea);
}

function exitNoteEdit(entry) {
  appState.isEditing = false;
  appState.editingKey = null;
  appState.editingKind = null;
  renderNoteView(entry, { focusTrigger: true });
}

// Saves via POST /api/note (server treats empty/whitespace-only text as
// delete -- see state.js setNote on the backend), then updates
// changePoint.note and re-renders just this one note section in place.
// Never refetches GET /api/diff, same rule as saveComment above.
async function saveNote(entry, text) {
  clearError();
  const { changePoint } = entry;
  const context = {
    filePath: changePoint.filePath,
    functionName: changePoint.functionName,
    diffText: changePoint.diffText,
  };

  try {
    await api.setNote(appState.repo, changePoint.id, text, context);
  } catch (err) {
    showError(err.message);
    return; // stay in edit mode -- the user's text is still in the textarea
  }

  const isEmpty = typeof text !== 'string' || text.trim() === '';
  changePoint.note = isEmpty ? null : text;

  // Same just-saved-stays-expanded / deleted-forgets rule as saveComment.
  if (changePoint.note != null) setAnnotationExpanded('note', changePoint.id, true, { persist: false });
  else forgetAnnotationExpanded('note', changePoint.id);

  // Same editingKind-guarded reset as saveComment, mirrored: this entry's
  // comment editor could independently be open right now, and must not be
  // clobbered by a note Delete/Save that doesn't refer to it.
  if (appState.editingKey === entry.changePoint.id && appState.editingKind === 'note') {
    appState.isEditing = false;
    appState.editingKey = null;
    appState.editingKind = null;
  }
  renderNoteView(entry, { focusTrigger: true });
}


// ===========================================================================
// Anchored comments -- a comment attached to ONE LINE, or a contiguous run of
// lines, inside a change point. Same annotation kind as the comment above
// (same editor, same export, same orphaning, counted in the same stats), with
// one extra field: the line range it points at.
//
// -- Why this exists ------------------------------------------------------
// A change point can be 67 lines. A comment on the whole thing that says
// "is `nm` always set here?" forces the reader -- and, in the exported
// prompt, Claude -- to guess which line "here" is. Anchoring is what turns
// that into a pointer. The export is the payoff (see export.js); this UI is
// how the pointer gets made.
//
// -- The anchor is an index range into diffText, not a file line number ----
// Explained at length in state.js on the server. Short version: diffText is
// inside changePointKey, so an index into it is exactly as stable as the
// checkmark next to it -- if the key survives an amend the text is
// byte-identical and index i still names line i; if the text changed at all,
// the key changed and the whole record orphans through the existing path.
//
// -- Placement ------------------------------------------------------------
// Directly under the anchored line (GitHub's idiom), spliced into the diff
// body between two rows. That means it is rebuilt by
// renderChangePointContent, which is also the re-render path for gap
// expansion and view-mode switching -- hence the registerAnchorUi() hook at
// the bottom of this section rather than a call from renderAllComments: the
// diff owns when its own body is rebuilt, and anchored comments have to
// follow it.
//
// -- Side-by-side ---------------------------------------------------------
// Anchoring is offered in UNIFIED MODE ONLY, and this is a deliberate,
// visible limitation rather than something quietly half-working:
//
//   An anchor is a contiguous range of diffText indices. Side-by-side pairs a
//   run of '-' lines against the '+' run that replaced it
//   (pairLinesForSideBySide), so one visual row can carry TWO different
//   diffText indices, one per column, and a filler row carries none. A
//   contiguous anchor range is therefore not contiguous in either column, and
//   "the row under the anchored line" is not a single well-defined place --
//   it is one place per column, or none. Offering the affordance there would
//   mean either duplicating each comment into both columns or picking one
//   arbitrarily, and both read as a bug the first time a range spans a
//   deletion and its replacement.
//
// So in side-by-side the gutter affordance is absent (diff.js passes no
// anchorCtx) and existing anchored comments render as a flat list under the
// diff, each stating the lines it points at and saying, out loud, that
// unified view shows it in place. Nothing becomes invisible or unreachable --
// the one thing that would genuinely be broken.
// ===========================================================================

// The line label an anchored comment announces: real file line numbers where
// the lines have them, old-side numbers for deletions (claiming a new-side
// number for a deleted line would be inventing one), and a plain
// "lines N-M of this change" when `lines` cannot answer at all.
function anchorRangeLabel(changePoint, anchorStart, anchorEnd) {
  const covered = [];
  let changedIndex = 0;
  for (const line of changePoint.lines ?? []) {
    if (line.type === ' ') continue;
    if (changedIndex >= anchorStart && changedIndex <= anchorEnd) covered.push(line);
    changedIndex += 1;
  }

  const newNumbers = covered.map((l) => l.newLine).filter((n) => n != null);
  if (newNumbers.length > 0) return `line${newNumbers.length > 1 ? 's' : ''} ${formatSpan(newNumbers)}`;
  const oldNumbers = covered.map((l) => l.oldLine).filter((n) => n != null);
  if (oldNumbers.length > 0) return `deleted line${oldNumbers.length > 1 ? 's' : ''} ${formatSpan(oldNumbers)}`;
  return anchorStart === anchorEnd ? `line ${anchorStart + 1} of this change` : `lines ${anchorStart + 1}-${anchorEnd + 1} of this change`;
}

function formatSpan(numbers) {
  const min = Math.min(...numbers);
  const max = Math.max(...numbers);
  return min === max ? String(min) : `${min}-${max}`;
}

// Entry point registered with diff.js -- called when an anchor button is
// activated, with the range already resolved there (diff.js owns the
// click/shift/arrow gesture model; this owns what a range MEANS).
function openAnchoredEditor(entry, range) {
  const key = entry.changePoint.id;

  closeOpenEditor(key, 'anchored');

  appState.isEditing = true;
  appState.editingKey = key;
  appState.editingKind = 'anchored';
  appState.editingAnchor = range;

  // Re-render the body so the editor lands in the right slot; the render pass
  // itself (renderAnchoredComments below) is what draws it, from
  // appState.editingAnchor.
  renderChangePointContent(entry);
}

function exitAnchoredEditor(entry) {
  appState.isEditing = false;
  appState.editingKey = null;
  appState.editingKind = null;
  appState.editingAnchor = null;
  renderChangePointContent(entry);
}

async function saveAnchoredComment(entry, range, text) {
  clearError();
  const { changePoint } = entry;
  const context = {
    filePath: changePoint.filePath,
    functionName: changePoint.functionName,
    diffText: changePoint.diffText,
  };

  try {
    await api.setAnchoredComment(appState.repo, changePoint.id, range, text, context);
  } catch (err) {
    showError(err.message);
    return; // stay in edit mode -- the user's text is still in the textarea
  }

  // Same in-place update rule as saveComment/saveNote: never refetch the
  // tree, just mutate the change point this editor belongs to.
  const list = (changePoint.anchoredComments ?? []).filter(
    (a) => !(a.anchorStart === range.start && a.anchorEnd === range.end),
  );
  const isEmpty = typeof text !== 'string' || text.trim() === '';
  const had = (changePoint.anchoredComments ?? []).length;
  if (!isEmpty) list.push({ anchorStart: range.start, anchorEnd: range.end, text });
  list.sort((a, b) => a.anchorStart - b.anchorStart || a.anchorEnd - b.anchorEnd);
  changePoint.anchoredComments = list;

  if (appState.tree && appState.tree.stats) {
    appState.tree.stats.comments += list.length - had;
  }

  exitAnchoredEditor(entry);
}

// Called by diff.js at the end of every renderChangePointContent.
function renderAnchoredComments(entry) {
  const { changePoint } = entry;
  const saved = changePoint.anchoredComments ?? [];
  const editing =
    appState.editingKind === 'anchored' && appState.editingKey === changePoint.id
      ? appState.editingAnchor
      : null;
  if (saved.length === 0 && !editing) return;

  // Side-by-side has no anchor rows to splice into -- see the block comment
  // above for why anchoring is unified-only.
  if (!entry.anchorRows || entry.anchorRows.size === 0) {
    renderAnchorFallback(entry, saved);
    return;
  }

  // Anything already spliced in by a previous pass is gone (the body was
  // rebuilt), so this only ever inserts.
  for (const anchored of saved) {
    if (editing && editing.start === anchored.anchorStart && editing.end === anchored.anchorEnd) {
      continue; // this one is being edited -- the editor stands in for it
    }
    insertAfterAnchorRow(
      entry,
      anchored.anchorEnd,
      buildAnchoredView(entry, anchored),
    );
  }

  if (editing) {
    insertAfterAnchorRow(entry, editing.end, buildAnchoredEditor(entry, editing, saved));
  }
}

function insertAfterAnchorRow(entry, index, block) {
  const target = entry.anchorRows.get(index);
  // The anchored line is always inside the change point's own diff by
  // construction (the anchor could only have been made from one of these very
  // buttons, and an out-of-range anchor is rejected server-side), so this is
  // defensive only -- append to the body rather than dropping the comment.
  const row = target && target.cell.parentElement;
  if (!row || !row.parentElement) {
    entry.contentEl.appendChild(block);
    return;
  }
  row.parentElement.insertBefore(block, row.nextSibling);
}

function buildAnchoredBlock(labelText) {
  const block = createEl('div', { className: 'anchored-comment' });
  block.appendChild(createEl('span', { className: 'anchored-label', text: labelText }));
  return block;
}

function buildAnchoredView(entry, anchored) {
  const label = anchorRangeLabel(entry.changePoint, anchored.anchorStart, anchored.anchorEnd);
  const block = buildAnchoredBlock(`Comment on ${label}`);
  // textContent only -- comment text is whatever the user typed, and may
  // legitimately contain code pasted out of the reviewed repo.
  block.appendChild(createEl('p', { className: 'comment-text', text: anchored.text }));

  const actions = createEl('div', { className: 'comment-actions' });
  const editBtn = createEl('button', { className: 'comment-btn', text: 'Edit' });
  editBtn.type = 'button';
  editBtn.addEventListener('click', () =>
    openAnchoredEditorAt(entry, anchored.anchorStart, anchored.anchorEnd),
  );
  const deleteBtn = createEl('button', { className: 'comment-btn comment-btn-danger', text: 'Delete' });
  deleteBtn.type = 'button';
  deleteBtn.addEventListener('click', () =>
    saveAnchoredComment(entry, { start: anchored.anchorStart, end: anchored.anchorEnd }, ''),
  );
  actions.append(editBtn, deleteBtn);
  actions.appendChild(
    buildCopyButton(entry.changePoint.id, `${anchored.anchorStart}-${anchored.anchorEnd}`),
  );
  block.appendChild(actions);
  return block;
}

function openAnchoredEditorAt(entry, start, end) {
  closeOpenEditor(entry.changePoint.id, 'anchored');
  appState.isEditing = true;
  appState.editingKey = entry.changePoint.id;
  appState.editingKind = 'anchored';
  appState.editingAnchor = { start, end };
  renderChangePointContent(entry);
}

function buildAnchoredEditor(entry, range, saved) {
  const label = anchorRangeLabel(entry.changePoint, range.start, range.end);
  const block = buildAnchoredBlock(`Comment on ${label}`);
  const existing = saved.find((a) => a.anchorStart === range.start && a.anchorEnd === range.end);

  const { textarea, hint, actions } = buildAnnotationEditor({
    value: existing ? existing.text : '',
    ariaLabel: `comment on ${label}`,
    onSave: (value) => saveAnchoredComment(entry, range, value),
    onCancel: () => exitAnchoredEditor(entry),
  });
  block.append(textarea, hint, actions);
  // Deferred one frame: this block is being built during
  // renderChangePointContent and is not in the document yet, and focusing a
  // detached element is a no-op.
  requestAnimationFrame(() => focusEditor(textarea));
  return block;
}

// Side-by-side: no rows to anchor into, so the saved anchored comments go in a
// flat list under the diff, each stating what it points at. Not a silent
// degradation -- the note says where to see them in place.
function renderAnchorFallback(entry, saved) {
  if (saved.length === 0) return;
  const wrap = createEl('div', { className: 'anchored-fallback' });
  wrap.appendChild(
    createEl('p', {
      className: 'anchored-fallback-note',
      text:
        'Anchored comments are shown in place in unified view (press 1). Side-by-side pairs ' +
        'deleted and added lines into shared rows, so there is no single row to put them under.',
    }),
  );
  for (const anchored of saved) {
    wrap.appendChild(buildAnchoredView(entry, anchored));
  }
  entry.contentEl.appendChild(wrap);
}

registerAnchorUi({ openEditor: openAnchoredEditor, renderAnchored: renderAnchoredComments });

// ===========================================================================
// History comments/notes -- change points whose underlying diff no longer
// exists (GET /api/diff's `orphans` array; see state.js buildAnnotated on
// the backend). Never silently dropped: shown in their own section with the
// filePath / functionName / diffText snapshot the annotation(s) were
// originally attached to. "Keep" needs no API call -- not touching an entry
// *is* keeping it; only "discard" hits the network, and discards BOTH the
// comment and the note for that key at once (see state.js discardOrphan)
// since the card represents one change-point identity, not one annotation
// type.
//
// -- Naming ---------------------------------------------------------------
// The user-visible wording is "History comments", not "Orphaned comments":
// "orphan" reads like an error state, but nothing here is broken. What this
// section actually holds is history -- annotations the user wrote whose code
// has since been edited or removed, very often edited *because* of that very
// annotation, which makes these the record of the review working rather than
// wreckage left over from it. The identifiers below (orphan/orphans, the
// CSS class names, appState.tree.orphans, POST /api/discard-orphan) keep the
// old name on purpose: they are the backend's field names and renaming them
// here would only put the client and the wire format out of step for a
// wording change.
//
// -- The snapshot ---------------------------------------------------------
// Rendered through diff.js's own buildUnifiedDiff(), not as flat text, so
// re-reading an old annotation feels like reading the diff: same rows, same
// low-opacity add/del tints, same Prism highlighting, and -- because it is
// literally the same function -- no second renderer to keep in sync. See
// parseSnapshotLines below for the two things that differ, both forced by
// what diffText stores.
//
// Security is unchanged by that switch: the snapshot is reviewed-repo
// content and still never reaches innerHTML raw. buildUnifiedDiff writes
// every cell via textContent, with the single exception diff.js documents at
// length -- buildCodeSpan assigning the *return value* of Prism.highlight(),
// which escapes the source text itself before tokenising. A snapshot line
// reading `<img src=x onerror=alert(1)>` renders as those characters, the
// same as it did under the old textContent-only path.
// ===========================================================================

let orphansRootEl = null;
// The section's toggle button, kept so discardOrphan can put focus somewhere
// sensible after the Discard button it was pressed from stops existing.
let orphansToggleEl = null;
// There is exactly one History comments section, so its detail element can
// have a fixed id for the heading button's aria-controls; the cards, of
// which there are many, number theirs (orphanDetailSeq below).
const ORPHANS_DETAIL_ID = 'orphans-detail';
let orphanDetailSeq = 0;

function ensureOrphansRootEl() {
  if (orphansRootEl) return orphansRootEl;
  orphansRootEl = createEl('section', { className: 'orphans-section' });
  orphansRootEl.id = 'orphans-root';
  orphansRootEl.hidden = true;
  // Appended after changepointsRootEl (its only sibling inside main-pane),
  // so orphans read as an appendix at the end of the primary review flow
  // rather than something the user has to scroll past first.
  mainPaneEl.appendChild(orphansRootEl);
  return orphansRootEl;
}

// -- Collapsing ------------------------------------------------------------
// Two levels, both closed by default, both persisted per repo through the
// same store the saved-annotation collapse uses (see the ORPHAN_* kinds in
// prefs.js and wireCollapse above).
//
// The section, because it is an appendix to work the user has usually
// already done. Its cards are tall -- each one carries a multi-line code
// snapshot -- so on a file with six of them the history was several screens
// of material the reader had already dealt with, permanently parked under
// the diff they came here to read. Collapsed, the whole thing is one row
// that still states the count, so it advertises itself without costing
// anything; the count is the part that actually needs to be always-visible,
// not the snapshots.
//
// Each card, because "open the section" and "read one particular entry" are
// different intentions. Expanding the section on this file used to mean
// committing to all six snapshots at once with no way to scan them; with the
// cards closed it opens into an index, one row each, and the one you want is
// one more click. The rows summarize with the SAME idiom as a collapsed
// comment -- first non-empty line of the annotation text, plus "+N more" --
// rather than with the meta row alone, which reads as the obvious choice
// until you notice that the section is now scoped to the open file: every
// card in the primary group then shows the SAME file path, so the meta row
// distinguishes cards only by function name and often not even by that.
// What actually tells two history entries apart is what you wrote on them.
// The meta row stays in the header regardless -- it costs nothing there, and
// it is the only label the "no longer in this diff" group has.
//
// The two levels cannot fight: a card's header lives inside the section's
// detail element, so an expanded card inside a collapsed section is simply
// not rendered visible, and reopening the section restores exactly the cards
// that were open. Neither level writes the other's state.
//
// No keyboard shortcut: every single-key binding is spoken for
// (j/k/x/u/c/f/b/a/1/2/?, see handleGlobalKeydown in keyboard.js), and this is
// an appendix -- it does not deserve a hijacked key. Both toggles are real
// buttons in normal document order, so Tab + Enter reaches them.
//
// -- Scoping ---------------------------------------------------------------
// This section is an appendix to the right pane, and the right pane shows
// exactly one file (see pane.js's openFile). Rendering every orphan in the
// repo underneath it put one file's history at the bottom of a different
// file's page -- the section looked like it belonged to the open file and
// did not.
// So the visible set is the open file's orphans, and openFile() re-renders on
// every switch; this used to be called once only, from tree.js's build.
//
// The exception is orphans whose file is no longer in the diff at all, which
// is one of the ordinary ways an orphan is made: the change point did not
// merely move, its whole file stopped differing from base. Those have no row
// in the sidebar, so no file selection could ever bring them on screen --
// scoping alone would leave them permanently invisible *and* permanently
// undiscardable, with their annotations still in the state file. They show
// regardless of selection, in their own group, since being unreachable is the
// only thing they have in common with one another.
export function renderOrphans() {
  const root = ensureOrphansRootEl();
  root.textContent = '';

  const all = (appState.tree && appState.tree.orphans) || [];
  const filesInDiff = new Set(((appState.tree && appState.tree.files) || []).map((f) => f.path));

  const forOpenFile = appState.currentFile
    ? all.filter((o) => o.filePath === appState.currentFile)
    : [];
  // Disjoint from forOpenFile by construction: currentFile is only ever set
  // to a path taken from the tree, so it is always in filesInDiff.
  const unreachable = all.filter((o) => !filesInDiff.has(o.filePath));

  if (forOpenFile.length === 0 && unreachable.length === 0) {
    root.hidden = true;
    return;
  }
  root.hidden = false;

  // The <h2> stays the heading for the document outline; the control inside
  // it is the button (the ordinary accordion shape), so the section is still
  // announced as a heading and is still activatable from the keyboard.
  const heading = createEl('h2', { className: 'orphans-heading' });
  const toggle = createEl('button', { className: 'orphans-toggle' });
  toggle.type = 'button';
  toggle.setAttribute('aria-controls', ORPHANS_DETAIL_ID);
  const chevron = buildChevron();
  toggle.append(
    chevron,
    createEl('span', {
      className: 'orphans-title',
      text: `History comments (${forOpenFile.length + unreachable.length})`,
    }),
  );
  heading.appendChild(toggle);
  root.appendChild(heading);
  orphansToggleEl = toggle;

  const body = createEl('div', { className: 'orphans-body' });
  body.id = ORPHANS_DETAIL_ID;
  root.appendChild(body);

  body.appendChild(
    createEl('p', {
      className: 'orphans-note',
      text:
        'Annotations you wrote on code that has since been edited or removed -- often edited ' +
        'because of the annotation itself. Each snapshot below is the code as it stood when you ' +
        'wrote it. Leaving an entry alone keeps it; only "Discard" deletes it.',
    }),
  );

  for (const orphan of forOpenFile) {
    body.appendChild(buildOrphanCard(orphan));
  }

  if (unreachable.length > 0) {
    body.appendChild(
      createEl('p', {
        className: 'orphans-note orphans-subnote',
        // Phrased as "no longer in this diff" rather than "no longer differs
        // from the base revision" to sidestep subject-verb agreement across
        // the singular/plural split -- the first draft shipped "files that no
        // longer differs", caught when the branch was finally exercised.
        text:
          `${unreachable.length} from ` +
          `${unreachable.length === 1 ? 'a file' : 'files'} no longer in this diff. There is no ` +
          `file to open ${unreachable.length === 1 ? 'it' : 'them'} under, so ` +
          `${unreachable.length === 1 ? 'it stays' : 'they stay'} here whichever file you are ` +
          'reading.',
      }),
    );
    for (const orphan of unreachable) {
      body.appendChild(buildOrphanCard(orphan));
    }
  }

  wireCollapse({
    header: toggle,
    chevron,
    detail: body,
    kind: ORPHAN_SECTION_KIND,
    key: ORPHAN_SECTION_KEY,
  });
}

// Parses a stored diffText snapshot back into the `line` shape diff.js
// renders (see model.js, which writes it as changedLines.map(line =>
// `${line.type}${line.text}`).join('\n')).
//
// Two things about that format decide how this renders, and neither is a
// shortcoming to work around:
//
//   No line numbers. diffText is the input to the content hash that lets a
//   checkmark survive a rebase (see state.js's key derivation), so anything
//   positional is excluded from it by design. oldLine/newLine are therefore
//   set to null and buildUnifiedRow draws an empty gutter cell -- the gutter
//   still occupies its width, so rows stay aligned with each other, it just
//   says nothing. Back-calculating a number from the current file would be
//   guessing at a file that has already changed out from under this
//   snapshot, and a *wrong* line number is worse than an absent one.
//
//   Only changed lines. There are no context lines to find, so every row is
//   an add or a del. A leading '+'/'-' is the marker and is stripped from
//   the text (it goes in the .diff-marker cell, as in the live diff);
//   anything else is treated as a context line with its text intact, which
//   only happens if the format ever gains one -- a stray blank trailing
//   entry from the final newline is dropped before that can matter.
function parseSnapshotLines(diffText) {
  if (typeof diffText !== 'string' || diffText === '') return [];
  const raw = diffText.split('\n');
  if (raw[raw.length - 1] === '') raw.pop(); // trailing newline, not a real line
  return raw.map((text) => {
    const marker = text[0];
    const isChange = marker === '+' || marker === '-';
    return {
      type: isChange ? marker : ' ',
      oldLine: null, // no line numbers in a snapshot, by design -- see above
      newLine: null,
      text: isChange ? text.slice(1) : text,
    };
  });
}

// The snapshot block for one history card. Always unified, regardless of
// appState.viewMode: side-by-side pairs '-' runs against the '+' runs that
// replaced them, and a snapshot has no context lines to anchor that pairing
// against, so half the rows would come out as blank filler cells. Unified is
// also what this content already was (a single flat column) -- it gains
// highlighting and tints without also gaining a layout the surrounding card
// was never sized for.
function buildSnapshotDiff(orphan) {
  const wrap = createEl('div', { className: 'orphan-diff' });
  wrap.appendChild(
    buildUnifiedDiff(parseSnapshotLines(orphan.diffText), getPrismLanguage(orphan.filePath)),
  );
  return wrap;
}

// The meta row doubles as the card's collapse toggle -- see the Collapsing
// note above for why the summary next to it is the annotation's first line
// rather than the meta row alone. Comment and note are summarized together
// (joined, in the order they render below) so "+N more" counts everything
// the card is actually hiding, not just the block the first line came from.
function buildOrphanCard(orphan) {
  const card = createEl('div', { className: 'orphan-card' });
  card.dataset.key = orphan.key;
  const detailId = `orphan-detail-${(orphanDetailSeq += 1)}`;
  const { first, extra } = summarizeAnnotation(
    [orphan.text, orphan.note, ...(orphan.anchored ?? []).map((a) => a.text)]
      .filter(Boolean)
      .join('\n'),
  );

  const header = createEl('button', { className: 'orphan-header' });
  header.type = 'button';
  header.setAttribute('aria-controls', detailId);
  const chevron = buildChevron();
  header.append(
    chevron,
    createEl('span', { className: 'orphan-file', text: orphan.filePath || '(unknown file)' }),
  );
  if (orphan.functionName) {
    header.appendChild(createEl('span', { className: 'orphan-fn', text: orphan.functionName }));
  }
  const summary = createEl('span', { className: 'annotation-summary', text: first });
  const more = createEl('span', { className: 'annotation-more', text: extra > 0 ? `+${extra} more` : '' });
  header.append(summary, more);
  card.appendChild(header);

  const detail = createEl('div', { className: 'orphan-detail' });
  detail.id = detailId;
  detail.appendChild(buildSnapshotDiff(orphan));

  // orphan.text/orphan.note are independently nullable (see state.js
  // buildAnnotated) -- an orphan can carry a comment, a note, or both, so
  // each gets its own labeled block only when present.
  if (orphan.text) {
    detail.appendChild(createEl('span', { className: 'comment-label', text: 'Comment' }));
    detail.appendChild(createEl('p', { className: 'orphan-comment', text: orphan.text }));
  }
  if (orphan.note) {
    detail.appendChild(createEl('span', { className: 'note-label', text: 'Note' }));
    detail.appendChild(createEl('p', { className: 'orphan-comment orphan-note', text: orphan.note }));
  }
  // Anchored comments, each shown WITH the lines it pointed at, sliced out of
  // the same diffText snapshot rendered above. That slice is the whole value
  // of keeping an anchored comment in history: "is nm always set here?" is
  // unreadable once you can no longer tell which line "here" was, and the
  // code it pointed at is by definition gone from the working tree. No file
  // line numbers -- a snapshot deliberately has none (see parseSnapshotLines),
  // and back-calculating one against a file that has since changed would be a
  // guess presented as a fact.
  for (const anchored of orphan.anchored ?? []) {
    detail.appendChild(
      createEl('span', {
        className: 'comment-label',
        text:
          anchored.anchorStart === anchored.anchorEnd
            ? `Comment on line ${anchored.anchorStart + 1} of this change`
            : `Comment on lines ${anchored.anchorStart + 1}-${anchored.anchorEnd + 1} of this change`,
      }),
    );
    const quoted = createEl('div', { className: 'orphan-diff orphan-anchored-diff' });
    quoted.appendChild(
      buildUnifiedDiff(
        parseSnapshotLines(
          (orphan.diffText ?? '')
            .split('\n')
            .slice(anchored.anchorStart, anchored.anchorEnd + 1)
            .join('\n'),
        ),
        getPrismLanguage(orphan.filePath),
      ),
    );
    detail.appendChild(quoted);
    detail.appendChild(createEl('p', { className: 'orphan-comment', text: anchored.text }));
  }

  const actions = createEl('div', { className: 'orphan-actions' });
  const discardBtn = createEl('button', { className: 'comment-btn comment-btn-danger', text: 'Discard' });
  discardBtn.type = 'button';
  discardBtn.addEventListener('click', () => discardOrphan(orphan.key));
  actions.append(discardBtn, createEl('span', { className: 'orphan-keep-hint', text: 'leave it alone to keep it' }));
  detail.appendChild(actions);
  card.appendChild(detail);

  wireCollapse({
    header,
    chevron,
    detail,
    kind: ORPHAN_CARD_KIND,
    key: orphan.key,
    onApply: (isExpanded) => {
      // Same rule as a collapsed annotation: the summary stands in for the
      // text below it, so it goes away once that text is on screen.
      summary.hidden = isExpanded;
      more.hidden = isExpanded || extra === 0;
      card.classList.toggle('orphan-collapsed', !isExpanded);
    },
  });

  return card;
}

async function discardOrphan(key) {
  clearError();
  try {
    await api.discardOrphan(appState.repo, key);
  } catch (err) {
    showError(err.message);
    return;
  }
  if (appState.tree) {
    appState.tree.orphans = appState.tree.orphans.filter((o) => o.key !== key);
  }
  // Discard removes both annotation types for this key (see state.js
  // discardOrphan), so both collapse entries go with them -- and so does the
  // card's own, which would otherwise sit in localStorage until the next
  // load's prune.
  forgetAnnotationExpanded('comment', key);
  forgetAnnotationExpanded('note', key);
  forgetAnnotationExpanded(ORPHAN_CARD_KIND, key);

  // Re-render rather than just removing the one card: the heading now states
  // a count, and with the section collapsible that count is the only thing
  // an unopened section shows, so leaving it stale is no longer a cosmetic
  // detail. renderOrphans also re-derives the "no longer in this diff" group
  // and re-hides the whole section when the last orphan goes, which the old
  // remove-the-node path had to special-case.
  const wasFocused = orphansRootEl && orphansRootEl.contains(document.activeElement);
  renderOrphans();
  // The Discard button that had focus does not exist any more. Send focus to
  // the section's toggle (still the same region the user was working in)
  // instead of letting it fall to <body>, where Tab would restart from the
  // top of the document.
  if (wasFocused && orphansToggleEl && !orphansRootEl.hidden) orphansToggleEl.focus();
}
