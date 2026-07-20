// state.js — progress persistence (checked / comments) and the content-hash
// invalidation rule that lets a half-finished review survive a
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
  return { version: STATE_VERSION, checked: {}, comments: {} };
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isValidState(parsed) {
  return (
    isPlainObject(parsed) &&
    parsed.version === STATE_VERSION &&
    isPlainObject(parsed.checked) &&
    isPlainObject(parsed.comments)
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

export async function setComment(repoId, key, text, context) {
  return getRepoLock(repoId)(async () => {
    const state = await readStateUnlocked(repoId);
    if (typeof text !== 'string' || text.trim() === '') {
      delete state.comments[key];
    } else {
      // filePath/diffText are the snapshot fields that let an orphaned
      // comment show the user *what* it was about instead of just a hash
      // (see CommentRecord in the brief). A missing/non-string value here
      // would silently degrade into an unexplained orphan later, so fail
      // loudly now instead. functionName may legitimately be null (e.g. a
      // file-level comment), so that one still defaults quietly.
      if (typeof context?.filePath !== 'string') {
        throw new Error('setComment: context.filePath is required and must be a string');
      }
      if (typeof context?.diffText !== 'string') {
        throw new Error('setComment: context.diffText is required and must be a string');
      }
      state.comments[key] = {
        text,
        updatedAt: new Date().toISOString(),
        filePath: context.filePath,
        functionName: context.functionName ?? null,
        diffText: context.diffText,
      };
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

export async function discardOrphan(repoId, key) {
  return removeComment(repoId, key);
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
        if (checked) groupChecked += 1;
        // Count distinct comment *keys*, not one per annotated change
        // point, so a comment can never be counted more than once even if
        // something upstream produced a repeated key.
        if (commentRecord && !countedCommentKeys.has(key)) {
          countedCommentKeys.add(key);
          statsComments += 1;
        }

        return {
          ...changePoint,
          id: key,
          checked,
          comment: commentRecord ? commentRecord.text : null,
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

  const orphans = Object.entries(state.comments)
    .filter(([key]) => !seenKeys.has(key))
    .map(([key, record]) => ({
      key,
      text: record.text,
      updatedAt: record.updatedAt,
      filePath: record.filePath,
      functionName: record.functionName,
      diffText: record.diffText,
    }))
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));

  return {
    files,
    orphans,
    stats: { total: statsTotal, checked: statsChecked, comments: statsComments },
  };
}
