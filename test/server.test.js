import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { createServer } from '../server.js';

const execFileAsync = promisify(execFile);

async function git(repoPath, args) {
  return execFileAsync('git', args, { cwd: repoPath });
}

async function makeTempRepo(label = 'repo') {
  const dir = await mkdtemp(join(tmpdir(), `local-code-review-server-test-${label}-`));
  await git(dir, ['init', '-q']);
  await git(dir, ['config', 'user.email', 'test@example.com']);
  await git(dir, ['config', 'user.name', 'Test']);
  await git(dir, ['commit', '--allow-empty', '-q', '-m', 'init']);
  return dir;
}

// ---------------------------------------------------------------------------
// Shared server-per-test setup. LCR_HOME is redirected to a fresh temp dir
// for every test so nothing ever touches the real ~/.local-code-review.
// ---------------------------------------------------------------------------

const ORIGINAL_LCR_HOME = process.env.LCR_HOME;

let lcrHome;
let server;
let baseUrl;
const cleanupDirs = [];

beforeEach(async () => {
  lcrHome = await mkdtemp(join(tmpdir(), 'local-code-review-server-test-home-'));
  process.env.LCR_HOME = lcrHome;

  server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}`;
});

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));

  if (ORIGINAL_LCR_HOME === undefined) {
    delete process.env.LCR_HOME;
  } else {
    process.env.LCR_HOME = ORIGINAL_LCR_HOME;
  }
  await rm(lcrHome, { recursive: true, force: true });

  while (cleanupDirs.length > 0) {
    const dir = cleanupDirs.pop();
    await rm(dir, { recursive: true, force: true });
  }
});

async function trackedTempRepo(label) {
  const dir = await makeTempRepo(label);
  cleanupDirs.push(dir);
  return dir;
}

// ---------------------------------------------------------------------------
// createServer() basics
// ---------------------------------------------------------------------------

describe('createServer', () => {
  test('returns an http.Server that is not yet listening', () => {
    const s = createServer();
    assert.equal(s.listening, false);
    s.close();
  });
});

// ---------------------------------------------------------------------------
// Static file serving
// ---------------------------------------------------------------------------

describe('static file serving', () => {
  test('GET / serves public/index.html', async () => {
    const res = await fetch(`${baseUrl}/`);
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.match(text, /local-code-review/);
  });

  test('GET /index.html serves the same file directly', async () => {
    const res = await fetch(`${baseUrl}/index.html`);
    assert.equal(res.status, 200);
  });

  test('unknown static path returns 404', async () => {
    const res = await fetch(`${baseUrl}/nope-not-a-file.html`);
    assert.equal(res.status, 404);
  });

  test('path traversal outside public/ is rejected, not served', async () => {
    const res = await fetch(`${baseUrl}/../server.js`);
    assert.notEqual(res.status, 200);
  });

  test('encoded path traversal outside public/ is rejected', async () => {
    const res = await fetch(`${baseUrl}/..%2Fserver.js`);
    assert.notEqual(res.status, 200);
  });
});

// ---------------------------------------------------------------------------
// /api/repos
// ---------------------------------------------------------------------------

describe('/api/repos', () => {
  test('GET returns an empty list for a fresh LCR_HOME', async () => {
    const res = await fetch(`${baseUrl}/api/repos`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8');
    const body = await res.json();
    assert.deepEqual(body, { repos: [] });
  });

  test('POST registers a valid git repo and GET then lists it', async () => {
    const repoPath = await trackedTempRepo('valid');

    const postRes = await fetch(`${baseUrl}/api/repos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: repoPath }),
    });
    assert.equal(postRes.status, 200);
    const postBody = await postRes.json();
    assert.equal(postBody.repo.path, repoPath);
    assert.ok(postBody.repo.id);

    const getRes = await fetch(`${baseUrl}/api/repos`);
    const getBody = await getRes.json();
    assert.equal(getBody.repos.length, 1);
    assert.equal(getBody.repos[0].id, postBody.repo.id);
  });

  test('POST with a non-git directory returns 400', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'local-code-review-not-a-repo-'));
    cleanupDirs.push(dir);

    const res = await fetch(`${baseUrl}/api/repos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: dir }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.ok(body.error);
  });

  test('POST with a nonexistent path returns 400', async () => {
    const res = await fetch(`${baseUrl}/api/repos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: join(tmpdir(), 'definitely-does-not-exist-xyz') }),
    });
    assert.equal(res.status, 400);
  });

  test('POST with missing path field returns 400', async () => {
    const res = await fetch(`${baseUrl}/api/repos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 400);
  });

  test('DELETE removes a registered repo', async () => {
    const repoPath = await trackedTempRepo('delete-me');
    const postRes = await fetch(`${baseUrl}/api/repos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: repoPath }),
    });
    const { repo } = await postRes.json();

    const delRes = await fetch(`${baseUrl}/api/repos/${repo.id}`, { method: 'DELETE' });
    assert.equal(delRes.status, 200);
    const delBody = await delRes.json();
    assert.equal(delBody.removed, true);

    const getRes = await fetch(`${baseUrl}/api/repos`);
    const getBody = await getRes.json();
    assert.equal(getBody.repos.length, 0);
  });

  test('DELETE of an unknown id returns removed: false', async () => {
    const delRes = await fetch(`${baseUrl}/api/repos/no-such-id`, { method: 'DELETE' });
    assert.equal(delRes.status, 200);
    const body = await delRes.json();
    assert.equal(body.removed, false);
  });
});

// ---------------------------------------------------------------------------
// /api/refs
// ---------------------------------------------------------------------------

describe('/api/refs', () => {
  test('lists branches, tags and current for a registered repo', async () => {
    const repoPath = await trackedTempRepo('refs');
    await git(repoPath, ['tag', 'v1.0.0']);
    const postRes = await fetch(`${baseUrl}/api/repos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: repoPath }),
    });
    const { repo } = await postRes.json();

    const res = await fetch(`${baseUrl}/api/refs?repo=${repo.id}`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.branches.includes(body.current));
    assert.ok(body.tags.includes('v1.0.0'));
  });

  test('returns 404 for an unknown repo id', async () => {
    const res = await fetch(`${baseUrl}/api/refs?repo=no-such-id`);
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.ok(body.error);
  });
});

// ---------------------------------------------------------------------------
// /api/diff, /api/check, /api/comment, /api/orphan/discard, /api/export
// ---------------------------------------------------------------------------

async function registerRepo(baseUrl, repoPath) {
  const res = await fetch(`${baseUrl}/api/repos`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: repoPath }),
  });
  const { repo } = await res.json();
  return repo;
}

describe('/api/diff', () => {
  test('returns the annotated tree for a base..target diff', async () => {
    const repoPath = await trackedTempRepo('diff-basic');
    await writeFile(join(repoPath, 'foo.js'), 'function foo() {\n  return 1;\n}\n');
    await git(repoPath, ['add', 'foo.js']);
    await git(repoPath, ['commit', '-q', '-m', 'add foo']);
    const base = (await git(repoPath, ['rev-parse', 'HEAD'])).stdout.trim();

    await writeFile(join(repoPath, 'foo.js'), 'function foo() {\n  return 2;\n}\n');
    await git(repoPath, ['add', 'foo.js']);
    await git(repoPath, ['commit', '-q', '-m', 'change foo']);
    const target = (await git(repoPath, ['rev-parse', 'HEAD'])).stdout.trim();

    const repo = await registerRepo(baseUrl, repoPath);

    const res = await fetch(`${baseUrl}/api/diff?repo=${repo.id}&base=${base}&target=${target}`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.base, base);
    assert.equal(body.target, target);
    assert.equal(body.files.length, 1);
    assert.equal(body.files[0].path, 'foo.js');
    assert.ok(body.stats);
    assert.deepEqual(body.orphans, []);
  });

  test('defaults target to WORKING_TREE when omitted', async () => {
    const repoPath = await trackedTempRepo('diff-default-target');
    await writeFile(join(repoPath, 'foo.js'), 'let x = 1;\n');
    await git(repoPath, ['add', 'foo.js']);
    await git(repoPath, ['commit', '-q', '-m', 'add foo']);
    const base = (await git(repoPath, ['rev-parse', 'HEAD'])).stdout.trim();
    await writeFile(join(repoPath, 'foo.js'), 'let x = 2;\n');

    const repo = await registerRepo(baseUrl, repoPath);
    const res = await fetch(`${baseUrl}/api/diff?repo=${repo.id}&base=${base}`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.files.length, 1);
  });

  test('returns 400 with a readable message when the ref does not exist', async () => {
    const repoPath = await trackedTempRepo('diff-bad-ref');
    const repo = await registerRepo(baseUrl, repoPath);

    const res = await fetch(`${baseUrl}/api/diff?repo=${repo.id}&base=no-such-ref&target=WORKING_TREE`);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /no-such-ref/);
  });

  test('returns 404 for an unknown repo id', async () => {
    const res = await fetch(`${baseUrl}/api/diff?repo=no-such-id&base=HEAD&target=WORKING_TREE`);
    assert.equal(res.status, 404);
  });

  test('handles deleted files without treating them as an error', async () => {
    const repoPath = await trackedTempRepo('diff-deleted');
    await writeFile(join(repoPath, 'gone.js'), 'const x = 1;\n');
    await git(repoPath, ['add', 'gone.js']);
    await git(repoPath, ['commit', '-q', '-m', 'add gone']);
    const base = (await git(repoPath, ['rev-parse', 'HEAD'])).stdout.trim();

    await git(repoPath, ['rm', '-q', 'gone.js']);
    await git(repoPath, ['commit', '-q', '-m', 'remove gone']);
    const target = (await git(repoPath, ['rev-parse', 'HEAD'])).stdout.trim();

    const repo = await registerRepo(baseUrl, repoPath);
    const res = await fetch(`${baseUrl}/api/diff?repo=${repo.id}&base=${base}&target=${target}`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.files[0].status, 'deleted');
  });
});

describe('/api/check and persistence', () => {
  test('end-to-end: build repo, diff, check a change point, re-GET and see it persisted', async () => {
    const repoPath = await trackedTempRepo('e2e');
    await writeFile(join(repoPath, 'foo.js'), 'function foo() {\n  return 1;\n}\n');
    await git(repoPath, ['add', 'foo.js']);
    await git(repoPath, ['commit', '-q', '-m', 'add foo']);
    const base = (await git(repoPath, ['rev-parse', 'HEAD'])).stdout.trim();

    await writeFile(join(repoPath, 'foo.js'), 'function foo() {\n  return 2;\n}\n');
    await git(repoPath, ['add', 'foo.js']);
    await git(repoPath, ['commit', '-q', '-m', 'change foo']);
    const target = (await git(repoPath, ['rev-parse', 'HEAD'])).stdout.trim();

    const repo = await registerRepo(baseUrl, repoPath);

    const firstDiff = await (
      await fetch(`${baseUrl}/api/diff?repo=${repo.id}&base=${base}&target=${target}`)
    ).json();

    const changePoint = firstDiff.files[0].groups[0].changePoints[0];
    assert.equal(changePoint.checked, false);

    const checkRes = await fetch(`${baseUrl}/api/check`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repo: repo.id, key: changePoint.id, checked: true }),
    });
    assert.equal(checkRes.status, 200);
    const checkBody = await checkRes.json();
    assert.deepEqual(checkBody, { ok: true });

    const secondDiff = await (
      await fetch(`${baseUrl}/api/diff?repo=${repo.id}&base=${base}&target=${target}`)
    ).json();
    const persisted = secondDiff.files[0].groups[0].changePoints[0];
    assert.equal(persisted.id, changePoint.id);
    assert.equal(persisted.checked, true);
    assert.equal(secondDiff.stats.checked, 1);
  });

  test('returns 400 for missing key', async () => {
    const repoPath = await trackedTempRepo('check-bad');
    const repo = await registerRepo(baseUrl, repoPath);
    const res = await fetch(`${baseUrl}/api/check`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repo: repo.id, checked: true }),
    });
    assert.equal(res.status, 400);
  });

  test('returns 404 for unknown repo', async () => {
    const res = await fetch(`${baseUrl}/api/check`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repo: 'no-such-id', key: 'abc', checked: true }),
    });
    assert.equal(res.status, 404);
  });
});

describe('/api/comment', () => {
  test('sets a comment with context, and it appears on the next /api/diff', async () => {
    const repoPath = await trackedTempRepo('comment');
    await writeFile(join(repoPath, 'foo.js'), 'function foo() {\n  return 1;\n}\n');
    await git(repoPath, ['add', 'foo.js']);
    await git(repoPath, ['commit', '-q', '-m', 'add foo']);
    const base = (await git(repoPath, ['rev-parse', 'HEAD'])).stdout.trim();

    await writeFile(join(repoPath, 'foo.js'), 'function foo() {\n  return 2;\n}\n');
    await git(repoPath, ['add', 'foo.js']);
    await git(repoPath, ['commit', '-q', '-m', 'change foo']);
    const target = (await git(repoPath, ['rev-parse', 'HEAD'])).stdout.trim();

    const repo = await registerRepo(baseUrl, repoPath);
    const diff = await (
      await fetch(`${baseUrl}/api/diff?repo=${repo.id}&base=${base}&target=${target}`)
    ).json();
    const changePoint = diff.files[0].groups[0].changePoints[0];

    const commentRes = await fetch(`${baseUrl}/api/comment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        repo: repo.id,
        key: changePoint.id,
        text: 'why did this change?',
        context: {
          filePath: changePoint.filePath,
          functionName: changePoint.functionName,
          diffText: changePoint.diffText,
        },
      }),
    });
    assert.equal(commentRes.status, 200);
    assert.deepEqual(await commentRes.json(), { ok: true });

    const after = await (
      await fetch(`${baseUrl}/api/diff?repo=${repo.id}&base=${base}&target=${target}`)
    ).json();
    assert.equal(after.files[0].groups[0].changePoints[0].comment, 'why did this change?');
    assert.equal(after.stats.comments, 1);
  });

  test('empty text deletes the comment', async () => {
    const repoPath = await trackedTempRepo('comment-delete');
    await writeFile(join(repoPath, 'foo.js'), 'let x = 1;\n');
    await git(repoPath, ['add', 'foo.js']);
    await git(repoPath, ['commit', '-q', '-m', 'add foo']);
    const base = (await git(repoPath, ['rev-parse', 'HEAD'])).stdout.trim();
    await writeFile(join(repoPath, 'foo.js'), 'let x = 2;\n');
    await git(repoPath, ['add', 'foo.js']);
    await git(repoPath, ['commit', '-q', '-m', 'change foo']);
    const target = (await git(repoPath, ['rev-parse', 'HEAD'])).stdout.trim();

    const repo = await registerRepo(baseUrl, repoPath);
    const diff = await (
      await fetch(`${baseUrl}/api/diff?repo=${repo.id}&base=${base}&target=${target}`)
    ).json();
    const changePoint = diff.files[0].groups[0].changePoints[0];

    await fetch(`${baseUrl}/api/comment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        repo: repo.id,
        key: changePoint.id,
        text: 'a question',
        context: { filePath: changePoint.filePath, functionName: changePoint.functionName, diffText: changePoint.diffText },
      }),
    });

    const delRes = await fetch(`${baseUrl}/api/comment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repo: repo.id, key: changePoint.id, text: '' }),
    });
    assert.equal(delRes.status, 200);

    const after = await (
      await fetch(`${baseUrl}/api/diff?repo=${repo.id}&base=${base}&target=${target}`)
    ).json();
    assert.equal(after.files[0].groups[0].changePoints[0].comment, null);
  });

  test('returns 404 for unknown repo', async () => {
    const res = await fetch(`${baseUrl}/api/comment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repo: 'no-such-id', key: 'abc', text: 'hi', context: { filePath: 'a', diffText: 'b' } }),
    });
    assert.equal(res.status, 404);
  });
});

describe('/api/orphan/discard', () => {
  test('discards an orphaned comment', async () => {
    const repoPath = await trackedTempRepo('orphan');
    await writeFile(join(repoPath, 'foo.js'), 'let x = 1;\n');
    await git(repoPath, ['add', 'foo.js']);
    await git(repoPath, ['commit', '-q', '-m', 'add foo']);
    const base = (await git(repoPath, ['rev-parse', 'HEAD'])).stdout.trim();
    await writeFile(join(repoPath, 'foo.js'), 'let x = 2;\n');
    await git(repoPath, ['add', 'foo.js']);
    await git(repoPath, ['commit', '-q', '-m', 'change foo']);
    const target = (await git(repoPath, ['rev-parse', 'HEAD'])).stdout.trim();

    const repo = await registerRepo(baseUrl, repoPath);
    const diff = await (
      await fetch(`${baseUrl}/api/diff?repo=${repo.id}&base=${base}&target=${target}`)
    ).json();
    const changePoint = diff.files[0].groups[0].changePoints[0];

    await fetch(`${baseUrl}/api/comment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        repo: repo.id,
        key: changePoint.id,
        text: 'a question',
        context: { filePath: changePoint.filePath, functionName: changePoint.functionName, diffText: changePoint.diffText },
      }),
    });

    // Change foo.js again so the previous change point becomes an orphan.
    await writeFile(join(repoPath, 'foo.js'), 'let x = 3;\nlet y = 4;\n');
    await git(repoPath, ['add', 'foo.js']);
    await git(repoPath, ['commit', '-q', '-m', 'change foo again']);
    const target2 = (await git(repoPath, ['rev-parse', 'HEAD'])).stdout.trim();

    const diffAfterOrphan = await (
      await fetch(`${baseUrl}/api/diff?repo=${repo.id}&base=${base}&target=${target2}`)
    ).json();
    assert.equal(diffAfterOrphan.orphans.length, 1);
    const orphanKey = diffAfterOrphan.orphans[0].key;

    const discardRes = await fetch(`${baseUrl}/api/orphan/discard`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repo: repo.id, key: orphanKey }),
    });
    assert.equal(discardRes.status, 200);
    assert.deepEqual(await discardRes.json(), { ok: true });

    const finalDiff = await (
      await fetch(`${baseUrl}/api/diff?repo=${repo.id}&base=${base}&target=${target2}`)
    ).json();
    assert.equal(finalDiff.orphans.length, 0);
  });
});

describe('/api/export', () => {
  test('claude format returns a text prompt', async () => {
    const repoPath = await trackedTempRepo('export-claude');
    await writeFile(join(repoPath, 'foo.js'), 'function foo() {\n  return 1;\n}\n');
    await git(repoPath, ['add', 'foo.js']);
    await git(repoPath, ['commit', '-q', '-m', 'add foo']);
    const base = (await git(repoPath, ['rev-parse', 'HEAD'])).stdout.trim();
    await writeFile(join(repoPath, 'foo.js'), 'function foo() {\n  return 2;\n}\n');
    await git(repoPath, ['add', 'foo.js']);
    await git(repoPath, ['commit', '-q', '-m', 'change foo']);
    const target = (await git(repoPath, ['rev-parse', 'HEAD'])).stdout.trim();

    const repo = await registerRepo(baseUrl, repoPath);
    const res = await fetch(
      `${baseUrl}/api/export?repo=${repo.id}&base=${base}&target=${target}&format=claude`,
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(typeof body.text, 'string');
    assert.ok(body.text.length > 0);
  });

  test('markdown format returns a text note', async () => {
    const repoPath = await trackedTempRepo('export-markdown');
    await writeFile(join(repoPath, 'foo.js'), 'let x = 1;\n');
    await git(repoPath, ['add', 'foo.js']);
    await git(repoPath, ['commit', '-q', '-m', 'add foo']);
    const base = (await git(repoPath, ['rev-parse', 'HEAD'])).stdout.trim();
    await writeFile(join(repoPath, 'foo.js'), 'let x = 2;\n');
    await git(repoPath, ['add', 'foo.js']);
    await git(repoPath, ['commit', '-q', '-m', 'change foo']);
    const target = (await git(repoPath, ['rev-parse', 'HEAD'])).stdout.trim();

    const repo = await registerRepo(baseUrl, repoPath);
    const res = await fetch(
      `${baseUrl}/api/export?repo=${repo.id}&base=${base}&target=${target}&format=markdown`,
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.match(body.text, /# Review:/);
  });

  test('invalid format returns 400', async () => {
    const repoPath = await trackedTempRepo('export-bad-format');
    const repo = await registerRepo(baseUrl, repoPath);
    const res = await fetch(
      `${baseUrl}/api/export?repo=${repo.id}&base=HEAD&target=WORKING_TREE&format=xml`,
    );
    assert.equal(res.status, 400);
  });
});

// ---------------------------------------------------------------------------
// General error handling
// ---------------------------------------------------------------------------

describe('error handling', () => {
  test('malformed JSON body returns 400, not a crash', async () => {
    const res = await fetch(`${baseUrl}/api/repos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{not valid json',
    });
    assert.equal(res.status, 400);

    // Server must still be alive and answering afterward.
    const followUp = await fetch(`${baseUrl}/api/repos`);
    assert.equal(followUp.status, 200);
  });

  test('unknown /api/ route returns 404 JSON, not a static-file lookup', async () => {
    const res = await fetch(`${baseUrl}/api/does-not-exist`);
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.ok(body.error);
  });
});
