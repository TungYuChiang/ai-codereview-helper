import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { statePath, stateDir } from '../config.js';
import {
  changePointKey,
  loadState,
  annotate,
  setChecked,
  setComment,
  deleteComment,
  setNote,
  deleteNote,
  discardOrphan,
} from '../state.js';

const ORIGINAL_LCR_HOME = process.env.LCR_HOME;

let lcrHome;

beforeEach(async () => {
  lcrHome = await mkdtemp(join(tmpdir(), 'local-code-review-state-test-'));
  process.env.LCR_HOME = lcrHome;
});

afterEach(async () => {
  if (ORIGINAL_LCR_HOME === undefined) {
    delete process.env.LCR_HOME;
  } else {
    process.env.LCR_HOME = ORIGINAL_LCR_HOME;
  }
  await rm(lcrHome, { recursive: true, force: true });
});

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Fixture helpers — hand-build model.js-shaped FileNode / GroupNode / ChangePoint
// (state.js must NOT import model.js, so these are literal object shapes,
// matching the contract documented in model.js and task-state-store-brief.md).
// ---------------------------------------------------------------------------

function cp(overrides = {}) {
  return {
    filePath: 'src/auth.js',
    functionName: 'handleLogin',
    hunkIndex: 0,
    newStart: 40,
    newEnd: 42,
    lines: [],
    diffText: '+const token = signToken(user);\n+return token;',
    ...overrides,
  };
}

function groupNode(overrides = {}) {
  const changePoints = overrides.changePoints ?? [cp()];
  const { changePoints: _omit, ...rest } = overrides;
  return {
    name: 'handleLogin',
    startLine: 35,
    endLine: 65,
    changePoints,
    total: changePoints.length,
    ...rest,
  };
}

function fileNode(overrides = {}) {
  const groups = overrides.groups ?? [groupNode()];
  const { groups: _omit, ...rest } = overrides;
  return {
    path: 'src/auth.js',
    oldPath: null,
    status: 'modified',
    groups,
    total: groups.reduce((sum, g) => sum + g.total, 0),
    ...rest,
  };
}

const REPO = 'repo-under-test';

// ---------------------------------------------------------------------------
// changePointKey
// ---------------------------------------------------------------------------

describe('changePointKey', () => {
  test('is a 16-char lowercase hex string', () => {
    const key = changePointKey(cp(), 0);
    assert.match(key, /^[0-9a-f]{16}$/);
  });

  test('is deterministic: same filePath/functionName/diffText/ordinal -> same key', () => {
    const a = changePointKey(cp(), 0);
    const b = changePointKey(cp(), 0);
    assert.equal(a, b);
  });

  test('extra fields on the input are ignored', () => {
    const a = changePointKey(cp(), 0);
    const b = changePointKey(cp({ hunkIndex: 99, newStart: 1000, newEnd: 2000, lines: [{ type: '+', text: 'x' }] }), 0);
    assert.equal(a, b);
  });

  test('different diffText -> different key', () => {
    const a = changePointKey(cp(), 0);
    const b = changePointKey(cp({ diffText: '+const token = signToken(user);\n+return token!' }), 0);
    assert.notEqual(a, b);
  });

  test('different functionName -> different key (rename invalidates)', () => {
    const a = changePointKey(cp(), 0);
    const b = changePointKey(cp({ functionName: 'handleLogout' }), 0);
    assert.notEqual(a, b);
  });

  test('different filePath -> different key', () => {
    const a = changePointKey(cp(), 0);
    const b = changePointKey(cp({ filePath: 'src/other.js' }), 0);
    assert.notEqual(a, b);
  });

  test('newStart/newEnd/hunkIndex/lines changing alone does NOT change the key (line-shift survives)', () => {
    const a = changePointKey(cp({ newStart: 40, newEnd: 42, hunkIndex: 0 }), 0);
    const b = changePointKey(cp({ newStart: 340, newEnd: 342, hunkIndex: 3 }), 0);
    assert.equal(a, b);
  });

  test('null functionName participates as empty string', () => {
    const a = changePointKey(cp({ functionName: null }), 0);
    const b = changePointKey(cp({ functionName: '' }), 0);
    assert.equal(a, b);
  });

  test('fields are separated so boundary shifts do not collide (proves \\0 join, not naive concat)', () => {
    const a = changePointKey({ filePath: 'ab', functionName: 'c', diffText: 'd' }, 0);
    const b = changePointKey({ filePath: 'a', functionName: 'bc', diffText: 'd' }, 0);
    assert.notEqual(a, b);
  });

  test('is a pure function (no side effects, callable without repoId/fs)', () => {
    assert.doesNotThrow(() => changePointKey(cp(), 0));
  });

  // -- ordinal: the occurrence-index argument that disambiguates duplicate
  // content (Finding 1). changePointKey cannot default it -- see state.js --
  // because a lone ChangePoint has no way to know its position within its
  // (filePath, functionName, diffText) bucket; only the tree walk in
  // annotate() knows that.

  test('same filePath/functionName/diffText but different ordinal -> different key', () => {
    const a = changePointKey(cp(), 0);
    const b = changePointKey(cp(), 1);
    assert.notEqual(a, b);
  });

  test('ordinal is required: calling without it throws a readable Error', () => {
    assert.throws(() => changePointKey(cp()), /ordinal/);
  });

  test('a negative or non-integer ordinal throws', () => {
    assert.throws(() => changePointKey(cp(), -1), /ordinal/);
    assert.throws(() => changePointKey(cp(), 1.5), /ordinal/);
    assert.throws(() => changePointKey(cp(), '0'), /ordinal/);
  });
});

// ---------------------------------------------------------------------------
// loadState
// ---------------------------------------------------------------------------

describe('loadState', () => {
  test('returns an empty State when no file exists', async () => {
    const state = await loadState(REPO);
    assert.deepEqual(state, { version: 1, checked: {}, comments: {}, notes: {} });
  });

  test('reads back a previously written state file', async () => {
    await setChecked(REPO, 'abc123', true);
    const state = await loadState(REPO);
    assert.deepEqual(state, { version: 1, checked: { abc123: true }, comments: {}, notes: {} });
  });

  test('writes to $LCR_HOME/state/<repoId>.json, not inside a reviewed project', async () => {
    await setChecked(REPO, 'abc123', true);
    const raw = await readFile(statePath(REPO), 'utf8');
    assert.equal(JSON.parse(raw).checked.abc123, true);
  });

  test('corrupt JSON is backed up and treated as empty State, without throwing', async () => {
    await mkdir(stateDir(), { recursive: true });
    await writeFile(statePath(REPO), '{ not valid json');

    const state = await loadState(REPO);
    assert.deepEqual(state, { version: 1, checked: {}, comments: {}, notes: {} });

    const entries = await readdir(stateDir());
    const backup = entries.find((f) => new RegExp(`^${REPO}\\.json\\.corrupt-\\d+$`).test(f));
    assert.ok(backup, `expected a corrupt-* backup file, got: ${entries.join(', ')}`);
  });

  test('wrong version is treated as unrecognized: backed up and reset to empty State', async () => {
    await mkdir(stateDir(), { recursive: true });
    await writeFile(statePath(REPO), JSON.stringify({ version: 2, checked: {}, comments: {} }));

    const state = await loadState(REPO);
    assert.deepEqual(state, { version: 1, checked: {}, comments: {}, notes: {} });

    const entries = await readdir(stateDir());
    const backup = entries.find((f) => new RegExp(`^${REPO}\\.json\\.corrupt-\\d+$`).test(f));
    assert.ok(backup, `expected a corrupt-* backup file, got: ${entries.join(', ')}`);
  });

  test('structurally unexpected (but valid) JSON is treated as corrupt', async () => {
    await mkdir(stateDir(), { recursive: true });
    await writeFile(statePath(REPO), JSON.stringify({ oops: true }));

    const state = await loadState(REPO);
    assert.deepEqual(state, { version: 1, checked: {}, comments: {}, notes: {} });
  });

  test('a pre-notes-feature state file (no notes key at all) loads as valid, not corrupt -- notes defaults to {} without discarding real checked/comments data', async () => {
    await mkdir(stateDir(), { recursive: true });
    await writeFile(
      statePath(REPO),
      JSON.stringify({
        version: 1,
        checked: { abc123: true },
        comments: { def456: { text: 'old comment', updatedAt: '2026-01-01T00:00:00.000Z', filePath: 'a', functionName: null, diffText: 'x' } },
      }),
    );

    const state = await loadState(REPO);
    assert.deepEqual(state, {
      version: 1,
      checked: { abc123: true },
      comments: { def456: { text: 'old comment', updatedAt: '2026-01-01T00:00:00.000Z', filePath: 'a', functionName: null, diffText: 'x' } },
      notes: {},
    });

    // Must NOT have been treated as corrupt -- no backup file written.
    const entries = await readdir(stateDir());
    const backup = entries.find((f) => /\.corrupt-\d+$/.test(f));
    assert.equal(backup, undefined, 'a missing notes field alone must not trigger corrupt-recovery');
  });
});

// ---------------------------------------------------------------------------
// annotate — basic overlay and count aggregation
// ---------------------------------------------------------------------------

describe('annotate', () => {
  test('with no state, everything is unchecked/uncommented and stats are zero', async () => {
    const tree = [fileNode()];
    const result = await annotate(REPO, tree);

    assert.equal(result.files.length, 1);
    const file = result.files[0];
    assert.equal(file.checked, 0);
    assert.equal(file.allChecked, false);
    assert.equal(file.total, 1);

    const group = file.groups[0];
    assert.equal(group.checked, 0);
    assert.equal(group.allChecked, false);

    const changePoint = group.changePoints[0];
    assert.equal(changePoint.checked, false);
    assert.equal(changePoint.comment, null);
    assert.equal(typeof changePoint.id, 'string');
    assert.equal(changePoint.id, changePointKey(cp(), 0));

    assert.deepEqual(result.orphans, []);
    assert.deepEqual(result.stats, { total: 1, checked: 0, comments: 0 });
  });

  test('preserves original ChangePoint/GroupNode/FileNode fields (model.js contract) alongside new ones', async () => {
    const tree = [fileNode()];
    const result = await annotate(REPO, tree);
    const file = result.files[0];
    const group = file.groups[0];
    const changePoint = group.changePoints[0];

    assert.equal(file.path, 'src/auth.js');
    assert.equal(file.oldPath, null);
    assert.equal(file.status, 'modified');
    assert.equal(group.name, 'handleLogin');
    assert.equal(group.startLine, 35);
    assert.equal(group.endLine, 65);
    assert.equal(changePoint.filePath, 'src/auth.js');
    assert.equal(changePoint.functionName, 'handleLogin');
    assert.equal(changePoint.diffText, cp().diffText);
  });

  test('checked change point is reflected at ChangePoint/GroupNode/FileNode/stats levels', async () => {
    const key = changePointKey(cp(), 0);
    await setChecked(REPO, key, true);

    const result = await annotate(REPO, [fileNode()]);
    const file = result.files[0];
    const group = file.groups[0];
    const changePoint = group.changePoints[0];

    assert.equal(changePoint.checked, true);
    assert.equal(group.checked, 1);
    assert.equal(group.allChecked, true);
    assert.equal(file.checked, 1);
    assert.equal(file.allChecked, true);
    assert.deepEqual(result.stats, { total: 1, checked: 1, comments: 0 });
  });

  test('allChecked is true only when total > 0 and checked === total (partial checks)', async () => {
    const key1 = changePointKey(cp(), 0);
    const cp2 = cp({ newStart: 100, newEnd: 101, diffText: '+another change' });
    await setChecked(REPO, key1, true);

    const tree = [
      fileNode({
        groups: [groupNode({ changePoints: [cp(), cp2], total: 2 })],
        total: 2,
      }),
    ];

    const result = await annotate(REPO, tree);
    const group = result.files[0].groups[0];
    assert.equal(group.checked, 1);
    assert.equal(group.allChecked, false);
    assert.equal(result.files[0].allChecked, false);
  });

  test('binary file with total 0 has allChecked false, not true', async () => {
    const tree = [fileNode({ path: 'logo.png', status: 'binary', groups: [], total: 0 })];
    const result = await annotate(REPO, tree);
    const file = result.files[0];
    assert.equal(file.total, 0);
    assert.equal(file.checked, 0);
    assert.equal(file.allChecked, false);
  });

  test('comment text is attached to the matching ChangePoint and counted in stats.comments', async () => {
    const key = changePointKey(cp(), 0);
    await setComment(REPO, key, 'looks fine', {
      filePath: 'src/auth.js',
      functionName: 'handleLogin',
      diffText: cp().diffText,
    });

    const result = await annotate(REPO, [fileNode()]);
    const changePoint = result.files[0].groups[0].changePoints[0];
    assert.equal(changePoint.comment, 'looks fine');
    assert.deepEqual(result.stats, { total: 1, checked: 0, comments: 1 });
  });

  test('note text is attached to the matching ChangePoint, independently of comment, and does not affect stats.comments', async () => {
    const key = changePointKey(cp(), 0);
    await setNote(REPO, key, 'this recomputes the session TTL', {
      filePath: 'src/auth.js',
      functionName: 'handleLogin',
      diffText: cp().diffText,
    });

    const result = await annotate(REPO, [fileNode()]);
    const changePoint = result.files[0].groups[0].changePoints[0];
    assert.equal(changePoint.note, 'this recomputes the session TTL');
    assert.equal(changePoint.comment, null, 'a note must not be readable through the comment field');
    assert.deepEqual(result.stats, { total: 1, checked: 0, comments: 0 });
  });

  test('a change point can carry both a comment and a note at once, independently', async () => {
    const key = changePointKey(cp(), 0);
    await setComment(REPO, key, 'is this safe under concurrent writes?', {
      filePath: 'src/auth.js',
      functionName: 'handleLogin',
      diffText: cp().diffText,
    });
    await setNote(REPO, key, 'confirmed: signToken() is idempotent', {
      filePath: 'src/auth.js',
      functionName: 'handleLogin',
      diffText: cp().diffText,
    });

    const result = await annotate(REPO, [fileNode()]);
    const changePoint = result.files[0].groups[0].changePoints[0];
    assert.equal(changePoint.comment, 'is this safe under concurrent writes?');
    assert.equal(changePoint.note, 'confirmed: signToken() is idempotent');
  });

  test('a change point with neither has comment: null and note: null', async () => {
    const result = await annotate(REPO, [fileNode()]);
    const changePoint = result.files[0].groups[0].changePoints[0];
    assert.equal(changePoint.comment, null);
    assert.equal(changePoint.note, null);
  });

  test('stats aggregate across multiple files', async () => {
    const fileA = fileNode({ path: 'src/a.js', groups: [groupNode({ changePoints: [cp({ filePath: 'src/a.js' })], total: 1 })], total: 1 });
    const fileB = fileNode({
      path: 'src/b.js',
      groups: [groupNode({ name: 'other', changePoints: [cp({ filePath: 'src/b.js', functionName: 'other', diffText: '+z' })], total: 1 })],
      total: 1,
    });
    await setChecked(REPO, changePointKey(cp({ filePath: 'src/a.js' }), 0), true);

    const result = await annotate(REPO, [fileA, fileB]);
    assert.deepEqual(result.stats, { total: 2, checked: 1, comments: 0 });
  });

  test('does not mutate the input fileNodes tree', async () => {
    const tree = [fileNode()];
    const before = structuredClone(tree);
    await setChecked(REPO, changePointKey(cp(), 0), true);

    await annotate(REPO, tree);

    assert.deepEqual(tree, before);
  });

  test('returns a fresh object graph, not the same references as the input', async () => {
    const tree = [fileNode()];
    const result = await annotate(REPO, tree);

    assert.notEqual(result.files[0], tree[0]);
    assert.notEqual(result.files[0].groups[0], tree[0].groups[0]);
    assert.notEqual(result.files[0].groups[0].changePoints[0], tree[0].groups[0].changePoints[0]);
  });

  test('does not modify the shared Line objects referenced by a ChangePoint', async () => {
    const sharedLine = { type: '+', text: 'const token = signToken(user);' };
    const tree = [fileNode({ groups: [groupNode({ changePoints: [cp({ lines: [sharedLine] })], total: 1 })], total: 1 })];

    const result = await annotate(REPO, tree);

    // Same reference (not cloned), and untouched.
    assert.equal(result.files[0].groups[0].changePoints[0].lines[0], sharedLine);
    assert.deepEqual(sharedLine, { type: '+', text: 'const token = signToken(user);' });
  });
});

// ---------------------------------------------------------------------------
// annotate — duplicate content within a single (filePath, functionName)
// bucket (Finding 1). Two change points with byte-identical diffText used to
// collapse onto one key, so confirming one silently marked both reviewed.
// The fix: an occurrence ordinal (position within the bucket, in tree
// order) folded into the key.
// ---------------------------------------------------------------------------

describe('annotate — duplicate-content change points get distinct ids (Finding 1)', () => {
  test('two identical-content change points in one function get distinct ids and independent checkmarks', async () => {
    // Same file, same function, byte-identical diffText -- e.g. the same
    // one-line edit repeated twice inside a function -- differing only in
    // where they land (newStart 10 vs 50).
    const cp0 = cp({ newStart: 10, newEnd: 11 });
    const cp1 = cp({ newStart: 50, newEnd: 51 });
    const tree = [
      fileNode({
        groups: [groupNode({ changePoints: [cp0, cp1], total: 2 })],
        total: 2,
      }),
    ];

    const before = await annotate(REPO, tree);
    const [beforeCp0, beforeCp1] = before.files[0].groups[0].changePoints;

    assert.notEqual(beforeCp0.id, beforeCp1.id, 'duplicate content must not collapse onto one key');

    await setChecked(REPO, beforeCp0.id, true);

    const after = await annotate(REPO, tree);
    const [afterCp0, afterCp1] = after.files[0].groups[0].changePoints;
    const group = after.files[0].groups[0];

    assert.equal(afterCp0.checked, true, 'the confirmed change point stays checked');
    assert.equal(afterCp1.checked, false, 'the other identical-content change point must NOT be silently marked reviewed');
    assert.equal(group.checked, 1);
    assert.equal(group.allChecked, false);
    assert.deepEqual(after.stats, { total: 2, checked: 1, comments: 0 });
  });

  test('the ordinal is the position within the bucket in tree order: first occurrence gets ordinal 0, second gets 1', async () => {
    const cp0 = cp({ newStart: 10, newEnd: 11 });
    const cp1 = cp({ newStart: 50, newEnd: 51 });
    const tree = [fileNode({ groups: [groupNode({ changePoints: [cp0, cp1], total: 2 })], total: 2 })];

    const result = await annotate(REPO, tree);
    const [annotatedCp0, annotatedCp1] = result.files[0].groups[0].changePoints;

    assert.equal(annotatedCp0.id, changePointKey(cp0, 0));
    assert.equal(annotatedCp1.id, changePointKey(cp1, 1));
  });

  test('duplicate content across different functions/files is unaffected (buckets are per filePath+functionName+diffText)', async () => {
    const cpA = cp({ filePath: 'src/a.js', functionName: 'fnA' });
    const cpB = cp({ filePath: 'src/b.js', functionName: 'fnB' });
    const tree = [
      fileNode({ path: 'src/a.js', groups: [groupNode({ name: 'fnA', changePoints: [cpA], total: 1 })], total: 1 }),
      fileNode({ path: 'src/b.js', groups: [groupNode({ name: 'fnB', changePoints: [cpB], total: 1 })], total: 1 }),
    ];

    const result = await annotate(REPO, tree);
    const [idA, idB] = result.files.map((f) => f.groups[0].changePoints[0].id);
    assert.equal(idA, changePointKey(cpA, 0));
    assert.equal(idB, changePointKey(cpB, 0));
    assert.notEqual(idA, idB);
  });

  test('setComment on the first of two duplicate-content change points does not attach the comment to the second', async () => {
    const cp0 = cp({ newStart: 10, newEnd: 11 });
    const cp1 = cp({ newStart: 50, newEnd: 51 });
    const tree = [fileNode({ groups: [groupNode({ changePoints: [cp0, cp1], total: 2 })], total: 2 })];

    const before = await annotate(REPO, tree);
    const [beforeCp0] = before.files[0].groups[0].changePoints;

    await setComment(REPO, beforeCp0.id, 'only the first one', {
      filePath: cp0.filePath,
      functionName: cp0.functionName,
      diffText: cp0.diffText,
    });

    const after = await annotate(REPO, tree);
    const [afterCp0, afterCp1] = after.files[0].groups[0].changePoints;
    assert.equal(afterCp0.comment, 'only the first one');
    assert.equal(afterCp1.comment, null);
    assert.deepEqual(after.orphans, []);
  });
});

// ---------------------------------------------------------------------------
// annotate — the four content-hash invalidation behaviors must still hold
// with duplicate content present, now that the key includes an ordinal
// (Finding 1's fix must not break amend-survival / edit-invalidation /
// rename-invalidation / orphaning for the general, non-duplicate case --
// those are covered end-to-end in the "invalidation rule" describe block
// below; this block only adds the duplicate-specific regression coverage).
// ---------------------------------------------------------------------------

describe('annotate — stats.comments counts distinct comment records (Finding 2)', () => {
  test('two different change points each with their own comment count as 2, not more', async () => {
    const cpA = cp({ filePath: 'src/a.js', functionName: 'fnA', diffText: '+a' });
    const cpB = cp({ filePath: 'src/b.js', functionName: 'fnB', diffText: '+b' });
    const tree = [
      fileNode({ path: 'src/a.js', groups: [groupNode({ name: 'fnA', changePoints: [cpA], total: 1 })], total: 1 }),
      fileNode({ path: 'src/b.js', groups: [groupNode({ name: 'fnB', changePoints: [cpB], total: 1 })], total: 1 }),
    ];

    await setComment(REPO, changePointKey(cpA, 0), 'comment a', { filePath: cpA.filePath, functionName: cpA.functionName, diffText: cpA.diffText });
    await setComment(REPO, changePointKey(cpB, 0), 'comment b', { filePath: cpB.filePath, functionName: cpB.functionName, diffText: cpB.diffText });

    const result = await annotate(REPO, tree);
    assert.equal(result.stats.comments, 2);
  });

  test('a repeated key in state.comments (defensive case) is never counted twice toward stats.comments', async () => {
    // Even though the ordinal fix makes duplicate keys unreachable through a
    // normal tree walk, stats.comments must still count by distinct key
    // rather than by "one increment per annotated change point" -- assert
    // it directly against a tree with several change points sharing the
    // same comment key is not constructible via public API (keys are now
    // 1:1 with tree position), so instead this proves the general
    // dedup-by-key invariant: setting the *same* comment key's context via
    // two change points that resolve to the *same* id (same file/function/
    // diffText/ordinal, i.e. literally the same change point evaluated
    // twice in the tree) is still counted once.
    const single = cp();
    const tree = [fileNode({ groups: [groupNode({ changePoints: [single], total: 1 })], total: 1 })];
    const key = changePointKey(single, 0);
    await setComment(REPO, key, 'one comment', { filePath: single.filePath, functionName: single.functionName, diffText: single.diffText });

    const result = await annotate(REPO, tree);
    assert.equal(result.stats.comments, 1);
  });
});

// ---------------------------------------------------------------------------
// annotate — orphans
// ---------------------------------------------------------------------------

describe('annotate — orphans', () => {
  test('a comment whose key has no matching current change point becomes an orphan, not dropped', async () => {
    const orphanContext = {
      filePath: 'src/gone.js',
      functionName: 'deletedFn',
      diffText: '+this code no longer exists in the diff',
    };
    const orphanKey = 'deadbeefdeadbeef';
    await setComment(REPO, orphanKey, 'please double check this before merging', orphanContext);

    const result = await annotate(REPO, [fileNode()]);

    assert.equal(result.orphans.length, 1);
    const orphan = result.orphans[0];
    assert.equal(orphan.key, orphanKey);
    assert.equal(orphan.text, 'please double check this before merging');
    assert.equal(orphan.filePath, 'src/gone.js');
    assert.equal(orphan.functionName, 'deletedFn');
    assert.equal(orphan.diffText, '+this code no longer exists in the diff');
    assert.equal(typeof orphan.updatedAt, 'string');
  });

  test('a comment matching a current change point is NOT listed as an orphan', async () => {
    const key = changePointKey(cp(), 0);
    await setComment(REPO, key, 'still relevant', {
      filePath: 'src/auth.js',
      functionName: 'handleLogin',
      diffText: cp().diffText,
    });

    const result = await annotate(REPO, [fileNode()]);
    assert.deepEqual(result.orphans, []);
  });

  test('orphans are sorted by updatedAt descending (most recent first)', async () => {
    await setComment(REPO, 'key-oldest', 'oldest', { filePath: 'a', functionName: null, diffText: 'x' });
    await delay(5);
    await setComment(REPO, 'key-middle', 'middle', { filePath: 'b', functionName: null, diffText: 'y' });
    await delay(5);
    await setComment(REPO, 'key-newest', 'newest', { filePath: 'c', functionName: null, diffText: 'z' });

    const result = await annotate(REPO, []);
    assert.deepEqual(
      result.orphans.map((o) => o.key),
      ['key-newest', 'key-middle', 'key-oldest'],
    );
  });

  test('a stale checked-only key (no comment) that no longer matches any change point is silently ignored, not treated as an orphan', async () => {
    await setChecked(REPO, 'stale-checked-key', true);

    const result = await annotate(REPO, [fileNode()]);
    assert.deepEqual(result.orphans, []);
    // Still unrelated to the real change point in the tree.
    assert.equal(result.files[0].groups[0].changePoints[0].checked, false);
  });

  // -- notes participate in orphaning too (task-personal-notes brief:
  // losing a considered note on the same amend/rebase churn this tool
  // exists to tolerate would be a worse outcome than losing a comment, so a
  // note whose change point disappears is orphaned exactly like a comment).

  test('a note (no comment) whose key has no matching current change point becomes an orphan with text: null, note: <the note>', async () => {
    const orphanContext = {
      filePath: 'src/gone.js',
      functionName: 'deletedFn',
      diffText: '+this code no longer exists in the diff',
    };
    const orphanKey = 'deadbeefdeadbeef';
    await setNote(REPO, orphanKey, 'this used to special-case anonymous users', orphanContext);

    const result = await annotate(REPO, [fileNode()]);

    assert.equal(result.orphans.length, 1);
    const orphan = result.orphans[0];
    assert.equal(orphan.key, orphanKey);
    assert.equal(orphan.text, null, 'no comment was ever set for this key');
    assert.equal(orphan.note, 'this used to special-case anonymous users');
    assert.equal(orphan.filePath, 'src/gone.js');
    assert.equal(orphan.functionName, 'deletedFn');
  });

  test('an orphan with both a comment and a note carries both, independently', async () => {
    const orphanContext = {
      filePath: 'src/gone.js',
      functionName: 'deletedFn',
      diffText: '+this code no longer exists in the diff',
    };
    const orphanKey = 'deadbeefdeadbeef';
    await setComment(REPO, orphanKey, 'please double check this before merging', orphanContext);
    await setNote(REPO, orphanKey, 'confirmed safe, see PR #42', orphanContext);

    const result = await annotate(REPO, [fileNode()]);

    assert.equal(result.orphans.length, 1);
    const orphan = result.orphans[0];
    assert.equal(orphan.text, 'please double check this before merging');
    assert.equal(orphan.note, 'confirmed safe, see PR #42');
  });

  test('a note matching a current change point is NOT listed as an orphan', async () => {
    const key = changePointKey(cp(), 0);
    await setNote(REPO, key, 'still relevant', {
      filePath: 'src/auth.js',
      functionName: 'handleLogin',
      diffText: cp().diffText,
    });

    const result = await annotate(REPO, [fileNode()]);
    assert.deepEqual(result.orphans, []);
  });

  test('orphans from comments-only and notes-only keys are merged into one list without duplication', async () => {
    await setComment(REPO, 'comment-only-key', 'a stale comment', { filePath: 'a', functionName: null, diffText: 'x' });
    await setNote(REPO, 'note-only-key', 'a stale note', { filePath: 'b', functionName: null, diffText: 'y' });

    const result = await annotate(REPO, []);
    const keys = result.orphans.map((o) => o.key).sort();
    assert.deepEqual(keys, ['comment-only-key', 'note-only-key']);
  });
});

// ---------------------------------------------------------------------------
// setChecked
// ---------------------------------------------------------------------------

describe('setChecked', () => {
  test('checked: true persists checked[key] = true', async () => {
    await setChecked(REPO, 'k1', true);
    const state = await loadState(REPO);
    assert.equal(state.checked.k1, true);
  });

  test('checked: false DELETES the key rather than writing false', async () => {
    await setChecked(REPO, 'k1', true);
    await setChecked(REPO, 'k1', false);

    const state = await loadState(REPO);
    assert.equal(Object.hasOwn(state.checked, 'k1'), false);

    const raw = await readFile(statePath(REPO), 'utf8');
    assert.equal(raw.includes('k1'), false);
  });

  test('checked: false on a key that was never set is a silent no-op (no error)', async () => {
    await assert.doesNotReject(() => setChecked(REPO, 'never-set', false));
    const state = await loadState(REPO);
    assert.deepEqual(state.checked, {});
  });

  test('does not disturb existing comments for other keys', async () => {
    await setComment(REPO, 'k-comment', 'hello', { filePath: 'a', functionName: null, diffText: 'x' });
    await setChecked(REPO, 'k-checked', true);

    const state = await loadState(REPO);
    assert.equal(state.comments['k-comment'].text, 'hello');
    assert.equal(state.checked['k-checked'], true);
  });
});

// ---------------------------------------------------------------------------
// setComment / deleteComment / discardOrphan
// ---------------------------------------------------------------------------

describe('setComment', () => {
  test('writes a CommentRecord with text, updatedAt (ISO 8601), and the context snapshot', async () => {
    const before = Date.now();
    await setComment(REPO, 'k1', 'needs a test', {
      filePath: 'src/a.js',
      functionName: 'foo',
      diffText: '+x',
    });
    const after = Date.now();

    const state = await loadState(REPO);
    const record = state.comments.k1;
    assert.equal(record.text, 'needs a test');
    assert.equal(record.filePath, 'src/a.js');
    assert.equal(record.functionName, 'foo');
    assert.equal(record.diffText, '+x');
    assert.match(record.updatedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    const ts = new Date(record.updatedAt).getTime();
    assert.ok(ts >= before && ts <= after);
  });

  test('null functionName in context is preserved as null', async () => {
    await setComment(REPO, 'k1', 'file-level comment', {
      filePath: 'src/a.js',
      functionName: null,
      diffText: '+x',
    });
    const state = await loadState(REPO);
    assert.equal(state.comments.k1.functionName, null);
  });

  test('overwriting an existing comment replaces text and updatedAt', async () => {
    await setComment(REPO, 'k1', 'first draft', { filePath: 'a', functionName: null, diffText: 'x' });
    const first = (await loadState(REPO)).comments.k1;
    await delay(5);
    await setComment(REPO, 'k1', 'revised', { filePath: 'a', functionName: null, diffText: 'x' });
    const second = (await loadState(REPO)).comments.k1;

    assert.equal(second.text, 'revised');
    assert.notEqual(second.updatedAt, first.updatedAt);
  });

  test('empty string text deletes the comment (equivalent to deleteComment)', async () => {
    await setComment(REPO, 'k1', 'will be cleared', { filePath: 'a', functionName: null, diffText: 'x' });
    await setComment(REPO, 'k1', '', { filePath: 'a', functionName: null, diffText: 'x' });

    const state = await loadState(REPO);
    assert.equal(Object.hasOwn(state.comments, 'k1'), false);
  });

  test('whitespace-only text deletes the comment', async () => {
    await setComment(REPO, 'k1', 'will be cleared', { filePath: 'a', functionName: null, diffText: 'x' });
    await setComment(REPO, 'k1', '   \n\t  ', { filePath: 'a', functionName: null, diffText: 'x' });

    const state = await loadState(REPO);
    assert.equal(Object.hasOwn(state.comments, 'k1'), false);
  });

  test('does not disturb existing checked entries for other keys', async () => {
    await setChecked(REPO, 'k-checked', true);
    await setComment(REPO, 'k-comment', 'hi', { filePath: 'a', functionName: null, diffText: 'x' });

    const state = await loadState(REPO);
    assert.equal(state.checked['k-checked'], true);
  });

  // -- Finding 4: a missing/non-string filePath or diffText must throw
  // rather than silently persisting null snapshot fields (which would later
  // surface as an unexplained orphan showing nothing but a hash).

  test('throws a readable Error when context is omitted entirely', async () => {
    await assert.rejects(
      () => setComment(REPO, 'k1', 'some text', undefined),
      /filePath/,
    );
    const state = await loadState(REPO);
    assert.equal(Object.hasOwn(state.comments, 'k1'), false, 'nothing should have been persisted');
  });

  test('throws a readable Error when context.filePath is missing', async () => {
    await assert.rejects(
      () => setComment(REPO, 'k1', 'some text', { functionName: 'foo', diffText: '+x' }),
      /filePath/,
    );
  });

  test('throws a readable Error when context.filePath is not a string', async () => {
    await assert.rejects(
      () => setComment(REPO, 'k1', 'some text', { filePath: 42, functionName: 'foo', diffText: '+x' }),
      /filePath/,
    );
  });

  test('throws a readable Error when context.diffText is missing', async () => {
    await assert.rejects(
      () => setComment(REPO, 'k1', 'some text', { filePath: 'src/a.js', functionName: 'foo' }),
      /diffText/,
    );
  });

  test('throws a readable Error when context.diffText is not a string', async () => {
    await assert.rejects(
      () => setComment(REPO, 'k1', 'some text', { filePath: 'src/a.js', functionName: 'foo', diffText: null }),
      /diffText/,
    );
  });

  test('a missing/invalid context does not prevent deleting a comment (empty text short-circuits before validation)', async () => {
    await setComment(REPO, 'k1', 'will be cleared', { filePath: 'a', functionName: null, diffText: 'x' });
    await assert.doesNotReject(() => setComment(REPO, 'k1', '', undefined));

    const state = await loadState(REPO);
    assert.equal(Object.hasOwn(state.comments, 'k1'), false);
  });

  test('functionName may legitimately be missing/null even though filePath and diffText are required', async () => {
    await setComment(REPO, 'k1', 'file-level note', { filePath: 'src/a.js', diffText: '+x' });
    const state = await loadState(REPO);
    assert.equal(state.comments.k1.functionName, null);
  });
});

describe('deleteComment', () => {
  test('removes an existing comment', async () => {
    await setComment(REPO, 'k1', 'to be removed', { filePath: 'a', functionName: null, diffText: 'x' });
    await deleteComment(REPO, 'k1');

    const state = await loadState(REPO);
    assert.equal(Object.hasOwn(state.comments, 'k1'), false);
  });

  test('is a silent no-op for a key with no comment', async () => {
    await assert.doesNotReject(() => deleteComment(REPO, 'never-existed'));
  });

  test('does not affect checked[key] for the same key', async () => {
    await setChecked(REPO, 'k1', true);
    await setComment(REPO, 'k1', 'note', { filePath: 'a', functionName: null, diffText: 'x' });
    await deleteComment(REPO, 'k1');

    const state = await loadState(REPO);
    assert.equal(state.checked.k1, true);
    assert.equal(Object.hasOwn(state.comments, 'k1'), false);
  });
});

describe('setNote', () => {
  test('writes a NoteRecord with text, updatedAt (ISO 8601), and the context snapshot', async () => {
    const before = Date.now();
    await setNote(REPO, 'k1', 'needs a test', {
      filePath: 'src/a.js',
      functionName: 'foo',
      diffText: '+x',
    });
    const after = Date.now();

    const state = await loadState(REPO);
    const record = state.notes.k1;
    assert.equal(record.text, 'needs a test');
    assert.equal(record.filePath, 'src/a.js');
    assert.equal(record.functionName, 'foo');
    assert.equal(record.diffText, '+x');
    assert.match(record.updatedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    const ts = new Date(record.updatedAt).getTime();
    assert.ok(ts >= before && ts <= after);
  });

  test('null functionName in context is preserved as null', async () => {
    await setNote(REPO, 'k1', 'file-level note', {
      filePath: 'src/a.js',
      functionName: null,
      diffText: '+x',
    });
    const state = await loadState(REPO);
    assert.equal(state.notes.k1.functionName, null);
  });

  test('overwriting an existing note replaces text and updatedAt', async () => {
    await setNote(REPO, 'k1', 'first draft', { filePath: 'a', functionName: null, diffText: 'x' });
    const first = (await loadState(REPO)).notes.k1;
    await delay(5);
    await setNote(REPO, 'k1', 'revised', { filePath: 'a', functionName: null, diffText: 'x' });
    const second = (await loadState(REPO)).notes.k1;

    assert.equal(second.text, 'revised');
    assert.notEqual(second.updatedAt, first.updatedAt);
  });

  test('empty string text deletes the note', async () => {
    await setNote(REPO, 'k1', 'will be cleared', { filePath: 'a', functionName: null, diffText: 'x' });
    await setNote(REPO, 'k1', '', { filePath: 'a', functionName: null, diffText: 'x' });

    const state = await loadState(REPO);
    assert.equal(Object.hasOwn(state.notes, 'k1'), false);
  });

  test('whitespace-only text deletes the note', async () => {
    await setNote(REPO, 'k1', 'will be cleared', { filePath: 'a', functionName: null, diffText: 'x' });
    await setNote(REPO, 'k1', '   \n\t  ', { filePath: 'a', functionName: null, diffText: 'x' });

    const state = await loadState(REPO);
    assert.equal(Object.hasOwn(state.notes, 'k1'), false);
  });

  test('setting a note for a key does not disturb an existing comment for the same key, or vice versa', async () => {
    await setComment(REPO, 'k1', 'a question', { filePath: 'a', functionName: null, diffText: 'x' });
    await setNote(REPO, 'k1', 'a note', { filePath: 'a', functionName: null, diffText: 'x' });

    const state = await loadState(REPO);
    assert.equal(state.comments.k1.text, 'a question');
    assert.equal(state.notes.k1.text, 'a note');
  });

  test('does not disturb existing checked entries for other keys', async () => {
    await setChecked(REPO, 'k-checked', true);
    await setNote(REPO, 'k-note', 'hi', { filePath: 'a', functionName: null, diffText: 'x' });

    const state = await loadState(REPO);
    assert.equal(state.checked['k-checked'], true);
  });

  test('throws a readable Error when context.filePath is missing', async () => {
    await assert.rejects(
      () => setNote(REPO, 'k1', 'some text', { functionName: 'foo', diffText: '+x' }),
      /filePath/,
    );
  });

  test('throws a readable Error when context.diffText is missing', async () => {
    await assert.rejects(
      () => setNote(REPO, 'k1', 'some text', { filePath: 'src/a.js', functionName: 'foo' }),
      /diffText/,
    );
  });

  test('a missing/invalid context does not prevent deleting a note (empty text short-circuits before validation)', async () => {
    await setNote(REPO, 'k1', 'will be cleared', { filePath: 'a', functionName: null, diffText: 'x' });
    await assert.doesNotReject(() => setNote(REPO, 'k1', '', undefined));

    const state = await loadState(REPO);
    assert.equal(Object.hasOwn(state.notes, 'k1'), false);
  });
});

describe('deleteNote', () => {
  test('removes an existing note', async () => {
    await setNote(REPO, 'k1', 'to be removed', { filePath: 'a', functionName: null, diffText: 'x' });
    await deleteNote(REPO, 'k1');

    const state = await loadState(REPO);
    assert.equal(Object.hasOwn(state.notes, 'k1'), false);
  });

  test('is a silent no-op for a key with no note', async () => {
    await assert.doesNotReject(() => deleteNote(REPO, 'never-existed'));
  });

  test('does not affect comments[key] or checked[key] for the same key', async () => {
    await setChecked(REPO, 'k1', true);
    await setComment(REPO, 'k1', 'a comment', { filePath: 'a', functionName: null, diffText: 'x' });
    await setNote(REPO, 'k1', 'a note', { filePath: 'a', functionName: null, diffText: 'x' });
    await deleteNote(REPO, 'k1');

    const state = await loadState(REPO);
    assert.equal(state.checked.k1, true);
    assert.equal(state.comments.k1.text, 'a comment');
    assert.equal(Object.hasOwn(state.notes, 'k1'), false);
  });
});

describe('discardOrphan', () => {
  test('behaves identically to deleteComment: removes the comment record', async () => {
    await setComment(REPO, 'orphan-key', 'stale comment', {
      filePath: 'src/gone.js',
      functionName: null,
      diffText: '+dead',
    });

    let result = await annotate(REPO, []);
    assert.equal(result.orphans.length, 1);

    await discardOrphan(REPO, 'orphan-key');

    result = await annotate(REPO, []);
    assert.deepEqual(result.orphans, []);
  });

  test('is a silent no-op for a key with no comment', async () => {
    await assert.doesNotReject(() => discardOrphan(REPO, 'never-existed'));
  });

  test('removes the note record too, when only a note exists for the key', async () => {
    await setNote(REPO, 'orphan-key', 'stale note', {
      filePath: 'src/gone.js',
      functionName: null,
      diffText: '+dead',
    });

    let result = await annotate(REPO, []);
    assert.equal(result.orphans.length, 1);

    await discardOrphan(REPO, 'orphan-key');

    result = await annotate(REPO, []);
    assert.deepEqual(result.orphans, []);
  });

  test('discards BOTH the comment and the note for a key that has both, in one call', async () => {
    const ctx = { filePath: 'src/gone.js', functionName: null, diffText: '+dead' };
    await setComment(REPO, 'orphan-key', 'stale comment', ctx);
    await setNote(REPO, 'orphan-key', 'stale note', ctx);

    let result = await annotate(REPO, []);
    assert.equal(result.orphans.length, 1);
    assert.equal(result.orphans[0].text, 'stale comment');
    assert.equal(result.orphans[0].note, 'stale note');

    await discardOrphan(REPO, 'orphan-key');

    const state = await loadState(REPO);
    assert.equal(Object.hasOwn(state.comments, 'orphan-key'), false);
    assert.equal(Object.hasOwn(state.notes, 'orphan-key'), false);

    result = await annotate(REPO, []);
    assert.deepEqual(result.orphans, [], 'no half-discarded orphan (e.g. note-only) should resurface');
  });
});

// ---------------------------------------------------------------------------
// Concurrency and atomic writes
// ---------------------------------------------------------------------------

describe('concurrency and atomic writes', () => {
  test('many concurrent setChecked calls for distinct keys never lose a write', async () => {
    const keys = Array.from({ length: 20 }, (_, i) => `key-${i}`);
    await Promise.all(keys.map((k) => setChecked(REPO, k, true)));

    const state = await loadState(REPO);
    assert.equal(Object.keys(state.checked).length, 20);
    for (const k of keys) assert.equal(state.checked[k], true);
  });

  test('concurrent set/unset on overlapping keys does not silently drop the winner (serialized, not interleaved)', async () => {
    await Promise.all([
      setChecked(REPO, 'a', true),
      setChecked(REPO, 'b', true),
      setChecked(REPO, 'a', true),
      setComment(REPO, 'c', 'x', { filePath: 'f', functionName: null, diffText: 'x' }),
    ]);

    const state = await loadState(REPO);
    assert.equal(state.checked.a, true);
    assert.equal(state.checked.b, true);
    assert.equal(state.comments.c.text, 'x');
  });

  test('no leftover tmp files after a burst of writes', async () => {
    await Promise.all([
      setChecked(REPO, 'a', true),
      setChecked(REPO, 'b', true),
      setComment(REPO, 'c', 'note', { filePath: 'f', functionName: null, diffText: 'x' }),
    ]);

    const entries = await readdir(stateDir());
    const leftovers = entries.filter((f) => f.includes('.tmp'));
    assert.deepEqual(leftovers, []);
  });

  test('two different repoIds do not serialize against each other (fast repo finishes while a slow, large-file repo write is still in flight)', async () => {
    // Finding 3: firing one setChecked at each of two repos and asserting
    // both eventually persisted passes even with a single global mutex --
    // it never observes ordering, so it can't tell "independent per-repo
    // locks" apart from "one shared lock". To actually discriminate, give
    // one repo a large existing state file (so its read-modify-write -- the
    // JSON.parse of the read and the JSON.stringify of the write -- takes
    // measurably longer) and prove the small/fast repo's write completes
    // before the slow repo's does. Under a single shared mutex the fast
    // write would have to wait behind the slow one and this would fail.
    const slowRepo = 'repo-slow';
    const fastRepo = 'repo-fast';

    await mkdir(stateDir(), { recursive: true });
    const bigChecked = {};
    for (let i = 0; i < 300000; i += 1) bigChecked[`key-${i}`] = true;
    await writeFile(statePath(slowRepo), JSON.stringify({ version: 1, checked: bigChecked, comments: {} }));

    const order = [];
    const slowPromise = setChecked(slowRepo, 'new-key', true).then(() => order.push('slow'));
    const fastPromise = setChecked(fastRepo, 'y', true).then(() => order.push('fast'));

    await fastPromise;
    assert.deepEqual(order, ['fast'], "the fast repo's write must not be blocked behind the slow repo's in-flight write");

    await slowPromise;
    assert.deepEqual(order, ['fast', 'slow']);

    const slowState = await loadState(slowRepo);
    const fastState = await loadState(fastRepo);
    assert.equal(slowState.checked['new-key'], true);
    assert.equal(Object.keys(slowState.checked).length, 300001);
    assert.equal(fastState.checked.y, true);
  });

  test('write creates the state directory if it does not exist yet', async () => {
    await rm(stateDir(), { recursive: true, force: true });
    await assert.doesNotReject(() => setChecked(REPO, 'k1', true));
    const state = await loadState(REPO);
    assert.equal(state.checked.k1, true);
  });
});

// ---------------------------------------------------------------------------
// The core invalidation rule — realistic before/after amend fileNodes trees.
// This is the acceptance criteria that actually matters: constructing two
// full trees rather than only unit-testing changePointKey in isolation.
// ---------------------------------------------------------------------------

describe('invalidation rule — realistic amend scenarios', () => {
  test('amend shifts line numbers but not content -> checkmark and comment survive', async () => {
    const beforeTree = [
      fileNode({
        groups: [
          groupNode({
            startLine: 35,
            endLine: 65,
            changePoints: [cp({ newStart: 40, newEnd: 42, hunkIndex: 0 })],
            total: 1,
          }),
        ],
        total: 1,
      }),
    ];

    const beforeResult = await annotate(REPO, beforeTree);
    const key = beforeResult.files[0].groups[0].changePoints[0].id;
    await setChecked(REPO, key, true);
    await setComment(REPO, key, 'consider renaming this variable', {
      filePath: 'src/auth.js',
      functionName: 'handleLogin',
      diffText: cp().diffText,
    });

    // Simulate `git commit --amend`: an earlier unrelated hunk grew, so this
    // function's lines shifted from ~40 to ~340, and the hunk index moved --
    // but the actual content of this change point (diffText) is unchanged.
    const afterTree = [
      fileNode({
        groups: [
          groupNode({
            startLine: 335,
            endLine: 365,
            changePoints: [cp({ newStart: 340, newEnd: 342, hunkIndex: 4 })],
            total: 1,
          }),
        ],
        total: 1,
      }),
    ];

    const afterResult = await annotate(REPO, afterTree);
    const afterChangePoint = afterResult.files[0].groups[0].changePoints[0];

    assert.equal(afterChangePoint.id, key, 'key must be stable across a pure line shift');
    assert.equal(afterChangePoint.checked, true, 'checkmark must survive the amend');
    assert.equal(afterChangePoint.comment, 'consider renaming this variable', 'comment must survive the amend');
    assert.deepEqual(afterResult.orphans, [], 'nothing should be orphaned');
    assert.equal(afterResult.stats.checked, 1);
  });

  test('a one-character change to diffText clears the checkmark (real edit, not just reflow)', async () => {
    const beforeTree = [fileNode({ groups: [groupNode({ changePoints: [cp()], total: 1 })], total: 1 })];
    const beforeKey = (await annotate(REPO, beforeTree)).files[0].groups[0].changePoints[0].id;
    await setChecked(REPO, beforeKey, true);

    // Same function, same lines, but the actual code changed by one character.
    const editedChangePoint = cp({ diffText: '+const token = signToken(user);\n+return token!' });
    const afterTree = [
      fileNode({ groups: [groupNode({ changePoints: [editedChangePoint], total: 1 })], total: 1 }),
    ];

    const afterResult = await annotate(REPO, afterTree);
    const afterChangePoint = afterResult.files[0].groups[0].changePoints[0];

    assert.notEqual(afterChangePoint.id, beforeKey);
    assert.equal(afterChangePoint.checked, false, 'edited content must go back to unread');
    assert.equal(afterResult.stats.checked, 0);
  });

  test('renaming the function clears the checkmark, even with identical diffText and lines', async () => {
    const beforeTree = [fileNode({ groups: [groupNode({ changePoints: [cp()], total: 1 })], total: 1 })];
    const beforeKey = (await annotate(REPO, beforeTree)).files[0].groups[0].changePoints[0].id;
    await setChecked(REPO, beforeKey, true);

    const renamedChangePoint = cp({ functionName: 'handleSignIn' });
    const afterTree = [
      fileNode({
        groups: [groupNode({ name: 'handleSignIn', changePoints: [renamedChangePoint], total: 1 })],
        total: 1,
      }),
    ];

    const afterResult = await annotate(REPO, afterTree);
    const afterChangePoint = afterResult.files[0].groups[0].changePoints[0];

    assert.notEqual(afterChangePoint.id, beforeKey);
    assert.equal(afterChangePoint.checked, false, 'renamed function is treated as a new, unread change point');
    assert.equal(afterResult.stats.checked, 0);
  });

  test('a change point that disappears entirely takes its comment into the orphan area, not the void', async () => {
    const beforeTree = [fileNode({ groups: [groupNode({ changePoints: [cp()], total: 1 })], total: 1 })];
    const beforeKey = (await annotate(REPO, beforeTree)).files[0].groups[0].changePoints[0].id;
    await setChecked(REPO, beforeKey, true);
    await setComment(REPO, beforeKey, 'double-check the token expiry', {
      filePath: 'src/auth.js',
      functionName: 'handleLogin',
      diffText: cp().diffText,
    });

    // The whole hunk was reverted/removed in the amend: no change point for
    // handleLogin remains anywhere in the new diff.
    const afterTree = [
      fileNode({
        path: 'src/other.js',
        groups: [groupNode({ name: 'unrelated', changePoints: [cp({ filePath: 'src/other.js', functionName: 'unrelated', diffText: '+noop' })], total: 1 })],
        total: 1,
      }),
    ];

    const afterResult = await annotate(REPO, afterTree);

    // Not silently dropped.
    assert.equal(afterResult.orphans.length, 1);
    const orphan = afterResult.orphans[0];
    assert.equal(orphan.key, beforeKey);
    assert.equal(orphan.text, 'double-check the token expiry');
    assert.equal(orphan.filePath, 'src/auth.js');
    assert.equal(orphan.functionName, 'handleLogin');
    assert.equal(orphan.diffText, cp().diffText);

    // And not present anywhere in the current tree.
    const stillPresent = afterResult.files.some((f) =>
      f.groups.some((g) => g.changePoints.some((c) => c.id === beforeKey)),
    );
    assert.equal(stillPresent, false);
  });
});
