// state.js -- DOM references, central app state, and the one DOM-writing
// helper every other module uses. Split out of the original app.js (see
// docs/dev-log/.superpowers/sdd/task-frontend-modules-brief.md) as a pure
// move: no behaviour changed, only which file this code lives in.
//
// Hard rule carried over unchanged from the original app.js header: file
// paths and diff content come from the reviewed repo and may contain
// anything, including HTML-looking text. Never use innerHTML for that
// content -- always textContent / createElement. See createEl() below, used
// everywhere a string reaches the DOM.

// ===========================================================================
// DOM references
// ===========================================================================

export const sidebarToggleBtnEl = document.getElementById('sidebar-toggle-btn');

export const repoSelectEl = document.getElementById('repo-select');
export const addRepoToggleEl = document.getElementById('add-repo-toggle');
export const addRepoFormEl = document.getElementById('add-repo-form');
export const addRepoInputEl = document.getElementById('add-repo-input');
export const addRepoCancelEl = document.getElementById('add-repo-cancel');
export const addRepoErrorEl = document.getElementById('add-repo-error');

export const baseSelectEl = document.getElementById('base-select');
export const targetSelectEl = document.getElementById('target-select');
export const workingTreeHintEl = document.getElementById('working-tree-hint');

export const viewUnifiedBtnEl = document.getElementById('view-unified-btn');
export const viewSideBySideBtnEl = document.getElementById('view-sidebyside-btn');

export const codeThemeSelectEl = document.getElementById('code-theme-select');

export const statsBadgeEl = document.getElementById('stats-badge');
export const errorBannerEl = document.getElementById('error-banner');

export const treeRootEl = document.getElementById('tree-root');
export const mainPaneEl = document.getElementById('main-pane');
export const filePaneHeaderEl = document.getElementById('file-pane-header');
export const changepointsRootEl = document.getElementById('changepoints-root');

export const appEl = document.getElementById('app');
export const topbarEl = document.getElementById('topbar');
export const bodyEl = document.getElementById('body');

// ===========================================================================
// EXTENSION POINT 2 -- central app state.
//
// Every unit that touches shared state (current repo/base/target, the
// annotated tree, view mode, current change point, comment drafts, ...)
// should add fields here rather than inventing a parallel state object.
// `tree` is the live, mutated-in-place annotated diff from GET /api/diff
// (see applyCheckedChange in nav.js for why it is mutated in place rather
// than re-fetched: refetching would blow away scroll position).
// ===========================================================================

export const appState = {
  repos: [],           // [{id, path, name}]
  repo: null,           // currently selected repo id
  base: null,           // currently selected base ref
  target: null,         // currently selected target ref, or 'WORKING_TREE'
  viewMode: 'unified',  // 'unified' | 'side-by-side' -- diff-rendering unit reads this
  codeTheme: 'default', // one of CODE_THEMES below -- mirrors the <html data-code-theme>
                         // attribute (the actual source of truth for rendering; nothing
                         // reads this field back, it's kept only for the same reason
                         // viewMode/sidebarCollapsed are: one place to inspect current UI
                         // state without digging through the DOM)
  tree: null,           // { files, orphans, stats } from GET /api/diff, mutated in place
  order: [],            // flattened change-point ids, in tree/scroll order, ACROSS EVERY FILE
                         // (not just the one currently displayed) -- this is what lets j/k/u
                         // walk/search past a file boundary, see pane.js's openChangePoint.
  currentKey: null,     // id of the currently selected/highlighted change point
  currentFile: null,    // path of the file currently shown in the right pane -- see
                         // openFile()/renderFilePane() in pane.js (single-file-view unit).
                         // Restored from localStorage on init, same precedent as
                         // repo/base/target/viewMode/sidebarCollapsed (see prefs.js's
                         // LS_KEYS.currentFile).
  collapsed: new Set(), // collapsed tree node ids, e.g. "file:foo.js", "group:foo.js::g0"

  // EXTENSION POINT 5 -- "is editing" flag, for the keyboard-shortcut unit.
  // isEditing is true whenever a comment OR a note textarea is open (add or
  // edit -- see comments.js's enterCommentEdit/enterNoteEdit). The
  // keyboard-navigation unit's document-level keydown handler for
  // j/k/x/u/c/f MUST check `appState.isEditing` first and bail out while
  // it's true, or single-key shortcuts will fire while the user is typing.
  // editingKey names which change point is being edited (or null);
  // editingKind says which of that change point's two editors it is
  // ('comment' | 'note' | null) -- needed because a single change point can
  // have both a comment and a note, so "which key" alone is no longer
  // enough to know which editor to close/re-render. At most one editor (of
  // either kind, on any change point) is ever open at once: opening a
  // second auto-cancels whichever one was open before, exactly like the
  // pre-notes comment-only behavior. isEditing is the boolean the next unit
  // should actually check.
  isEditing: false,
  editingKey: null,
  editingKind: null,

  // Sidebar collapse -- whole #tree-pane, not any individual tree node (that
  // is appState.collapsed above). Restored from localStorage on init, see
  // SIDEBAR_COLLAPSED_KEY in prefs.js.
  sidebarCollapsed: false,
};

// DOM index rebuilt every time the tree is (re)rendered. Not part of
// appState because it holds live element references, not serializable
// application state.
//
// scrollObserver lives here rather than as its own module-level `let` --
// unlike appState/dom (objects mutated in place, so any module can hold a
// reference and see the other's writes), a bare `let` binding can only be
// reassigned by the module that declares it: an ES module's imported
// bindings are read-only in the importing scope. tree.js (which tears the
// observer down and rebuilds the tree) and nav.js (which creates a fresh
// observer for the new tree) both need to reassign it, so it is a property
// on this already-shared, already-mutate-in-place object instead.
// Single-file-view unit: dom.changePoints entries now exist for EVERY change
// point in the tree (all files), because the left tree always lists every
// file -- but the right-pane fields (rightContainer, rightCheckbox,
// contentEl, commentEl, expand) are only populated for whichever file is
// currently displayed (see pane.js's renderChangePointPane/renderFilePane)
// and are explicitly nulled back out when that file is no longer shown. Any
// code touching those fields on an arbitrary key (as opposed to
// appState.currentKey, which is always kept pointing into the displayed
// file -- see pane.js's openChangePoint/openFile) must null-check first.
export const dom = {
  changePoints: new Map(), // key -> { changePoint, group, file, groupKey, leftRow, leftCheckbox, rightContainer, rightCheckbox, contentEl, commentEl, commentBodyEl, noteBodyEl, expand }
  // commentEl is the single shared outer wrapper for BOTH the comment and
  // note UI on a change point (comments.js) -- commentBodyEl/noteBodyEl are
  // its two independently-rendered children. Keeping one wrapper instead of
  // two separate top-level sections is deliberate: with two, an unannotated
  // change point (the common case across a large review) would show two
  // stacked "+ Comment" / "+ Note" affordance rows instead of one, which is
  // exactly the density regression the personal-notes brief warns against.
  groups: new Map(),       // groupKey -> { group, badgeEl, progressFillEl, toggleBtn, childUl }
  files: new Map(),        // path -> { file, badgeEl, progressFillEl, toggleBtn, childUl, headerEl }
  scrollObserver: null,    // current IntersectionObserver for scroll-spy, or null
  filePaneHeaderBadgeEl: null, // the per-file count badge inside #file-pane-header, refreshed
                                // in place by nav.js's updateFileDom() -- see pane.js's
                                // renderFilePaneHeader. Lives here (not a plain module-level
                                // `let` in pane.js) for the same reason scrollObserver does --
                                // nav.js needs to read/write it too.
};

// ===========================================================================
// Small DOM helper -- the only place that sets text content, always via
// textContent, never innerHTML.
// ===========================================================================

export function createEl(tag, { className, text } = {}) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

// Splits a function/group name into a de-emphasized shared "owner" prefix
// (everything up to and including the LAST '.') and the identifying tail
// that follows it, each in its own span so CSS can protect the tail from
// truncation independently of the prefix (see .tree-fn-prefix/.tree-fn-tail
// in style.css) -- addendum's third problem: two different functions can
// both render as "SelectList.prototype.res…" once naive end-truncation eats
// the shared "SelectList.prototype." and drops exactly the part
// (resetNodeIdsAndOptions vs resetLazyRenderState) that tells them apart.
// This works for every naming shape functions.js produces without any
// special-casing of "prototype": a plain declaration like autoSaveNUIForm
// has no dot, so the whole name is the tail and there's no prefix to strip;
// X.prototype.y, X.y, class methods Foo.bar, and object-literal methods
// API.foo are all, structurally, "some dotted owner path, then the
// identifying member name" -- splitting on the LAST dot always lands the
// break in the right place. The full name is still on the label via title,
// for whichever edge case (e.g. a name with no clear "tail", or one so long
// the tail itself still doesn't fit) truncation can't fully solve visually.
//
// Lives here rather than in tree.js (its original home) or pane.js: both
// modules need it -- pane.js's change-point header has the exact same
// long-name problem tree.js's sidebar rows already solved -- but pane.js
// must never import from tree.js (see pane.js's header comment on the
// tree.js -> pane.js edge and why the reverse would be a cycle). state.js is
// already a dependency of both, so it's the shared home neither direction of
// import has to fight over. `outerClassName` lets each caller keep its own
// flex/ellipsis rules on the outer span (tree.js's row-level shrink vs.
// pane.js's header-level shrink) while sharing the prefix/tail split itself.
export function buildFunctionLabel(name, outerClassName = 'tree-label') {
  const label = createEl('span', { className: `${outerClassName} tree-fn-label` });
  label.title = name;
  const dot = name.lastIndexOf('.');
  if (dot === -1) {
    label.appendChild(createEl('span', { className: 'tree-fn-tail', text: name }));
    return label;
  }
  label.appendChild(createEl('span', { className: 'tree-fn-prefix', text: name.slice(0, dot + 1) }));
  label.appendChild(createEl('span', { className: 'tree-fn-tail', text: name.slice(dot + 1) }));
  return label;
}
