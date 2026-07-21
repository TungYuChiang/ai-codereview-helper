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
    const body = createEl('div', { className: 'comment-body' });
    body.appendChild(createEl('span', { className: 'comment-label', text: 'Comment' }));
    body.appendChild(createEl('p', { className: 'comment-text', text: changePoint.comment }));

    const actions = createEl('div', { className: 'comment-actions' });
    const editBtn = createEl('button', { className: 'comment-btn', text: 'Edit' });
    editBtn.type = 'button';
    editBtn.addEventListener('click', () => enterCommentEdit(entry));
    const deleteBtn = createEl('button', { className: 'comment-btn comment-btn-danger', text: 'Delete' });
    deleteBtn.type = 'button';
    deleteBtn.addEventListener('click', () => saveComment(entry, ''));
    actions.append(editBtn, deleteBtn);
    body.appendChild(actions);

    commentBodyEl.appendChild(body);
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

  appState.isEditing = true;
  appState.editingKey = entry.changePoint.id;
  appState.editingKind = 'comment';

  const { commentBodyEl, changePoint } = entry;
  commentBodyEl.textContent = '';
  commentBodyEl.classList.add('annotation-slot-expanded');

  const textarea = document.createElement('textarea');
  textarea.className = 'comment-textarea';
  textarea.value = changePoint.comment || '';
  textarea.rows = 4;
  textarea.setAttribute('aria-label', 'comment text');

  const hint = createEl('div', {
    className: 'comment-hint',
    text: 'Esc cancel  ·  ⌘/Ctrl+Enter save  ·  clear + save = delete',
  });

  const actions = createEl('div', { className: 'comment-actions' });
  const saveBtn = createEl('button', { className: 'comment-btn comment-btn-primary', text: 'Save' });
  saveBtn.type = 'button';
  saveBtn.addEventListener('click', () => saveComment(entry, textarea.value));
  const cancelBtn = createEl('button', { className: 'comment-btn', text: 'Cancel' });
  cancelBtn.type = 'button';
  cancelBtn.addEventListener('click', () => exitCommentEdit(entry));
  actions.append(saveBtn, cancelBtn);

  // Stop every keyboard event from leaving the textarea: this is the other
  // half of EXTENSION POINT 5 -- even before the keyboard-navigation unit's
  // shortcut handler exists, nothing typed here should ever be treated as
  // anything but text.
  const stop = (e) => e.stopPropagation();
  textarea.addEventListener('keyup', stop);
  textarea.addEventListener('keypress', stop);
  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      exitCommentEdit(entry);
    } else if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      saveComment(entry, textarea.value);
    }
    stop(e);
  });

  commentBodyEl.append(textarea, hint, actions);
  textarea.focus();
  textarea.setSelectionRange(textarea.value.length, textarea.value.length);
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
    const body = createEl('div', { className: 'note-body' });
    body.appendChild(createEl('span', { className: 'note-label', text: 'Note' }));
    body.appendChild(createEl('p', { className: 'note-text', text: changePoint.note }));

    const actions = createEl('div', { className: 'comment-actions' });
    const editBtn = createEl('button', { className: 'comment-btn', text: 'Edit' });
    editBtn.type = 'button';
    editBtn.addEventListener('click', () => enterNoteEdit(entry));
    const deleteBtn = createEl('button', { className: 'comment-btn comment-btn-danger', text: 'Delete' });
    deleteBtn.type = 'button';
    deleteBtn.addEventListener('click', () => saveNote(entry, ''));
    actions.append(editBtn, deleteBtn);
    body.appendChild(actions);

    noteBodyEl.appendChild(body);
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

  appState.isEditing = true;
  appState.editingKey = entry.changePoint.id;
  appState.editingKind = 'note';

  const { noteBodyEl, changePoint } = entry;
  noteBodyEl.textContent = '';
  noteBodyEl.classList.add('annotation-slot-expanded');

  const textarea = document.createElement('textarea');
  textarea.className = 'comment-textarea';
  textarea.value = changePoint.note || '';
  textarea.rows = 4;
  textarea.setAttribute('aria-label', 'note text');

  const hint = createEl('div', {
    className: 'comment-hint',
    text: 'Esc cancel  ·  ⌘/Ctrl+Enter save  ·  clear + save = delete',
  });

  const actions = createEl('div', { className: 'comment-actions' });
  const saveBtn = createEl('button', { className: 'comment-btn comment-btn-primary', text: 'Save' });
  saveBtn.type = 'button';
  saveBtn.addEventListener('click', () => saveNote(entry, textarea.value));
  const cancelBtn = createEl('button', { className: 'comment-btn', text: 'Cancel' });
  cancelBtn.type = 'button';
  cancelBtn.addEventListener('click', () => exitNoteEdit(entry));
  actions.append(saveBtn, cancelBtn);

  const stop = (e) => e.stopPropagation();
  textarea.addEventListener('keyup', stop);
  textarea.addEventListener('keypress', stop);
  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      exitNoteEdit(entry);
    } else if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      saveNote(entry, textarea.value);
    }
    stop(e);
  });

  noteBodyEl.append(textarea, hint, actions);
  textarea.focus();
  textarea.setSelectionRange(textarea.value.length, textarea.value.length);
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
// Orphan comments/notes -- change points whose underlying diff no longer
// exists (GET /api/diff's `orphans` array; see state.js buildAnnotated on
// the backend). Never silently dropped: shown in their own section with the
// filePath / functionName / diffText snapshot the annotation(s) were
// originally attached to, entirely via textContent (that snapshot is
// reviewed-repo content and must never be treated as markup). "Keep" needs
// no API call -- not touching an orphan *is* keeping it; only "discard" hits
// the network, and discards BOTH the comment and the note for that key at
// once (see state.js discardOrphan) since the card represents one
// change-point identity, not one annotation type.
// ===========================================================================

let orphansRootEl = null;

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

export function renderOrphans() {
  const root = ensureOrphansRootEl();
  root.textContent = '';

  const orphans = (appState.tree && appState.tree.orphans) || [];
  if (orphans.length === 0) {
    root.hidden = true;
    return;
  }
  root.hidden = false;

  root.appendChild(
    createEl('h2', { className: 'orphans-heading', text: `Orphaned comments (${orphans.length})` }),
  );
  root.appendChild(
    createEl('p', {
      className: 'orphans-note',
      text:
        'These change points no longer exist in the current diff -- the code was edited or removed. ' +
        'Leaving an entry alone keeps it; only "Discard" deletes it.',
    }),
  );

  for (const orphan of orphans) {
    root.appendChild(buildOrphanCard(orphan));
  }
}

function buildOrphanCard(orphan) {
  const card = createEl('div', { className: 'orphan-card' });
  card.dataset.key = orphan.key;

  const meta = createEl('div', { className: 'orphan-meta' });
  meta.appendChild(createEl('span', { className: 'orphan-file', text: orphan.filePath || '(unknown file)' }));
  if (orphan.functionName) {
    meta.appendChild(createEl('span', { className: 'orphan-fn', text: orphan.functionName }));
  }
  card.appendChild(meta);

  const diffPre = createEl('pre', { className: 'orphan-diff' });
  diffPre.textContent = orphan.diffText || '';
  card.appendChild(diffPre);

  // orphan.text/orphan.note are independently nullable (see state.js
  // buildAnnotated) -- an orphan can carry a comment, a note, or both, so
  // each gets its own labeled block only when present.
  if (orphan.text) {
    card.appendChild(createEl('span', { className: 'comment-label', text: 'Comment' }));
    card.appendChild(createEl('p', { className: 'orphan-comment', text: orphan.text }));
  }
  if (orphan.note) {
    card.appendChild(createEl('span', { className: 'note-label', text: 'Note' }));
    card.appendChild(createEl('p', { className: 'orphan-comment orphan-note', text: orphan.note }));
  }

  const actions = createEl('div', { className: 'orphan-actions' });
  const discardBtn = createEl('button', { className: 'comment-btn comment-btn-danger', text: 'Discard' });
  discardBtn.type = 'button';
  discardBtn.addEventListener('click', () => discardOrphan(orphan.key, card));
  actions.append(discardBtn, createEl('span', { className: 'orphan-keep-hint', text: 'leave it alone to keep it' }));
  card.appendChild(actions);

  return card;
}

async function discardOrphan(key, cardEl) {
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
  cardEl.remove();
  if (orphansRootEl && (!appState.tree || appState.tree.orphans.length === 0)) {
    orphansRootEl.hidden = true;
  }
}
