// state.js — progress persistence (checked / comments / notes) and the
// content-hash invalidation rule that lets a half-finished review survive a
// `git commit --amend` or rebase.
//
// Owns the *contents* of $LCR_HOME/state/<repoId>.json (the path itself is
// config.js's responsibility -- see statePath()/stateDir()).
//
// Deliberately does NOT import model.js / git.js / functions.js: this module
// only knows about the plain-object shapes documented in
// task-state-store-brief.md (FileNode / GroupNode / ChangePoint), which are
// a stable contract independent of how they were produced.

import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';

import { statePath, stateDir } from './config.js';
import { createMutex } from './lock.js';

const STATE_VERSION = 1;

function emptyState() {
  return { version: STATE_VERSION, checked: {}, comments: {}, notes: {} };
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isValidState(parsed) {
  return (
    isPlainObject(parsed) &&
    parsed.version === STATE_VERSION &&
    isPlainObject(parsed.checked) &&
    isPlainObject(parsed.comments) &&
    // `notes` is allowed to be absent, not just present-and-valid: a state
    // file written before this field existed (same STATE_VERSION -- the
    // notes map is additive, not a breaking shape change) must still load
    // as valid rather than being treated as corrupt and having its real
    // checked[]/comments[] data backed up and discarded. See the
    // normalization right after this check's call site in
    // readStateUnlocked.
    (parsed.notes === undefined || isPlainObject(parsed.notes)) &&
    // Same additive rule for anchoredComments -- see the block comment above
    // setAnchoredComment. Unlike `notes`, this one is deliberately NOT
    // defaulted into every loaded state: it stays absent until a repo
    // actually has an anchored comment, so an existing review's state file
    // is never rewritten to carry a key it has no use for.
    (parsed.anchoredComments === undefined || isPlainObject(parsed.anchoredComments))
  );
}

// ---------------------------------------------------------------------------
// changePointKey — the whole invalidation rule lives here.
//
// key = sha256(filePath + '\0' + (functionName ?? '') + '\0' + diffText +
//              '\0' + ordinal), first 16 hex chars. Deliberately excludes
// newStart/newEnd/hunkIndex/lines so amend-induced line shifts don't change
// the key, while any real edit to the change point's content (or a function
// rename) does.
//
// `ordinal` is the occurrence index (0-based) of this change point within
// its (filePath, functionName, diffText) bucket, counted in tree order
// (files in array order, then groups in array order, then change points in
// array order). Without it, two change points in the same file/function
// with byte-identical diffText -- e.g. the same one-line edit repeated
// twice inside a function -- would collapse onto the same key, and
// confirming one would silently mark the other reviewed too.
//
// There is deliberately no default value for `ordinal`: a lone ChangePoint
// cannot know its own position within its bucket, so computing this key
// requires the full enumeration context. The only correct caller is the
// tree walk in `annotate` (see buildAnnotated below), which tracks
// per-bucket counts as it goes. Passing a bad ordinal throws rather than
// silently degrading back into the collapsing-keys bug this fixes.
// ---------------------------------------------------------------------------

export function changePointKey(changePoint, ordinal) {
  if (!Number.isInteger(ordinal) || ordinal < 0) {
    throw new Error(
      'changePointKey: ordinal is required and must be a non-negative integer -- ' +
        'it is the occurrence index of this change point within its ' +
        '(filePath, functionName, diffText) bucket, computed during the tree walk ' +
        '(see annotate/buildAnnotated), not something a lone ChangePoint can supply on its own.',
    );
  }
  const { filePath, functionName, diffText } = changePoint;
  const raw = [filePath, functionName ?? '', diffText, String(ordinal)].join('\0');
  return createHash('sha256').update(raw).digest('hex').slice(0, 16);
}

// ---------------------------------------------------------------------------
// Per-repo mutex — one independent queue per repoId, mirroring config.js's
// single configLock but keyed so that writing repo A's state never blocks a
// concurrent write to repo B's state.
// ---------------------------------------------------------------------------

const repoLocks = new Map();

function getRepoLock(repoId) {
  let lock = repoLocks.get(repoId);
  if (!lock) {
    lock = createMutex();
    repoLocks.set(repoId, lock);
  }
  return lock;
}

// ---------------------------------------------------------------------------
// Unlocked read/write primitives. Only call these from inside a
// getRepoLock(repoId)-guarded critical section -- never standalone, and
// never nested inside another lock() call for the same repoId (the mutex is
// not reentrant).
// ---------------------------------------------------------------------------

async function readStateUnlocked(repoId) {
  const path = statePath(repoId);

  let raw;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return emptyState();
    throw err;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
    if (!isValidState(parsed)) {
      throw new Error('state file does not have the expected shape');
    }
  } catch {
    // Corrupt JSON, or valid JSON with the wrong shape/version: back it up,
    // then rebuild an empty state so the tool keeps working instead of
    // crashing. Mirrors config.js's readConfigLocked() corrupt-recovery
    // path exactly. Best-effort throughout -- this branch must never itself
    // throw, regardless of whether the backup/rebuild steps succeed.
    const empty = emptyState();
    try {
      const backupPath = `${path}.corrupt-${Date.now()}`;
      await rename(path, backupPath);
    } catch {
      // Best effort: if the corrupt file can't be moved (e.g. already moved
      // by an earlier recovery), fall through and still recover in-memory.
    }
    try {
      await writeStateUnlocked(repoId, empty);
    } catch {
      // Best effort: even if the rebuilt state can't be persisted right
      // now, return the in-memory empty state so the caller never crashes.
    }
    return empty;
  }

  // Pre-notes-feature files pass isValidState above without a `notes` key at
  // all -- default it in memory (and let the next write persist it) rather
  // than requiring every historical state file to be migrated up front.
  if (!isPlainObject(parsed.notes)) parsed.notes = {};

  return parsed;
}

async function writeStateUnlocked(repoId, state) {
  await mkdir(stateDir(), { recursive: true });
  const tmpPath = join(
    stateDir(),
    `.${repoId}.json.tmp-${process.pid}-${randomBytes(4).toString('hex')}`,
  );
  await writeFile(tmpPath, JSON.stringify(state, null, 2));
  try {
    await rename(tmpPath, statePath(repoId));
  } catch (err) {
    await unlink(tmpPath).catch(() => {});
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function loadState(repoId) {
  return getRepoLock(repoId)(() => readStateUnlocked(repoId));
}

export async function annotate(repoId, fileNodes) {
  const state = await loadState(repoId);
  return buildAnnotated(state, fileNodes);
}

export async function setChecked(repoId, key, checked) {
  return getRepoLock(repoId)(async () => {
    const state = await readStateUnlocked(repoId);
    if (checked) {
      state.checked[key] = true;
    } else {
      delete state.checked[key];
    }
    await writeStateUnlocked(repoId, state);
  });
}

// Shared shape/validation for both CommentRecord and NoteRecord -- comments
// and notes persist identically (text + updatedAt + a filePath/functionName/
// diffText snapshot so an orphan can still show the user *what* it was
// about instead of just a hash); they only differ in which map they live in
// and, at export time, which format(s) include them. `methodName` is
// threaded through purely so the thrown error reads as coming from the
// public function the caller actually called (setComment vs setNote),
// matching each one's pre-existing wording exactly rather than a generic
// message. A missing/non-string filePath or diffText would otherwise
// silently degrade into an unexplained orphan later, so this fails loudly
// instead. functionName may legitimately be null (e.g. a file-level
// comment/note), so that one still defaults quietly.
function buildAnnotationSnapshot(methodName, text, context) {
  if (typeof context?.filePath !== 'string') {
    throw new Error(`${methodName}: context.filePath is required and must be a string`);
  }
  if (typeof context?.diffText !== 'string') {
    throw new Error(`${methodName}: context.diffText is required and must be a string`);
  }
  return {
    text,
    updatedAt: new Date().toISOString(),
    filePath: context.filePath,
    functionName: context.functionName ?? null,
    diffText: context.diffText,
  };
}

export async function setComment(repoId, key, text, context) {
  return getRepoLock(repoId)(async () => {
    const state = await readStateUnlocked(repoId);
    if (typeof text !== 'string' || text.trim() === '') {
      delete state.comments[key];
    } else {
      state.comments[key] = buildAnnotationSnapshot('setComment', text, context);
    }
    await writeStateUnlocked(repoId, state);
  });
}

async function removeComment(repoId, key) {
  return getRepoLock(repoId)(async () => {
    const state = await readStateUnlocked(repoId);
    delete state.comments[key];
    await writeStateUnlocked(repoId, state);
  });
}

export async function deleteComment(repoId, key) {
  return removeComment(repoId, key);
}

// ---------------------------------------------------------------------------
// Notes -- a second, independent per-change-point annotation alongside
// comments (see task-personal-notes brief). Deliberately its own top-level
// map (state.notes), not a field tacked onto CommentRecord: a change point
// can carry a comment, a note, both, or neither, entirely independently
// (independent add/edit/delete, independent presence in state.json). They
// share `changePointKey` -- a note's identity is "the same change point a
// comment could be attached to", so reusing the identical ordinal-based key
// means a note survives exactly the same amend/rebase line-shifts a comment
// does, and is invalidated by exactly the same real content edits. See
// buildAnnotated below for how `note` gets attached to each annotated
// ChangePoint the same way `comment` does, and for why a note whose change
// point disappears is orphaned (not silently dropped) exactly like a
// comment is: the alternative -- discarding it on the very rebase/amend
// churn this tool exists to tolerate -- would lose a considered record the
// user explicitly wrote down for themselves, which is a worse failure mode
// than a comment (a fleeting question that can just be re-asked) losing the
// same content would be.
// ---------------------------------------------------------------------------

export async function setNote(repoId, key, text, context) {
  return getRepoLock(repoId)(async () => {
    const state = await readStateUnlocked(repoId);
    if (typeof text !== 'string' || text.trim() === '') {
      delete state.notes[key];
    } else {
      state.notes[key] = buildAnnotationSnapshot('setNote', text, context);
    }
    await writeStateUnlocked(repoId, state);
  });
}

async function removeNote(repoId, key) {
  return getRepoLock(repoId)(async () => {
    const state = await readStateUnlocked(repoId);
    delete state.notes[key];
    await writeStateUnlocked(repoId, state);
  });
}

export async function deleteNote(repoId, key) {
  return removeNote(repoId, key);
}

// ---------------------------------------------------------------------------
// Anchored comments -- a comment attached to ONE LINE, or a contiguous run of
// lines, inside a change point (the GitHub/GitLab PR-review idiom), rather
// than to the whole 60-line block.
//
// -- The anchor is an INDEX RANGE INTO diffText, not a file line number -----
// `{ start, end }` are 0-based, inclusive indices into
// `changePoint.diffText.split('\n')` -- the change point's own changed-line
// text, exactly the string that goes into changePointKey.
//
// This looks superficially like the design the spec explicitly rejects
// ("進度只存行號 — amend 後靜默錯位，勾會跑到別的 function 上"). It is not.
// That rejection is about FILE line numbers, which move independently of the
// content they name: a file-line anchor survives an amend as a valid-looking
// number pointing at whatever code has since slid into that position. An
// index into diffText cannot do that, because diffText is *inside*
// changePointKey (see the key derivation at the top of this file). Two
// outcomes exhaust the space:
//
//   * the key survives an amend/rebase => the change point's diffText is
//     byte-identical => index i names exactly the same line it always did.
//   * the diffText changed at all => the key changed => the whole record
//     orphans through the existing path, anchors and all, and is shown to the
//     user as history rather than silently re-pointed.
//
// So no new failure mode is introduced: an anchored comment is exactly as
// stable as the checkmark and the whole-change-point comment sitting beside
// it, and stale for exactly the same reasons.
//
// -- Why its own top-level map ---------------------------------------------
// `state.comments` is a map of key -> ONE record and is the shape the human's
// live reviews are already written in. Reshaping its values into arrays would
// mean migrating real data on load and would put the untouched
// whole-change-point path at risk for no benefit. `anchoredComments` is
// therefore a separate additive map, key -> ARRAY of records, exactly the way
// `notes` was added: existing files load unchanged (isValidState treats the
// key as optional), nothing already stored is ever read or rewritten by this
// code, and the unanchored comment path is untouched line for line.
//
// Conceptually this is still ONE annotation kind, not a fourth: an anchored
// comment carries the same fields a comment does, is counted in
// stats.comments, is exported wherever a comment is exported, orphans through
// the same mechanism, and is written through the same editor. The array is a
// storage container, not a new concept -- the only thing that distinguishes
// one of these records is that it additionally names a line range.
//
// -- Identity within a change point ----------------------------------------
// (anchorStart, anchorEnd). Writing the same range twice edits in place;
// empty/whitespace-only text deletes that one range and leaves its siblings
// alone; deleting the last one drops the key so no empty array lingers.
// ---------------------------------------------------------------------------

function requireAnchor(methodName, anchor, diffText) {
  const start = anchor?.start;
  const end = anchor?.end;
  if (!Number.isInteger(start) || !Number.isInteger(end)) {
    throw new Error(`${methodName}: anchor.start and anchor.end are required and must be integers`);
  }
  if (start < 0 || end < start) {
    throw new Error(
      `${methodName}: anchor must satisfy 0 <= start <= end (got start=${start}, end=${end})`,
    );
  }
  // Validated against the caller's own diffText snapshot, which is the exact
  // string the indices address. Doing it here means an out-of-range anchor can
  // never reach the state file, so annotate() below never has to defend
  // against one (and never has to silently drop a record to do so).
  const lineCount = diffText.split('\n').length;
  if (end >= lineCount) {
    throw new Error(
      `${methodName}: anchor end ${end} is outside this change point's diffText (${lineCount} lines)`,
    );
  }
  return { start, end };
}

export async function setAnchoredComment(repoId, key, anchor, text, context) {
  // Snapshot first: it is also what validates context.filePath/diffText, and
  // requireAnchor needs context.diffText to bound-check against.
  const snapshot = buildAnnotationSnapshot('setAnchoredComment', text, context);
  const { start, end } = requireAnchor('setAnchoredComment', anchor, snapshot.diffText);

  return getRepoLock(repoId)(async () => {
    const state = await readStateUnlocked(repoId);
    if (!isPlainObject(state.anchoredComments)) state.anchoredComments = {};

    const existing = Array.isArray(state.anchoredComments[key]) ? state.anchoredComments[key] : [];
    const rest = existing.filter(
      (record) => !(record.anchorStart === start && record.anchorEnd === end),
    );

    if (typeof text !== 'string' || text.trim() === '') {
      if (rest.length === 0) delete state.anchoredComments[key];
      else state.anchoredComments[key] = rest;
    } else {
      state.anchoredComments[key] = [...rest, { ...snapshot, anchorStart: start, anchorEnd: end }];
    }

    // Keep the map itself absent when nothing uses it, so a repo that never
    // anchors a comment keeps the exact state-file shape it has today.
    if (Object.keys(state.anchoredComments).length === 0) delete state.anchoredComments;

    await writeStateUnlocked(repoId, state);
  });
}

export async function deleteAnchoredComments(repoId, key) {
  return getRepoLock(repoId)(async () => {
    const state = await readStateUnlocked(repoId);
    if (!isPlainObject(state.anchoredComments)) return;
    delete state.anchoredComments[key];
    if (Object.keys(state.anchoredComments).length === 0) delete state.anchoredComments;
    await writeStateUnlocked(repoId, state);
  });
}

// The public projection of one stored record: only the anchor and the text.
// updatedAt / filePath / functionName / diffText are storage details (the
// snapshot exists so an orphan can explain itself), the same way a comment's
// are never exposed on an annotated change point either.
function publicAnchored(records) {
  return [...(records ?? [])]
    .map((record) => ({
      anchorStart: record.anchorStart,
      anchorEnd: record.anchorEnd,
      text: record.text,
    }))
    .sort((a, b) => a.anchorStart - b.anchorStart || a.anchorEnd - b.anchorEnd);
}

// An orphan card in the UI represents one change-point *key*, not one
// annotation type -- it can carry a comment, a note, or both (see
// buildAnnotated's orphan collection below), and "Discard" on that card is
// understood by the user as "make this whole entry go away", not "discard
// whichever half I happened to be looking at". So this removes both records
// for `key` in a single locked read-modify-write, rather than reusing
// removeComment alone (the pre-notes behavior) and leaving a same-keyed note
// to silently resurface as a new, half-explained orphan on the next
// annotate().
export async function discardOrphan(repoId, key) {
  return getRepoLock(repoId)(async () => {
    const state = await readStateUnlocked(repoId);
    delete state.comments[key];
    delete state.notes[key];
    // Anchored comments belong to the same change-point identity, so the same
    // "make this whole entry go away" reasoning applies to them.
    if (isPlainObject(state.anchoredComments)) {
      delete state.anchoredComments[key];
      if (Object.keys(state.anchoredComments).length === 0) delete state.anchoredComments;
    }
    await writeStateUnlocked(repoId, state);
  });
}

// ---------------------------------------------------------------------------
// annotate() internals — pure, synchronous overlay of a State onto a
// model.js-shaped fileNodes tree. Never mutates fileNodes: every file /
// group / change point is rebuilt as a new object. Line objects inside a
// ChangePoint are carried over by reference (not cloned) since they are
// shared with the parsed diff and treated as read-only.
// ---------------------------------------------------------------------------

function buildAnnotated(state, fileNodes) {
  const seenKeys = new Set();
  // Occurrence counters, one per (filePath, functionName, diffText) bucket,
  // incremented as change points are walked in tree order (files, then
  // groups, then change points -- all in array order). This is what lets
  // two byte-identical change points in the same function get distinct
  // keys instead of collapsing onto one (Finding 1).
  const bucketCounts = new Map();
  // Comment keys already counted toward stats.comments, so a key is never
  // counted twice even defensively (Finding 2) -- though with per-occurrence
  // keys now unique by construction, a key can in practice only be visited
  // once per walk anyway.
  const countedCommentKeys = new Set();
  const countedAnchoredKeys = new Set();
  // Read once: `anchoredComments` is deliberately absent from a state file
  // until the repo actually has one (see setAnchoredComment), so everything
  // below reads through this normalized local instead of poking at an
  // optional field on every change point.
  const anchoredMap = isPlainObject(state.anchoredComments) ? state.anchoredComments : {};
  let statsTotal = 0;
  let statsChecked = 0;
  let statsComments = 0;

  function nextOrdinal(changePoint) {
    const bucket = [changePoint.filePath, changePoint.functionName ?? '', changePoint.diffText].join('\0');
    const ordinal = bucketCounts.get(bucket) ?? 0;
    bucketCounts.set(bucket, ordinal + 1);
    return ordinal;
  }

  const files = fileNodes.map((file) => {
    let fileChecked = 0;

    const groups = file.groups.map((group) => {
      let groupChecked = 0;

      const changePoints = group.changePoints.map((changePoint) => {
        const ordinal = nextOrdinal(changePoint);
        const key = changePointKey(changePoint, ordinal);
        seenKeys.add(key);

        const checked = state.checked[key] === true;
        const commentRecord = Object.hasOwn(state.comments, key) ? state.comments[key] : undefined;
        const noteRecord = Object.hasOwn(state.notes, key) ? state.notes[key] : undefined;
        const anchoredRecords = anchoredMap[key];
        if (checked) groupChecked += 1;
        // Count distinct comment *keys*, not one per annotated change
        // point, so a comment can never be counted more than once even if
        // something upstream produced a repeated key.
        if (commentRecord && !countedCommentKeys.has(key)) {
          countedCommentKeys.add(key);
          statsComments += 1;
        }
        // An anchored comment IS a comment (see setAnchoredComment's block
        // comment) -- it just additionally names a line range -- so each one
        // counts once here, exactly like the whole-change-point comment
        // above. Guarded by the same per-key set so a repeated key could
        // never double-count them either.
        if (anchoredRecords && !countedAnchoredKeys.has(key)) {
          countedAnchoredKeys.add(key);
          statsComments += anchoredRecords.length;
        }
        // Deliberately no stats.notes counterpart: stats is the shared
        // total/checked/comments summary the topbar badge and Markdown
        // export's stats line already render, and neither surface asked for
        // a notes count -- adding one here would be scope the brief never
        // requested, on a return shape several tests pin with a full
        // assert.deepEqual.

        return {
          ...changePoint,
          id: key,
          checked,
          comment: commentRecord ? commentRecord.text : null,
          note: noteRecord ? noteRecord.text : null,
          // Always an array, never undefined: every consumer (export, the
          // right-pane renderer) can iterate unconditionally.
          anchoredComments: publicAnchored(anchoredRecords),
        };
      });

      fileChecked += groupChecked;

      return {
        ...group,
        changePoints,
        checked: groupChecked,
        allChecked: group.total > 0 && groupChecked === group.total,
      };
    });

    statsTotal += file.total;
    statsChecked += fileChecked;

    return {
      ...file,
      groups,
      checked: fileChecked,
      allChecked: file.total > 0 && fileChecked === file.total,
    };
  });

  // Orphan keys come from the UNION of state.comments and state.notes: a
  // key can have a comment, a note, or both, and either one going stale
  // (its change point no longer exists anywhere in the current tree) is
  // enough to surface an orphan card for it. `text`/`note` are independently
  // nullable on the orphan record for exactly that reason -- an orphan with
  // only a note has `text: null`, one with only a comment has `note: null`,
  // and one with both carries both. filePath/functionName/diffText come
  // from whichever record exists (they are the same snapshot either way,
  // taken from the same change point at the same time comments and notes
  // are both written against it); updatedAt is the more recent of the two
  // when both are present, so sort order reflects whichever annotation was
  // actually touched last.
  const orphanKeys = new Set([
    ...Object.keys(state.comments).filter((key) => !seenKeys.has(key)),
    ...Object.keys(state.notes).filter((key) => !seenKeys.has(key)),
    // A key can carry ONLY anchored comments (no whole-change-point comment,
    // no note). Leaving it out of this union would silently drop exactly the
    // annotations this feature exists to make, on exactly the amend that
    // makes them stale.
    ...Object.keys(anchoredMap).filter((key) => !seenKeys.has(key)),
  ]);

  const orphans = [...orphanKeys]
    .map((key) => {
      const commentRecord = Object.hasOwn(state.comments, key) ? state.comments[key] : undefined;
      const noteRecord = Object.hasOwn(state.notes, key) ? state.notes[key] : undefined;
      const anchoredRecords = anchoredMap[key];
      // Every record for a key carries the same filePath/functionName/
      // diffText snapshot (they are all written against the same change point
      // at the time it existed), so any one of them answers "what was this
      // about". An anchored-only key has neither of the first two, hence the
      // third fallback -- without it this line would throw on exactly the
      // orphan shape this feature introduces.
      const snapshotSource = commentRecord ?? noteRecord ?? anchoredRecords[0];
      const updatedAt = [commentRecord, noteRecord, ...(anchoredRecords ?? [])]
        .filter(Boolean)
        .reduce((latest, record) => (record.updatedAt > latest ? record.updatedAt : latest), '');

      return {
        key,
        text: commentRecord ? commentRecord.text : null,
        note: noteRecord ? noteRecord.text : null,
        // Same independent nullability rule as text/note, in array form: an
        // orphan can carry any combination of the three.
        anchored: publicAnchored(anchoredRecords),
        updatedAt,
        filePath: snapshotSource.filePath,
        functionName: snapshotSource.functionName,
        diffText: snapshotSource.diffText,
      };
    })
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));

  return {
    files,
    orphans,
    stats: { total: statsTotal, checked: statsChecked, comments: statsComments },
  };
}
