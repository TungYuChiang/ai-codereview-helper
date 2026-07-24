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

// Mount points for the two ref comboboxes (topbar.js fills them). These used
// to be the <select> elements themselves; the pickers are now custom
// widgets, so the rest of the app talks to the handles topbar.js exports
// rather than to a DOM element's .value.
export const basePickerEl = document.getElementById('base-picker');
export const targetPickerEl = document.getElementById('target-picker');
export const workingTreeHintEl = document.getElementById('working-tree-hint');

// Per-commit review: a third picker listing the commits the branch adds
// (base..target), plus an explicit way back to the whole-branch view and the
// note explaining why tick progress is counted separately in that mode. See
// the commit-picker section in topbar.js.
export const commitGroupEl = document.getElementById('commit-group');
export const commitPickerEl = document.getElementById('commit-picker');
export const commitBackBtnEl = document.getElementById('commit-back-btn');
export const commitHintEl = document.getElementById('commit-hint');

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
  base: null,           // currently selected base ref -- the BRANCH range's base
  target: null,         // currently selected target ref, or 'WORKING_TREE'

  // Per-commit review. base/target above keep meaning exactly what they always
  // did -- whatever the two top-bar ref pickers hold -- and are what the commit
  // LIST is computed from (base..target). This is the narrowing on top of it:
  //
  //   null           -- whole-branch view, i.e. the original behaviour.
  //   {sha, base, …} -- one commit from GET /api/commits; the diff shown is
  //                     that commit's own `base...sha`.
  //
  // Kept as a separate field rather than by overwriting base/target with the
  // commit's range, because overwriting would destroy the very range the
  // commit list is derived from (and would make the ref pickers display two
  // shas instead of the branch the user picked). Everything that actually
  // talks to /api/diff, /api/lines and /api/export reads effectiveRange()
  // below instead, so there is exactly one place that knows about the
  // narrowing -- nothing downstream of it (model.js, the backend state.js, the
  // whole tree renderer) can tell a commit was involved at all.
  commit: null,
  // A sha restored from localStorage that has NOT yet been checked against a
  // real commit list. Held separately so `commit` is only ever a record that
  // genuinely exists in the current range -- after a rebase the persisted sha
  // is simply gone, and that has to degrade to the whole-branch view rather
  // than to a diff against a revision git no longer has. Cleared by
  // loadCommitsForRange in load.js, which is the only thing that resolves it.
  pendingCommit: null,
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
  // editingKind gained a third value, 'anchored' -- a comment on one line (or
  // a run of lines) inside a change point, which is the same annotation kind
  // as 'comment' narrowed to a range rather than a fourth concept (see
  // comments.js's anchored-comment section). editingAnchor is that range,
  // { start, end }: 0-based inclusive indices into the change point's own
  // diffText lines. Null for every other editing kind, and null whenever
  // nothing is being edited. "Which key" is not enough to identify this
  // editor, the same way it stopped being enough when notes arrived.
  editingAnchor: null,

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
  changePoints: new Map(), // key -> { changePoint, group, file, groupKey, leftRow, leftCheckbox, rightContainer, rightCheckbox, contentEl, commentEl, commentBodyEl, noteBodyEl, expand, anchorRows }
  // anchorRows is rebuilt from scratch by every renderChangePointContent
  // (diff.js): anchor index -> { cell, btn } for each of this change point's
  // own diff lines in unified view. Empty in side-by-side, where anchoring is
  // deliberately not offered -- see comments.js's anchored-comment block
  // comment for why.
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
// The revision range every diff-shaped API call actually uses.
//
// Whole-branch view: the two ref pickers, unchanged.
// Single-commit view: that commit's first parent (or git's empty tree, for a
// root commit -- see EMPTY_TREE_SHA in the backend git.js) and the commit
// itself. `git diff <parent>...<sha>` is byte-identical to
// `git diff <parent> <sha>`, because merge-base(parent, sha) IS parent, so
// this needs no new diff machinery on either side: it is an ordinary
// base/target pair that happens to span one commit.
//
// Callers: loadDiff (/api/diff), runGapExpand (/api/lines -- context
// expansion must read the revision the diff is expressed in), and both export
// paths (/api/export). NOT /api/merged or /api/commits, which are questions
// about the branch range and are answered from appState.base/target directly.
// ===========================================================================

export function effectiveRange() {
  if (appState.commit) {
    return { base: appState.commit.base, target: appState.commit.sha };
  }
  return { base: appState.base, target: appState.target };
}

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
