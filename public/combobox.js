// combobox.js -- the type-to-filter ref picker that replaced the native
// <select> in the base/target pickers.
//
// Why it exists: `git branch --list` sorted alphabetically, so on a repo with
// 35+ `fix/<issue-number>` branches the numerically-lowest (oldest, least
// relevant) branch sat at the top and today's work was buried inside a
// scrolling native dropdown. Recency ordering fixes half of that (git.js);
// this fixes the other half -- typing `25206` narrows 35 entries to one.
//
// A native <select> gives keyboard support and screen-reader semantics for
// free, and this gives all of that up, so it has to pay it back by hand. What
// is implemented here is the WAI-ARIA combobox-with-listbox pattern:
//
//   role="combobox" on the text input, with aria-expanded, aria-controls
//   pointing at the listbox, aria-autocomplete="list", and
//   aria-activedescendant naming the currently highlighted option (the input
//   keeps DOM focus throughout -- that is the point of activedescendant);
//   role="listbox" on the popup with role="option" + aria-selected on each
//   row; ArrowDown/ArrowUp to move, Enter to commit, Escape to close and
//   revert, and a visible focus ring (see .combobox-input:focus-visible and
//   the .active option style in style.css).
//
// Matching is plain case-insensitive substring, deliberately -- fuzzy
// matching would reorder results, and the whole value of this control is
// that the order means something (recency).
//
// ---------------------------------------------------------------------------
// The keyboard-shortcut trap, and why the flag cannot get stuck.
//
// keyboard.js binds BARE single keys on `document` -- j k x u c f b 1 2 ? --
// so typing a branch name here would otherwise fire every one of them. There
// are three independent layers stopping that, because the codebase has
// already been burned once by a stale `isEditing` flag leaving shortcuts live
// under an open editor:
//
//   1. This input stops keydown/keypress/keyup from propagating at all, the
//      same thing the comment textarea does (see enterCommentEdit in
//      comments.js). Nothing typed here can reach the document handler even
//      if both flags below were wrong.
//   2. keyboard.js's own isTypingTarget() already returns true for a text
//      <input>, independently of any state this module keeps.
//   3. appState.isEditing, claimed on focus and released on blur.
//
// Layer 3 is the one that can get stuck, in either direction, so it is
// ownership-tracked exactly the way comments.js tracks its editors:
// claimEditing() stamps appState.editingKind/editingKey with THIS combobox's
// identity, and releaseEditing() clears the flag only if that stamp is still
// ours. That is what makes the two failure modes impossible:
//
//   - stuck TRUE (shortcuts dead forever): the only way to leave the input is
//     blur, and blur always releases. Escape and selection deliberately do
//     NOT release -- focus is still in the input after both, so the flag is
//     still correct. setItems() re-rendering the picker underneath cannot
//     orphan the flag either: it rebuilds only the listbox children, never
//     the input, so focus and the claim survive it. For the case where the
//     picker is re-rendered while unfocused, setItems() releases a claim that
//     is ours but no longer backed by focus.
//   - stuck FALSE (shortcuts live under an open editor): releaseEditing()
//     refuses to clear a claim belonging to someone else, so blurring this
//     input on the way into a comment textarea -- or a comment editor opening
//     first and this blurring second -- can never clear the other one's flag.
// ---------------------------------------------------------------------------

import { appState, createEl } from './state.js';

const EDIT_KIND = 'refPicker';

let comboSeq = 0;

// ---------------------------------------------------------------------------
// Reused, not forked, for the per-commit picker.
//
// The commit picker (topbar.js) lists subject + author + date per row and
// looks less like a "ref name" picker than the two it was built for -- but
// everything that is HARD here is exactly what it needs: the full ARIA
// combobox/listbox pattern, activedescendant roving, Enter/Escape semantics,
// and above all the three-layer guard above that keeps keyboard.js's bare
// single-key shortcuts from firing while the user types. Writing a second
// widget would mean re-deriving all three layers and getting one of them
// wrong. The row model (label + meta + badge + title + separators) already
// carries three fields per row, and type-to-filter over commit subjects is
// directly useful on a branch with 20 commits.
//
// Three small, default-preserving options exist for it: `emptyText` (the
// no-match line says "ref" otherwise), `maxWidth` (a commit's shortSha +
// subject does not fit the 160px cap sized for branch names), and a per-item
// `search` string (so a commit can be found by author too, without the author
// having to be part of its visible label).
// ---------------------------------------------------------------------------

/**
 * @param {object} options
 * @param {string} options.id        id for the input (kept stable; the
 *                                   listbox id is derived from it)
 * @param {string} options.label     accessible name for input + listbox
 * @param {string} [options.placeholder]
 * @param {string} [options.emptyText] shown when nothing matches the filter
 * @param {number} [options.maxWidth] widest the input may grow, in px
 * @returns {object} the combobox handle -- see the returned object below
 */
export function createCombobox({
  id,
  label,
  placeholder = '',
  emptyText = '沒有符合的 ref',
  maxWidth = 160,
}) {
  const comboId = `${id}-${++comboSeq}`;
  const listId = `${id}-listbox`;

  const root = createEl('div', { className: 'combobox' });

  const input = createEl('input', { className: 'combobox-input' });
  input.id = id;
  input.type = 'text';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.placeholder = placeholder;
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-expanded', 'false');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-controls', listId);
  input.setAttribute('aria-label', label);
  input.setAttribute('aria-haspopup', 'listbox');
  // style.css caps .combobox-input at the branch-name width; a caller that
  // asks for more has to lift that cap as well as set the inline width.
  input.style.maxWidth = `${maxWidth}px`;

  const list = createEl('ul', { className: 'combobox-list' });
  list.id = listId;
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-label', label);
  list.hidden = true;

  // Off-screen text-width probe. A text input has no content-based intrinsic
  // width, so without this the closed picker would always occupy its maximum
  // -- and the top bar has no room to spare. The native <select> this
  // replaced sized itself to its selected option (a 4-character "main" took
  // ~64px, not 160), and losing that pushed the bar onto a second row at
  // narrower viewports. This restores the old behaviour: size to the
  // committed name when closed, expand to the cap while focused so there is
  // room to type a long branch name.
  const sizer = createEl('span', { className: 'combobox-sizer' });
  sizer.setAttribute('aria-hidden', 'true');

  root.append(input, sizer, list);

  // ---- state ----
  // items: [{ value, label, meta, badge, dimmed, search } | { separator: true, label }]
  let items = [];
  let visible = [];        // the filtered subset actually rendered
  // The text the list is currently filtered by. NOT simply input.value:
  // opening the picker must show every ref, even though the input already
  // holds the committed selection ("main" would otherwise filter 32 branches
  // down to 1 the moment you clicked in). It only starts tracking input.value
  // once the user actually types.
  let filterQuery = '';
  let optionEls = [];      // parallel to `visible`, null for separators
  let activeIndex = -1;    // index into `visible`, always an option or -1
  let value = null;
  let isOpen = false;

  const handle = {
    rootEl: root,
    inputEl: input,
    /** Called with the newly chosen value when the user commits a selection. */
    onSelect: null,
    setItems,
    setValue,
    getValue: () => value,
  };

  // -------------------------------------------------------------------------
  // appState.isEditing ownership -- see the block comment at the top.
  // -------------------------------------------------------------------------

  function ownsEditing() {
    return appState.editingKind === EDIT_KIND && appState.editingKey === comboId;
  }

  function claimEditing() {
    appState.isEditing = true;
    appState.editingKind = EDIT_KIND;
    appState.editingKey = comboId;
  }

  function releaseEditing() {
    if (!ownsEditing()) return;
    appState.isEditing = false;
    appState.editingKind = null;
    appState.editingKey = null;
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  function labelForValue(v) {
    const item = items.find((i) => !i.separator && i.value === v);
    return item ? item.label : (v ?? '');
  }

  /**
   * Filters `items` down to what should be rendered for `query`, keeping a
   * group heading only when at least one option under it survived -- a
   * dangling "already merged into main" heading with nothing beneath it
   * reads as a bug.
   */
  function filterItems(query) {
    const q = query.trim().toLowerCase();
    // `search` lets an item be findable by text that is not part of its
    // visible label (a commit's author, say). Defaults to the label, which is
    // what the ref pickers have always matched on.
    const matches = (item) =>
      q === '' || (item.search ?? item.label).toLowerCase().includes(q);

    const out = [];
    let pendingSeparator = null;
    for (const item of items) {
      if (item.separator) {
        pendingSeparator = item;
        continue;
      }
      if (!matches(item)) continue;
      if (pendingSeparator) {
        out.push(pendingSeparator);
        pendingSeparator = null;
      }
      out.push(item);
    }
    return out;
  }

  function render() {
    list.textContent = '';
    optionEls = [];

    if (visible.length === 0) {
      const empty = createEl('li', { className: 'combobox-empty', text: emptyText });
      empty.setAttribute('role', 'presentation');
      list.appendChild(empty);
      optionEls.push(null);
      return;
    }

    visible.forEach((item, index) => {
      if (item.separator) {
        const sep = createEl('li', { className: 'combobox-sep', text: item.label });
        sep.setAttribute('role', 'presentation');
        list.appendChild(sep);
        optionEls.push(null);
        return;
      }

      const li = createEl('li', { className: 'combobox-option' });
      li.id = `${listId}-opt-${index}`;
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', String(item.value === value));
      if (item.dimmed) li.classList.add('dimmed');
      if (index === activeIndex) li.classList.add('active');

      // Branch names come from the repo and can contain anything -- every
      // string here goes in via createEl's textContent. Never innerHTML.
      li.appendChild(createEl('span', { className: 'combobox-option-name', text: item.label }));
      if (item.badge) {
        li.appendChild(createEl('span', { className: 'combobox-option-badge', text: item.badge }));
      }
      if (item.meta) {
        li.appendChild(createEl('span', { className: 'combobox-option-meta', text: item.meta }));
      }
      li.title = item.title || item.label;

      // Keeps focus in the input: a plain click would blur it first, and blur
      // closes and reverts, so the click would land on a detached list.
      li.addEventListener('mousedown', (e) => e.preventDefault());
      li.addEventListener('click', () => {
        activeIndex = index;
        commitActive();
      });

      list.appendChild(li);
      optionEls.push(li);
    });

    syncActiveDescendant();
  }

  function syncActiveDescendant() {
    optionEls.forEach((el, i) => {
      if (!el) return;
      el.classList.toggle('active', i === activeIndex);
    });
    const activeEl = activeIndex >= 0 ? optionEls[activeIndex] : null;
    if (activeEl) {
      input.setAttribute('aria-activedescendant', activeEl.id);
      activeEl.scrollIntoView({ block: 'nearest' });
    } else {
      input.removeAttribute('aria-activedescendant');
    }
  }

  function firstOptionIndex(from = 0, step = 1) {
    for (let i = from; i >= 0 && i < visible.length; i += step) {
      if (!visible[i].separator) return i;
    }
    return -1;
  }

  // -------------------------------------------------------------------------
  // Open / close / commit
  // -------------------------------------------------------------------------

  function open() {
    if (isOpen) return;
    isOpen = true;
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
  }

  function close() {
    if (!isOpen) return;
    isOpen = false;
    list.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    activeIndex = -1;
  }

  /**
   * Restores the input text to the committed selection, discarding typing.
   *
   * Re-selects the text if the field still has focus (Escape, and committing
   * a choice, both land here). Without that, the caret sits at the end of the
   * restored name and the next thing typed APPENDS to it -- "main" + "27222"
   * = "main27222", which matches nothing and looks like the filter is broken.
   * Leaving it selected means the field behaves identically however you got
   * back to it: type, and you replace.
   */
  function revert() {
    input.value = labelForValue(value);
    input.title = value ?? '';
    syncWidth();
    if (document.activeElement === input) input.select();
  }

  const MIN_INPUT_WIDTH = 56;
  const MAX_INPUT_WIDTH = maxWidth;

  function syncWidth() {
    if (document.activeElement === input) {
      input.style.width = `${MAX_INPUT_WIDTH}px`;
      return;
    }
    sizer.textContent = input.value || input.placeholder || '';
    const measured = Math.ceil(sizer.getBoundingClientRect().width) + 18; // + padding/border
    input.style.width = `${Math.min(MAX_INPUT_WIDTH, Math.max(MIN_INPUT_WIDTH, measured))}px`;
  }

  function refilter() {
    visible = filterItems(filterQuery);
    // Highlight the committed value if it is still on screen, otherwise the
    // first match -- so opening the picker lands on where you already are,
    // and typing lands on the best match.
    const currentIdx = visible.findIndex((i) => !i.separator && i.value === value);
    activeIndex = filterQuery === '' && currentIdx !== -1 ? currentIdx : firstOptionIndex();
    render();
  }

  function commitActive() {
    const item = activeIndex >= 0 ? visible[activeIndex] : null;
    if (!item || item.separator) {
      revert();
      close();
      return;
    }
    const changed = item.value !== value;
    value = item.value;
    revert();
    close();
    // Focus deliberately stays in the input, so the editing claim stays
    // valid and is NOT released here -- see the block comment at the top.
    if (changed && typeof handle.onSelect === 'function') handle.onSelect(value);
  }

  // -------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------

  input.addEventListener('focus', () => {
    claimEditing();
    syncWidth();
    filterQuery = '';
    open();
    refilter();
    // Select-all so the first keystroke replaces the committed name rather
    // than appending to it.
    input.select();
  });

  // Clicking into the field must leave the whole committed name selected, so
  // the first character typed REPLACES it. focus's input.select() is not
  // enough on its own: the mouseup that follows collapses that selection to a
  // caret, so a click-then-type produced "main25206" and matched nothing.
  // Re-selecting on the mouseup of the click that did the focusing is the
  // standard fix; subsequent clicks inside an already-focused field are left
  // alone so the user can still position a caret to edit.
  let selectOnMouseUp = false;

  input.addEventListener('mousedown', () => {
    selectOnMouseUp = document.activeElement !== input;
    // Clicking an already-focused input should reopen a closed list.
    if (document.activeElement === input && !isOpen) {
      filterQuery = '';
      open();
      refilter();
    }
  });

  input.addEventListener('mouseup', (e) => {
    if (!selectOnMouseUp) return;
    selectOnMouseUp = false;
    e.preventDefault();
    input.select();
  });

  input.addEventListener('blur', () => {
    // revert() calls syncWidth(), which now measures the unfocused case.
    revert();
    close();
    releaseEditing();
  });

  input.addEventListener('input', () => {
    filterQuery = input.value;
    open();
    refilter();
  });

  // Nothing typed in this field may reach keyboard.js's document handler --
  // layer 1 of the three described at the top.
  const stop = (e) => e.stopPropagation();
  input.addEventListener('keypress', stop);
  input.addEventListener('keyup', stop);

  input.addEventListener('keydown', (e) => {
    switch (e.key) {
      case 'ArrowDown': {
        e.preventDefault();
        if (!isOpen) { filterQuery = ''; open(); refilter(); break; }
        const next = firstOptionIndex(activeIndex + 1, 1);
        if (next !== -1) activeIndex = next;
        syncActiveDescendant();
        break;
      }
      case 'ArrowUp': {
        e.preventDefault();
        if (!isOpen) { filterQuery = ''; open(); refilter(); break; }
        const prev = firstOptionIndex(activeIndex - 1, -1);
        if (prev !== -1) activeIndex = prev;
        syncActiveDescendant();
        break;
      }
      case 'Enter':
        e.preventDefault();
        if (isOpen) commitActive();
        break;
      case 'Escape':
        e.preventDefault();
        revert();
        close();
        break;
      case 'Tab':
        // Let focus move; blur's handler reverts and releases.
        close();
        break;
      default:
        break;
    }
    stop(e);
  });

  // -------------------------------------------------------------------------
  // Public setters
  // -------------------------------------------------------------------------

  function setItems(nextItems) {
    items = nextItems;
    if (document.activeElement !== input) {
      filterQuery = '';
      revert();
      // Defensive: a claim that is ours but no longer backed by focus would
      // be exactly the "stuck true" state that kills every shortcut.
      releaseEditing();
    }
    // Always re-render, focused or not. The merged marks change whenever the
    // base does, and the base picker is the thing that has focus at that
    // moment -- if the unfocused target list only rebuilt on its next open,
    // it would sit there holding marks computed against the PREVIOUS base.
    // Focused, the user's typed query is preserved instead of being reset.
    refilter();
  }

  function setValue(nextValue) {
    value = nextValue;
    if (document.activeElement !== input) revert();
    else syncWidth();
  }

  return handle;
}
