// comments.js -- comment UI (add/edit/delete per change point) and the
// orphaned-comment area. Split out of app.js as a pure move (see state.js's
// header comment).

import { appState, dom, createEl, mainPaneEl } from './state.js';
import { api, clearError, showError } from './api.js';

// ===========================================================================
// EXTENSION POINT 4 continued -- comment UI, attached to every change point
// via its container's data-key (set by pane.js's renderChangePointPane).
// Called once per file open (see pane.js's renderFilePane), after every one
// of that file's change points exists, so it never has to guess at DOM
// ordering.
//
// A comment section has two mutually exclusive render states:
//   - view mode: existing comment text (or an "add comment" affordance)
//   - edit mode: a textarea, Esc to cancel / Cmd|Ctrl+Enter to save
//
// Saving always goes through POST /api/comment and updates the in-memory
// changePoint + DOM in place -- no refetch of the tree (see saveComment).
// Comments themselves are global regardless of which file is displayed
// (they live on changePoint.comment, part of the shared model, not on
// anything file-view-scoped) -- only their DOM only exists for the change
// points currently rendered, which this loop's `if (!entry.rightContainer)`
// guard accounts for (single-file-view unit: most entries, at any given
// moment, belong to a file that isn't the one open).
// ===========================================================================

export function renderAllComments() {
  for (const entry of dom.changePoints.values()) {
    if (!entry.rightContainer) continue;
    if (!entry.commentEl) {
      const section = createEl('div', { className: 'comment-section' });
      // Programmatically focusable (tabIndex -1) but not a Tab stop: this is
      // where focus lands after a save/cancel (see renderCommentView's
      // focusTrigger below), instead of on the Edit/+Comment button. Landing
      // on an activatable <button> there means a `space` press right after
      // saving a comment -- exactly the rhythm the brief calls out ("save a
      // comment, then press space to keep reading") -- activates the button
      // and reopens the editor instead of scrolling. A non-interactive
      // container has no activation behavior, so `space` falls through to
      // the browser's native scroll. The Edit/+Comment button itself is
      // untouched and still reachable by tabbing through the document in
      // order.
      section.tabIndex = -1;
      entry.rightContainer.appendChild(section);
      entry.commentEl = section;
    }
    renderCommentView(entry);
  }
}

// View mode: shows the saved comment (via textContent only -- comment text
// comes from the reviewed repo's own diff plus whatever the user typed, and
// must never be interpreted as markup) plus Edit/Delete, or an "add
// comment" button when there is none yet.
function renderCommentView(entry, { focusTrigger = false } = {}) {
  const { commentEl, changePoint } = entry;
  commentEl.textContent = '';

  if (changePoint.comment) {
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

    commentEl.appendChild(body);
    // Focus the section container, not editBtn -- see the tabIndex comment
    // in renderAllComments for why (space-reopens-editor bug, finding 2).
    if (focusTrigger) commentEl.focus();
  } else {
    const addBtn = createEl('button', { className: 'comment-btn comment-add-btn', text: '+ Comment' });
    addBtn.type = 'button';
    addBtn.addEventListener('click', () => enterCommentEdit(entry));
    commentEl.appendChild(addBtn);
    // Focus the section container, not addBtn -- see the tabIndex comment
    // in renderAllComments for why (space-reopens-editor bug, finding 2).
    if (focusTrigger) commentEl.focus();
  }
}

// Edit mode. Sets appState.isEditing -- see EXTENSION POINT 5 in state.js's
// appState declaration -- for the whole time the textarea exists.
export function enterCommentEdit(entry) {
  // Only one change point can be in edit mode at a time, so editingKey is
  // always an accurate answer to "which one" -- opening a second editor
  // auto-cancels the first (same as Esc: discards unsaved text).
  if (appState.editingKey && appState.editingKey !== entry.changePoint.id) {
    const other = dom.changePoints.get(appState.editingKey);
    if (other) renderCommentView(other);
  }

  appState.isEditing = true;
  appState.editingKey = entry.changePoint.id;

  const { commentEl, changePoint } = entry;
  commentEl.textContent = '';

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

  commentEl.append(textarea, hint, actions);
  textarea.focus();
  textarea.setSelectionRange(textarea.value.length, textarea.value.length);
}

function exitCommentEdit(entry) {
  appState.isEditing = false;
  appState.editingKey = null;
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

  // Only clear the shared editing flag if `entry` is the change point it
  // actually refers to. saveComment is also reached directly from the
  // view-mode Delete button (no editor open for that entry at all), so an
  // unconditional reset here can clobber appState.isEditing/editingKey out
  // from under an *unrelated* change point's still-open textarea -- at which
  // point every single-key shortcut goes live while a comment editor is
  // visibly open and still holds the user's unsaved text. Mirrors the guard
  // enterCommentEdit already applies before stealing edit mode from another
  // entry.
  if (appState.editingKey === entry.changePoint.id) {
    appState.isEditing = false;
    appState.editingKey = null;
  }
  renderCommentView(entry, { focusTrigger: true });
}

// ===========================================================================
// Orphan comments -- change points whose underlying diff no longer exists
// (GET /api/diff's `orphans` array; see state.js buildAnnotated on the
// backend). Never silently dropped: shown in their own section with the
// filePath / functionName / diffText snapshot the comment was originally
// attached to, entirely via textContent (that snapshot is reviewed-repo
// content and must never be treated as markup). "Keep" needs no API call --
// not touching an orphan *is* keeping it; only "discard" hits the network.
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

  card.appendChild(createEl('p', { className: 'orphan-comment', text: orphan.text }));

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
