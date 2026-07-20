import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { listRefs, getDiff, getFileContent, parseDiff } from '../git.js';

const execFileAsync = promisify(execFile);

async function git(repoPath, args) {
  return execFileAsync('git', args, { cwd: repoPath });
}

async function makeTempRepo() {
  const dir = await mkdtemp(join(tmpdir(), 'local-code-review-git-test-'));
  await git(dir, ['init', '-q']);
  await git(dir, ['config', 'user.email', 'test@example.com']);
  await git(dir, ['config', 'user.name', 'Test']);
  await git(dir, ['commit', '--allow-empty', '-q', '-m', 'init']);
  return dir;
}

// ---------------------------------------------------------------------------
// parseDiff (pure function) — hand-written unified diff fixtures
// ---------------------------------------------------------------------------

describe('parseDiff', () => {
  test('parses a modified file with a single hunk and correct line numbers', () => {
    const raw = `diff --git a/foo.js b/foo.js
index e69de29..b6fc4c9 100644
--- a/foo.js
+++ b/foo.js
@@ -1,3 +1,4 @@
 line1
-line2
+line2 modified
+line3 new
 line4
`;
    const result = parseDiff(raw);
    assert.equal(result.length, 1);
    const file = result[0];
    assert.equal(file.path, 'foo.js');
    assert.equal(file.oldPath, null);
    assert.equal(file.status, 'modified');
    assert.equal(file.hunks.length, 1);

    const hunk = file.hunks[0];
    assert.equal(hunk.oldStart, 1);
    assert.equal(hunk.oldLines, 3);
    assert.equal(hunk.newStart, 1);
    assert.equal(hunk.newLines, 4);
    assert.equal(hunk.header, '');

    assert.deepEqual(hunk.lines, [
      { type: ' ', text: 'line1', oldLine: 1, newLine: 1 },
      { type: '-', text: 'line2', oldLine: 2, newLine: null },
      { type: '+', text: 'line2 modified', oldLine: null, newLine: 2 },
      { type: '+', text: 'line3 new', oldLine: null, newLine: 3 },
      { type: ' ', text: 'line4', oldLine: 3, newLine: 4 },
    ]);
  });

  test('parses hunk header text after the @@ markers', () => {
    const raw = `diff --git a/foo.js b/foo.js
index e69de29..b6fc4c9 100644
--- a/foo.js
+++ b/foo.js
@@ -1,2 +1,2 @@ function foo() {
 line1
-line2
+line2 modified
`;
    const result = parseDiff(raw);
    assert.equal(result[0].hunks[0].header, 'function foo() {');
  });

  test('parses a hunk header with omitted line counts as 1', () => {
    const raw = `diff --git a/foo.js b/foo.js
index e69de29..b6fc4c9 100644
--- a/foo.js
+++ b/foo.js
@@ -1 +1 @@
-line1
+line1 modified
`;
    const hunk = parseDiff(raw)[0].hunks[0];
    assert.equal(hunk.oldStart, 1);
    assert.equal(hunk.oldLines, 1);
    assert.equal(hunk.newStart, 1);
    assert.equal(hunk.newLines, 1);
  });

  test('parses an added file', () => {
    const raw = `diff --git a/new.js b/new.js
new file mode 100644
index 0000000..e69de29
--- /dev/null
+++ b/new.js
@@ -0,0 +1,2 @@
+line1
+line2
`;
    const result = parseDiff(raw);
    assert.equal(result.length, 1);
    assert.equal(result[0].path, 'new.js');
    assert.equal(result[0].oldPath, null);
    assert.equal(result[0].status, 'added');
    assert.equal(result[0].hunks[0].lines.length, 2);
    assert.deepEqual(result[0].hunks[0].lines[0], { type: '+', text: 'line1', oldLine: null, newLine: 1 });
  });

  test('parses a deleted file, keeping the old path as path', () => {
    const raw = `diff --git a/old.js b/old.js
deleted file mode 100644
index e69de29..0000000
--- a/old.js
+++ /dev/null
@@ -1,2 +0,0 @@
-line1
-line2
`;
    const result = parseDiff(raw);
    assert.equal(result.length, 1);
    assert.equal(result[0].path, 'old.js');
    assert.equal(result[0].oldPath, null);
    assert.equal(result[0].status, 'deleted');
    assert.deepEqual(result[0].hunks[0].lines[0], { type: '-', text: 'line1', oldLine: 1, newLine: null });
  });

  test('parses a pure rename with no content changes (no hunks)', () => {
    const raw = `diff --git a/old_name.js b/new_name.js
similarity index 100%
rename from old_name.js
rename to new_name.js
`;
    const result = parseDiff(raw);
    assert.equal(result.length, 1);
    assert.equal(result[0].path, 'new_name.js');
    assert.equal(result[0].oldPath, 'old_name.js');
    assert.equal(result[0].status, 'renamed');
    assert.deepEqual(result[0].hunks, []);
  });

  test('parses a rename with content changes (has hunks)', () => {
    const raw = `diff --git a/old_name.js b/new_name.js
similarity index 80%
rename from old_name.js
rename to new_name.js
index e69de29..b6fc4c9 100644
--- a/old_name.js
+++ b/new_name.js
@@ -1,2 +1,2 @@
 line1
-line2
+line2 changed
`;
    const result = parseDiff(raw);
    assert.equal(result.length, 1);
    assert.equal(result[0].path, 'new_name.js');
    assert.equal(result[0].oldPath, 'old_name.js');
    assert.equal(result[0].status, 'renamed');
    assert.equal(result[0].hunks.length, 1);
    assert.equal(result[0].hunks[0].lines.length, 3);
  });

  test('parses a binary file diff without hunks and without crashing', () => {
    const raw = `diff --git a/image.png b/image.png
index abc1234..def5678 100644
Binary files a/image.png and b/image.png differ
`;
    const result = parseDiff(raw);
    assert.equal(result.length, 1);
    assert.equal(result[0].path, 'image.png');
    assert.equal(result[0].oldPath, null);
    assert.equal(result[0].status, 'binary');
    assert.deepEqual(result[0].hunks, []);
  });

  test('ignores "\\ No newline at end of file" marker lines', () => {
    const raw = `diff --git a/foo.js b/foo.js
index e69de29..b6fc4c9 100644
--- a/foo.js
+++ b/foo.js
@@ -1,1 +1,1 @@
-line1
\\ No newline at end of file
+line1 modified
\\ No newline at end of file
`;
    const hunk = parseDiff(raw)[0].hunks[0];
    assert.equal(hunk.lines.length, 2);
    assert.deepEqual(hunk.lines[0], { type: '-', text: 'line1', oldLine: 1, newLine: null });
    assert.deepEqual(hunk.lines[1], { type: '+', text: 'line1 modified', oldLine: null, newLine: 1 });
  });

  test('parses multiple files in one diff, each with correct status', () => {
    const raw = `diff --git a/a.js b/a.js
index e69de29..b6fc4c9 100644
--- a/a.js
+++ b/a.js
@@ -1,1 +1,1 @@
-a1
+a1 modified
diff --git a/b.js b/b.js
new file mode 100644
index 0000000..e69de29
--- /dev/null
+++ b/b.js
@@ -0,0 +1,1 @@
+b1
`;
    const result = parseDiff(raw);
    assert.equal(result.length, 2);
    assert.equal(result[0].path, 'a.js');
    assert.equal(result[0].status, 'modified');
    assert.equal(result[1].path, 'b.js');
    assert.equal(result[1].status, 'added');
  });

  test('handles a hunk containing a truly empty context line', () => {
    // A blank line in the original file shows up in unified diff as a lone
    // marker character (a single space) with no text after it.
    const raw = [
      'diff --git a/foo.js b/foo.js',
      'index e69de29..b6fc4c9 100644',
      '--- a/foo.js',
      '+++ b/foo.js',
      '@@ -1,3 +1,3 @@',
      ' line1',
      ' ',
      '-line3',
      '+line3 modified',
      '',
    ].join('\n');
    const hunk = parseDiff(raw)[0].hunks[0];
    assert.deepEqual(hunk.lines[1], { type: ' ', text: '', oldLine: 2, newLine: 2 });
  });

  test('returns an empty array for an empty diff', () => {
    assert.deepEqual(parseDiff(''), []);
  });

  test('does not touch the filesystem (pure function)', () => {
    // Calling with a bogus path-shaped string must not throw an fs-related error.
    assert.doesNotThrow(() => parseDiff('not a real diff at all'));
  });
});

// ---------------------------------------------------------------------------
// listRefs / getDiff / getFileContent — real temp git repo
// ---------------------------------------------------------------------------

describe('listRefs', () => {
  test('lists branches, tags and the current branch of a repo', async () => {
    const repo = await makeTempRepo();
    try {
      await git(repo, ['branch', 'feature-x']);
      await git(repo, ['tag', 'v1.0.0']);
      const refs = await listRefs(repo);
      assert.ok(refs.branches.includes('feature-x'));
      assert.ok(refs.tags.includes('v1.0.0'));
      assert.ok(refs.branches.includes(refs.current));
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});

describe('getDiff', () => {
  test('diffs base against the working tree when target is null', async () => {
    const repo = await makeTempRepo();
    try {
      await writeFile(join(repo, 'file.txt'), 'hello\n');
      await git(repo, ['add', 'file.txt']);
      await git(repo, ['commit', '-q', '-m', 'add file']);
      await writeFile(join(repo, 'file.txt'), 'hello world\n');

      const diff = await getDiff(repo, 'HEAD', null);
      assert.match(diff, /file\.txt/);
      assert.match(diff, /-hello/);
      assert.match(diff, /\+hello world/);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  test('diffs base against the working tree when target is WORKING_TREE', async () => {
    const repo = await makeTempRepo();
    try {
      await writeFile(join(repo, 'file.txt'), 'hello\n');
      await git(repo, ['add', 'file.txt']);
      await git(repo, ['commit', '-q', '-m', 'add file']);
      await writeFile(join(repo, 'file.txt'), 'hello world\n');

      const diff = await getDiff(repo, 'HEAD', 'WORKING_TREE');
      assert.match(diff, /file\.txt/);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  test('uses three-dot semantics when diffing two refs', async () => {
    const repo = await makeTempRepo();
    try {
      await git(repo, ['branch', 'base-branch']);
      await writeFile(join(repo, 'file.txt'), 'hello\n');
      await git(repo, ['add', 'file.txt']);
      await git(repo, ['commit', '-q', '-m', 'on main']);
      await git(repo, ['checkout', '-q', '-b', 'feature-branch', 'base-branch']);
      await writeFile(join(repo, 'other.txt'), 'feature content\n');
      await git(repo, ['add', 'other.txt']);
      await git(repo, ['commit', '-q', '-m', 'on feature']);

      const diff = await getDiff(repo, 'base-branch', 'feature-branch');
      assert.match(diff, /other\.txt/);
      // three-dot diff should NOT show file.txt (which only exists on base-branch's
      // divergent history relative to the merge base, not on feature-branch's side)
      assert.doesNotMatch(diff, /file\.txt/);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  test('throws a readable error when git fails', async () => {
    const repo = await makeTempRepo();
    try {
      await assert.rejects(
        () => getDiff(repo, 'no-such-ref', null),
        (err) => {
          assert.ok(err instanceof Error);
          // Message must name the failing git invocation and carry git's stderr text,
          // not just be a generic Error.
          assert.match(err.message, /^git diff no-such-ref failed:/);
          assert.match(err.message, /no-such-ref/);
          return true;
        },
      );
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});

describe('getFileContent', () => {
  test('reads working tree file content when ref is null', async () => {
    const repo = await makeTempRepo();
    try {
      await mkdir(join(repo, 'src'), { recursive: true });
      await writeFile(join(repo, 'src', 'file.txt'), 'working tree content\n');
      const content = await getFileContent(repo, null, 'src/file.txt');
      assert.equal(content, 'working tree content\n');
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  test('reads working tree file content when ref is WORKING_TREE', async () => {
    const repo = await makeTempRepo();
    try {
      await writeFile(join(repo, 'file.txt'), 'working tree content\n');
      const content = await getFileContent(repo, 'WORKING_TREE', 'file.txt');
      assert.equal(content, 'working tree content\n');
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  test('reads file content from a specific ref', async () => {
    const repo = await makeTempRepo();
    try {
      await writeFile(join(repo, 'file.txt'), 'committed content\n');
      await git(repo, ['add', 'file.txt']);
      await git(repo, ['commit', '-q', '-m', 'add file']);
      await writeFile(join(repo, 'file.txt'), 'changed content\n');

      const content = await getFileContent(repo, 'HEAD', 'file.txt');
      assert.equal(content, 'committed content\n');
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  test('returns null when the file does not exist in the working tree', async () => {
    const repo = await makeTempRepo();
    try {
      const content = await getFileContent(repo, null, 'does-not-exist.txt');
      assert.equal(content, null);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  test('returns null when the file does not exist at the given ref', async () => {
    const repo = await makeTempRepo();
    try {
      await writeFile(join(repo, 'file.txt'), 'content\n');
      await git(repo, ['add', 'file.txt']);
      await git(repo, ['commit', '-q', '-m', 'add file']);

      const content = await getFileContent(repo, 'HEAD', 'does-not-exist.txt');
      assert.equal(content, null);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  test('returns null when the file exists on disk but not in the given ref', async () => {
    const repo = await makeTempRepo();
    try {
      await writeFile(join(repo, 'uncommitted.txt'), 'not committed\n');

      const content = await getFileContent(repo, 'HEAD', 'uncommitted.txt');
      assert.equal(content, null);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  test('throws a readable error when the ref is invalid, instead of returning null', async () => {
    const repo = await makeTempRepo();
    try {
      await writeFile(join(repo, 'file.txt'), 'content\n');
      await git(repo, ['add', 'file.txt']);
      await git(repo, ['commit', '-q', '-m', 'add file']);

      await assert.rejects(
        () => getFileContent(repo, 'no-such-ref', 'file.txt'),
        (err) => {
          assert.ok(err instanceof Error);
          assert.match(err.message, /^git show no-such-ref:file\.txt failed:/);
          assert.match(err.message, /no-such-ref/);
          return true;
        },
      );
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Option-injection hardening.
//
// getDiff/getFileContent interpolate caller-supplied refs into a git command
// line. server.js validates refs before they get here, but this layer must
// stand on its own: a ref that looks like an option must never be *parsed* as
// one, no matter what the caller did or failed to do.
// ---------------------------------------------------------------------------

describe('option injection hardening', () => {
  async function assertNoFileWritten(probe) {
    await assert.rejects(
      () => import('node:fs/promises').then((fs) => fs.access(probe)),
      'git executed an injected option and wrote a file',
    );
  }

  test('getDiff cannot be tricked into treating a base ref as an option', async () => {
    const repo = await makeTempRepo();
    const probe = join(tmpdir(), `lcr-git-pwned-diff-${process.pid}-${Date.now()}.txt`);
    try {
      await writeFile(join(repo, 'file.txt'), 'content\n');
      await git(repo, ['add', 'file.txt']);
      await git(repo, ['commit', '-q', '-m', 'add file']);

      await assert.rejects(() => getDiff(repo, `--output=${probe}`, null));
      await assertNoFileWritten(probe);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  test('getDiff cannot be tricked via the target ref either', async () => {
    const repo = await makeTempRepo();
    const probe = join(tmpdir(), `lcr-git-pwned-target-${process.pid}-${Date.now()}.txt`);
    try {
      // A bare assert.rejects isn't enough here: `base` and `target` are
      // joined into a single `${base}...${target}` string before it ever
      // reaches git, so the malformed target was never a separate argv
      // element for `--end-of-options` to neutralize -- it fails as a bad
      // revision whether or not the fix is present. Pre-fix (no
      // `--end-of-options`/`--`), git rejects it with "fatal: ambiguous
      // argument ... unknown revision or path not in the working tree",
      // plus a hint to use `--` -- the exact absence the fix addresses.
      // Post-fix, the same string fails earlier as a plain "fatal: bad
      // revision", proving the separators are actually being passed.
      await assert.rejects(
        () => getDiff(repo, 'HEAD', `--output=${probe}`),
        (err) => {
          assert.match(err.message, /bad revision/);
          assert.doesNotMatch(err.message, /ambiguous argument/);
          return true;
        },
      );
      await assertNoFileWritten(probe);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  test('getFileContent cannot be tricked into treating a ref as an option', async () => {
    const repo = await makeTempRepo();
    const probe = join(tmpdir(), `lcr-git-pwned-show-${process.pid}-${Date.now()}.txt`);
    try {
      await writeFile(join(repo, 'file.txt'), 'content\n');
      await git(repo, ['add', 'file.txt']);
      await git(repo, ['commit', '-q', '-m', 'add file']);

      await assert.rejects(() => getFileContent(repo, `--output=${probe}`, 'file.txt'));
      await assertNoFileWritten(probe);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  test('the readable error message still names the git invocation, without the guards', async () => {
    const repo = await makeTempRepo();
    try {
      await assert.rejects(
        () => getDiff(repo, 'no-such-ref', 'also-missing'),
        (err) => {
          // The `--end-of-options` / `--` guards are implementation detail and
          // must not leak into the message the user sees.
          assert.doesNotMatch(err.message, /--end-of-options/);
          assert.match(err.message, /^git diff no-such-ref\.\.\.also-missing failed:/);
          return true;
        },
      );
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});
