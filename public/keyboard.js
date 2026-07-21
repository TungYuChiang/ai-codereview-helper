// keyboard.js -- keyboard shortcuts + help overlay. Split out of app.js as
// a pure move (see state.js's header comment).
//
// Single-key shortcuts (j/k/x/u/c/f/1/2/?) live in one document-level
// keydown handler, gated by two independent checks per the brief:
// appState.isEditing (true for the whole life of an open comment textarea
// -- see EXTENSION POINT 5 in state.js) and the event's own target
// (input/textarea/contenteditable), so a comment field losing track of
// isEditing for any reason still can't leak keystrokes into navigation.
// `space` is deliberately never handled here -- the browser's own scroll
// behavior for it is exactly what the addendum's target user wants, and
// intercepting it would be a regression, not a feature.
//
// All the actions below reuse openChangePoint()/moveSelection() (pane.js --
// the file-crossing-aware wrappers around nav.js's lower-level
// selectChangePoint, see pane.js's own header comment for why moveSelection
// and the u-handler's target-selection both need to live there instead of
// nav.js) and the existing click-driven handlers (onToggleCheck,
// enterCommentEdit, toggleCollapse, setViewMode) -- no parallel navigation
// or state model is introduced here.

import { appState, dom, createEl, appEl } from './state.js';
import { toggleCollapse } from './tree.js';
import { onToggleCheck } from './nav.js';
import { moveSelection, openChangePoint } from './pane.js';
import { enterCommentEdit } from './comments.js';
import { setViewMode } from './topbar.js';
import { toggleSidebar } from './prefs.js';

// <input type="checkbox|radio|button"> does not accept text entry, so it
// must not count as a "typing target" -- doing so left every single-key
// shortcut dead after an ordinary mouse click on a review checkbox, until
// focus moved elsewhere. <button> elements were never affected (tagName is
// 'BUTTON', not 'INPUT') -- this only narrows the INPUT branch. Only
// genuine text-entry contexts count: text-like <input> types, <textarea>,
// and contenteditable.
const NON_TEXT_INPUT_TYPES = new Set(['checkbox', 'radio', 'button']);

function isTypingTarget(target) {
  if (!target) return false;
  const tag = target.tagName;
  if (tag === 'INPUT') return !NON_TEXT_INPUT_TYPES.has(target.type);
  if (tag === 'TEXTAREA') return true;
  return Boolean(target.isContentEditable);
}

// `f`: fold/unfold the tree node the current change point lives under. Most
// change points hang under a function group; the file-level bucket (group
// === null, see renderFileNode in tree.js) has no function level, so this
// falls back to folding the file itself instead of doing nothing.
function handleToggleCurrentFold() {
  const key = appState.currentKey;
  if (!key) return;
  const entry = dom.changePoints.get(key);
  if (!entry) return;
  if (entry.groupKey) {
    toggleCollapse(`group:${entry.groupKey}`, 'group', entry.groupKey);
  } else {
    toggleCollapse(`file:${entry.file.path}`, 'file', entry.file.path);
  }
}

// `x`: asymmetric by design (brief) -- checking advances to the next change
// point, unchecking stays put, because unchecking means "wait, I need to
// look at this again" and jumping away at that moment is exactly wrong.
async function handleToggleCurrentChecked() {
  const key = appState.currentKey;
  if (!key) return;
  const entry = dom.changePoints.get(key);
  if (!entry) return;
  const wasChecked = entry.changePoint.checked;
  await onToggleCheck(key, !wasChecked);
  // Read the post-request state rather than assuming the toggle succeeded --
  // onToggleCheck leaves changePoint.checked untouched on a failed request
  // (see its catch block), so a failed check naturally does not advance.
  if (!wasChecked && entry.changePoint.checked) {
    moveSelection(1);
  }
}

function handleOpenCommentForCurrent() {
  const key = appState.currentKey;
  if (!key) return;
  const entry = dom.changePoints.get(key);
  // commentEl only exists once this change point's file has been opened --
  // appState.currentKey is kept pointing into the displayed file by
  // construction (see pane.js's openChangePoint/openFile), so this should
  // always be true in practice; defensive guard rather than a hard
  // assumption.
  if (!entry || !entry.commentEl) return;
  enterCommentEdit(entry);
}

// `u`: cyclic search starting just after the current change point, so a
// change point the user unchecked earlier ("wait, I need to look again") is
// still reachable even after scrolling past it -- not just a forward-only
// scan from the top. Gives explicit feedback (a toast) when nothing is
// unread, per the brief -- silently doing nothing on `u` would look broken.
function jumpToNextUnread() {
  const order = appState.order;
  if (order.length === 0) return;
  const currentIdx = appState.currentKey ? order.indexOf(appState.currentKey) : -1;
  for (let step = 1; step <= order.length; step++) {
    const key = order[(currentIdx + step) % order.length];
    const entry = dom.changePoints.get(key);
    if (entry && !entry.changePoint.checked) {
      openChangePoint(key, { scroll: true });
      return;
    }
  }
  showToast('All caught up — nothing unread left.');
}

function handleGlobalKeydown(e) {
  // The overlay owns Escape unconditionally while it is open. This branch
  // can't fire from inside the comment textarea itself -- that field's own
  // keydown handler calls stopPropagation for every key (see
  // enterCommentEdit in comments.js) -- so it is safe to check before the
  // isEditing guard below without reopening the "typing leaks into
  // shortcuts" hole.
  if (shortcutOverlayOpen) {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeShortcutOverlay();
    }
    return;
  }

  // Two independent guards, per brief: appState.isEditing covers the whole
  // lifetime of an open comment textarea; the target check covers focus
  // being in *any* input/textarea/contenteditable even if isEditing were
  // somehow stale. Either one alone is enough to bail out -- see brief's
  // "正在編輯 comment 時... 焦點在任何 input/textarea/contenteditable 內時也
  // 一律不觸發".
  if (appState.isEditing) return;
  if (isTypingTarget(e.target)) return;
  // Leave modified key combos (Cmd/Ctrl/Alt+letter) to the browser/OS --
  // these are single, unmodified keys only.
  if (e.metaKey || e.ctrlKey || e.altKey) return;

  switch (e.key) {
    case 'j':
      e.preventDefault();
      moveSelection(1);
      break;
    case 'k':
      e.preventDefault();
      moveSelection(-1);
      break;
    case 'x':
      e.preventDefault();
      handleToggleCurrentChecked();
      break;
    case 'u':
      e.preventDefault();
      jumpToNextUnread();
      break;
    case 'c':
      e.preventDefault();
      handleOpenCommentForCurrent();
      break;
    case 'f':
      e.preventDefault();
      handleToggleCurrentFold();
      break;
    case 'b':
      e.preventDefault();
      toggleSidebar();
      break;
    case '1':
      e.preventDefault();
      setViewMode('unified');
      break;
    case '2':
      e.preventDefault();
      setViewMode('side-by-side');
      break;
    case '?':
      e.preventDefault();
      openShortcutOverlay();
      break;
    default:
      // Deliberately no case for ' ' (space) -- see block comment above.
      break;
  }
}

document.addEventListener('keydown', handleGlobalKeydown);

// ---------------------------------------------------------------------------
// Transient toast -- feedback for shortcuts with no visible change to show
// (currently only `u` with nothing unread left). Note-colored, matching
// .hint's semantics (attention, not error/destructive).
// ---------------------------------------------------------------------------

let toastEl = null;
let toastTimeoutId = null;

function ensureToastEl() {
  if (toastEl) return toastEl;
  toastEl = createEl('div', { className: 'shortcut-toast' });
  toastEl.setAttribute('role', 'status');
  toastEl.setAttribute('aria-live', 'polite');
  appEl.appendChild(toastEl);
  return toastEl;
}

function showToast(message) {
  const el = ensureToastEl();
  el.textContent = message;
  el.classList.remove('visible');
  void el.offsetWidth; // restart the transition if a toast is already showing
  el.classList.add('visible');
  if (toastTimeoutId) clearTimeout(toastTimeoutId);
  toastTimeoutId = setTimeout(() => el.classList.remove('visible'), 1800);
}

// ---------------------------------------------------------------------------
// Shortcut overlay -- the "?" table. Built lazily (same pattern as the
// clipboard fallback in export.js) and reused across opens/closes rather
// than rebuilt each time.
// ---------------------------------------------------------------------------

const SHORTCUT_TABLE = [
  ['j / k', 'next / previous change point'],
  ['x', 'mark reviewed — checking advances, unchecking stays'],
  ['u', 'jump to next unread change point'],
  ['c', 'edit comment on the current change point'],
  ['f', 'collapse / expand the current function'],
  ['b', 'collapse / expand the whole sidebar'],
  ['1 / 2', 'unified / side-by-side view'],
  ['?', 'toggle this help'],
  ['space', 'browser scroll — not intercepted'],
];

let shortcutOverlayEl = null;
let shortcutOverlayOpen = false;
let lastFocusedBeforeOverlay = null;

function ensureShortcutOverlayEl() {
  if (shortcutOverlayEl) return shortcutOverlayEl;

  const backdrop = createEl('div', { className: 'shortcut-overlay-backdrop' });
  backdrop.hidden = true;
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) closeShortcutOverlay();
  });

  const dialog = createEl('div', { className: 'shortcut-overlay' });
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-label', 'Keyboard shortcuts');

  const header = createEl('div', { className: 'shortcut-overlay-header' });
  header.appendChild(createEl('h2', { className: 'shortcut-overlay-heading', text: 'Keyboard shortcuts' }));
  const closeBtn = createEl('button', { className: 'shortcut-overlay-close', text: '×' });
  closeBtn.type = 'button';
  closeBtn.setAttribute('aria-label', 'close');
  closeBtn.addEventListener('click', () => closeShortcutOverlay());
  header.appendChild(closeBtn);
  dialog.appendChild(header);

  const list = createEl('dl', { className: 'shortcut-overlay-list' });
  for (const [key, desc] of SHORTCUT_TABLE) {
    list.appendChild(createEl('dt', { text: key }));
    list.appendChild(createEl('dd', { text: desc }));
  }
  dialog.appendChild(list);

  backdrop.appendChild(dialog);
  appEl.appendChild(backdrop);

  shortcutOverlayEl = backdrop;
  shortcutOverlayEl._closeBtn = closeBtn;
  return backdrop;
}

function openShortcutOverlay() {
  const el = ensureShortcutOverlayEl();
  lastFocusedBeforeOverlay = document.activeElement;
  el.hidden = false;
  shortcutOverlayOpen = true;
  el._closeBtn.focus();
}

function closeShortcutOverlay() {
  if (shortcutOverlayEl) shortcutOverlayEl.hidden = true;
  shortcutOverlayOpen = false;
  if (lastFocusedBeforeOverlay && typeof lastFocusedBeforeOverlay.focus === 'function') {
    lastFocusedBeforeOverlay.focus();
  }
  lastFocusedBeforeOverlay = null;
}

// The footer's "?" hint (public/index.html) ships as inert markup -- this
// upgrades it into the real, always-available entry point the brief asks
// for ("這個按鈕不是裝飾，是主要入口") without touching index.html: same
// element position, same class (style.css's `#shortcut-bar .shortcut-help`
// rule still applies unchanged), just swapped from a <span> to a real
// <button> so it is keyboard-focusable and clickable for free.
const shortcutHelpSourceEl = document.querySelector('#shortcut-bar .shortcut-help');
if (shortcutHelpSourceEl) {
  const shortcutHelpBtn = createEl('button', {
    className: 'shortcut-help',
    text: shortcutHelpSourceEl.textContent,
  });
  shortcutHelpBtn.type = 'button';
  shortcutHelpBtn.setAttribute('aria-label', 'keyboard shortcuts');
  shortcutHelpBtn.addEventListener('click', () => openShortcutOverlay());
  shortcutHelpSourceEl.replaceWith(shortcutHelpBtn);
}
