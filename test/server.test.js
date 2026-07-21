import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, access, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import net from 'node:net';

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

/**
 * Sends a request over a raw TCP socket so the request target reaches the
 * server exactly as written. `fetch` normalises paths like `/../server.js`
 * before they leave the client, so a traversal assertion made through
 * `fetch` never actually tests the server -- this does.
 */
function rawRequest(requestTarget, { method = 'GET', headers = {}, body = null } = {}) {
  const { port } = server.address();
  return new Promise((resolvePromise, rejectPromise) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      const lines = [
        `${method} ${requestTarget} HTTP/1.1`,
        `Host: 127.0.0.1:${port}`,
        'Connection: close',
      ];
      for (const [name, value] of Object.entries(headers)) lines.push(`${name}: ${value}`);
      if (body !== null) lines.push(`Content-Length: ${Buffer.byteLength(body)}`);
      socket.write(`${lines.join('\r\n')}\r\n\r\n${body ?? ''}`);
    });

    let data = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      data += chunk;
    });
    socket.on('end', () => {
      const match = /^HTTP\/1\.\d (\d{3})/.exec(data);
      resolvePromise({ status: match ? Number(match[1]) : null, raw: data });
    });
    socket.on('error', rejectPromise);
  });
}

async function fileExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
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

  // NOTE: these go over a raw socket on purpose. `fetch('/../server.js')`
  // normalises the path client-side, so the server never sees a traversal and
  // the assertion proves nothing.
  test('raw-socket path traversal outside public/ returns exactly 404', async () => {
    const res = await rawRequest('/../server.js');
    assert.equal(res.status, 404);
    assert.doesNotMatch(res.raw, /createServer/);
  });

  test('raw-socket deep traversal to an absolute path returns exactly 404', async () => {
    const res = await rawRequest('/../../../../etc/passwd');
    assert.equal(res.status, 404);
    assert.doesNotMatch(res.raw, /root:/);
  });

  test('encoded path traversal outside public/ returns exactly 404', async () => {
    const res = await fetch(`${baseUrl}/..%2Fserver.js`);
    assert.equal(res.status, 404);
    assert.doesNotMatch(await res.text(), /createServer/);
  });

  test('double-encoded traversal returns exactly 404', async () => {
    const res = await rawRequest('/%2e%2e%2fserver.js');
    assert.equal(res.status, 404);
    assert.doesNotMatch(res.raw, /createServer/);
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

describe('/api/note', () => {
  test('sets a note with context, and it appears on the next /api/diff -- independently of any comment', async () => {
    const repoPath = await trackedTempRepo('note');
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
    assert.equal(changePoint.comment, null);
    assert.equal(changePoint.note, null);

    const noteRes = await fetch(`${baseUrl}/api/note`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        repo: repo.id,
        key: changePoint.id,
        text: 'this just changes the return value, nothing else',
        context: {
          filePath: changePoint.filePath,
          functionName: changePoint.functionName,
          diffText: changePoint.diffText,
        },
      }),
    });
    assert.equal(noteRes.status, 200);
    assert.deepEqual(await noteRes.json(), { ok: true });

    const after = await (
      await fetch(`${baseUrl}/api/diff?repo=${repo.id}&base=${base}&target=${target}`)
    ).json();
    assert.equal(after.files[0].groups[0].changePoints[0].note, 'this just changes the return value, nothing else');
    // Setting a note must not make the change point look commented, and
    // must not perturb the comment-only stats.comments counter.
    assert.equal(after.files[0].groups[0].changePoints[0].comment, null);
    assert.equal(after.stats.comments, 0);
  });

  test('empty text deletes the note', async () => {
    const repoPath = await trackedTempRepo('note-delete');
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

    await fetch(`${baseUrl}/api/note`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        repo: repo.id,
        key: changePoint.id,
        text: 'a note',
        context: { filePath: changePoint.filePath, functionName: changePoint.functionName, diffText: changePoint.diffText },
      }),
    });

    const delRes = await fetch(`${baseUrl}/api/note`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repo: repo.id, key: changePoint.id, text: '' }),
    });
    assert.equal(delRes.status, 200);

    const after = await (
      await fetch(`${baseUrl}/api/diff?repo=${repo.id}&base=${base}&target=${target}`)
    ).json();
    assert.equal(after.files[0].groups[0].changePoints[0].note, null);
  });

  test('returns 404 for unknown repo', async () => {
    const res = await fetch(`${baseUrl}/api/note`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repo: 'no-such-id', key: 'abc', text: 'hi', context: { filePath: 'a', diffText: 'b' } }),
    });
    assert.equal(res.status, 404);
  });

  test('a comment and a note can coexist on the same change point, set and read back independently', async () => {
    const repoPath = await trackedTempRepo('note-and-comment');
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
    const context = { filePath: changePoint.filePath, functionName: changePoint.functionName, diffText: changePoint.diffText };

    await fetch(`${baseUrl}/api/comment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repo: repo.id, key: changePoint.id, text: 'why 2?', context }),
    });
    await fetch(`${baseUrl}/api/note`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repo: repo.id, key: changePoint.id, text: 'confirmed intentional', context }),
    });

    const after = await (
      await fetch(`${baseUrl}/api/diff?repo=${repo.id}&base=${base}&target=${target}`)
    ).json();
    const afterCp = after.files[0].groups[0].changePoints[0];
    assert.equal(afterCp.comment, 'why 2?');
    assert.equal(afterCp.note, 'confirmed intentional');
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

  test('discards BOTH the comment and the note for an orphan that has both', async () => {
    const repoPath = await trackedTempRepo('orphan-comment-and-note');
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
    const context = { filePath: changePoint.filePath, functionName: changePoint.functionName, diffText: changePoint.diffText };

    await fetch(`${baseUrl}/api/comment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repo: repo.id, key: changePoint.id, text: 'a question', context }),
    });
    await fetch(`${baseUrl}/api/note`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repo: repo.id, key: changePoint.id, text: 'a note', context }),
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
    assert.equal(diffAfterOrphan.orphans[0].text, 'a question');
    assert.equal(diffAfterOrphan.orphans[0].note, 'a note');
    const orphanKey = diffAfterOrphan.orphans[0].key;

    await fetch(`${baseUrl}/api/orphan/discard`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repo: repo.id, key: orphanKey }),
    });

    const finalDiff = await (
      await fetch(`${baseUrl}/api/diff?repo=${repo.id}&base=${base}&target=${target2}`)
    ).json();
    assert.equal(finalDiff.orphans.length, 0, 'neither the comment nor the note half should resurface as a leftover orphan');
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

  test('a note-only change point (no comment) is excluded from the claude export but included in the markdown export', async () => {
    const repoPath = await trackedTempRepo('export-note-only');
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

    await fetch(`${baseUrl}/api/note`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        repo: repo.id,
        key: changePoint.id,
        text: 'this note-only marker must never reach the claude prompt',
        context: { filePath: changePoint.filePath, functionName: changePoint.functionName, diffText: changePoint.diffText },
      }),
    });

    const claudeText = await (
      await fetch(`${baseUrl}/api/export?repo=${repo.id}&base=${base}&target=${target}&format=claude`)
    ).json();
    assert.ok(
      !claudeText.text.includes('this note-only marker must never reach the claude prompt'),
      'a note with no comment must be excluded from the Claude prompt export entirely',
    );

    const markdownText = await (
      await fetch(`${baseUrl}/api/export?repo=${repo.id}&base=${base}&target=${target}&format=markdown`)
    ).json();
    assert.ok(
      markdownText.text.includes('this note-only marker must never reach the claude prompt'),
      'the same note must appear in the Markdown export',
    );
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
// /api/lines — expand unmodified context around a diff for GitHub-style
// "expand above/below". Reuses requireRef for `ref` and adds its own
// containment check for `path`, since that parameter has no equivalent
// existing defence.
// ---------------------------------------------------------------------------

describe('/api/lines', () => {
  test('returns the requested 1-based inclusive line range', async () => {
    const repoPath = await trackedTempRepo('lines-basic');
    const content = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
    await writeFile(join(repoPath, 'foo.js'), content);
    await git(repoPath, ['add', 'foo.js']);
    await git(repoPath, ['commit', '-q', '-m', 'add foo']);
    const head = (await git(repoPath, ['rev-parse', 'HEAD'])).stdout.trim();
    const repo = await registerRepo(baseUrl, repoPath);

    const res = await fetch(
      `${baseUrl}/api/lines?repo=${repo.id}&ref=${head}&path=foo.js&start=5&end=8`,
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.path, 'foo.js');
    assert.equal(body.ref, head);
    assert.equal(body.start, 5);
    assert.equal(body.end, 8);
    assert.equal(body.totalLines, 20);
    assert.deepEqual(body.lines, [
      { n: 5, text: 'line 5' },
      { n: 6, text: 'line 6' },
      { n: 7, text: 'line 7' },
      { n: 8, text: 'line 8' },
    ]);
  });

  test('clamps an out-of-range start/end to the file bounds instead of erroring', async () => {
    const repoPath = await trackedTempRepo('lines-clamp');
    const content = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
    await writeFile(join(repoPath, 'foo.js'), content);
    await git(repoPath, ['add', 'foo.js']);
    await git(repoPath, ['commit', '-q', '-m', 'add foo']);
    const head = (await git(repoPath, ['rev-parse', 'HEAD'])).stdout.trim();
    const repo = await registerRepo(baseUrl, repoPath);

    const res = await fetch(
      `${baseUrl}/api/lines?repo=${repo.id}&ref=${head}&path=foo.js&start=-50&end=999999`,
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.start, 1);
    assert.equal(body.end, 10);
    assert.equal(body.totalLines, 10);
    assert.equal(body.lines.length, 10);
    assert.equal(body.lines[0].n, 1);
    assert.equal(body.lines[9].n, 10);
  });

  test('WORKING_TREE reads the current on-disk content, not HEAD', async () => {
    const repoPath = await trackedTempRepo('lines-working-tree');
    await writeFile(join(repoPath, 'foo.js'), 'committed\n');
    await git(repoPath, ['add', 'foo.js']);
    await git(repoPath, ['commit', '-q', '-m', 'add foo']);
    await writeFile(join(repoPath, 'foo.js'), 'uncommitted change\n');
    const repo = await registerRepo(baseUrl, repoPath);

    const res = await fetch(
      `${baseUrl}/api/lines?repo=${repo.id}&ref=WORKING_TREE&path=foo.js&start=1&end=1`,
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.lines, [{ n: 1, text: 'uncommitted change' }]);
  });

  test('a file that does not exist at the given ref returns 404 with a readable message', async () => {
    const repoPath = await trackedTempRepo('lines-missing-file');
    const repo = await registerRepo(baseUrl, repoPath);

    const res = await fetch(
      `${baseUrl}/api/lines?repo=${repo.id}&ref=HEAD&path=nope.js&start=1&end=10`,
    );
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.match(body.error, /nope\.js/);
  });

  test('a range over 2000 lines (after clamping) is rejected with 400', async () => {
    const repoPath = await trackedTempRepo('lines-too-many');
    const content = Array.from({ length: 3000 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
    await writeFile(join(repoPath, 'big.js'), content);
    await git(repoPath, ['add', 'big.js']);
    await git(repoPath, ['commit', '-q', '-m', 'add big']);
    const head = (await git(repoPath, ['rev-parse', 'HEAD'])).stdout.trim();
    const repo = await registerRepo(baseUrl, repoPath);

    const res = await fetch(
      `${baseUrl}/api/lines?repo=${repo.id}&ref=${head}&path=big.js&start=1&end=2001`,
    );
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /2000/);
  });

  test('exactly 2000 lines is accepted (boundary)', async () => {
    const repoPath = await trackedTempRepo('lines-boundary');
    const content = Array.from({ length: 3000 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
    await writeFile(join(repoPath, 'big.js'), content);
    await git(repoPath, ['add', 'big.js']);
    await git(repoPath, ['commit', '-q', '-m', 'add big']);
    const head = (await git(repoPath, ['rev-parse', 'HEAD'])).stdout.trim();
    const repo = await registerRepo(baseUrl, repoPath);

    const res = await fetch(
      `${baseUrl}/api/lines?repo=${repo.id}&ref=${head}&path=big.js&start=1&end=2000`,
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.lines.length, 2000);
  });

  test('a range that clamps down to 2000 or fewer lines is accepted even though the raw end is huge', async () => {
    // The front end expands toward the end of the file by sending an
    // intentionally huge `end` and relying on clamping -- that must not be
    // confused with actually asking for a huge range.
    const repoPath = await trackedTempRepo('lines-clamped-under-cap');
    const content = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
    await writeFile(join(repoPath, 'small.js'), content);
    await git(repoPath, ['add', 'small.js']);
    await git(repoPath, ['commit', '-q', '-m', 'add small']);
    const head = (await git(repoPath, ['rev-parse', 'HEAD'])).stdout.trim();
    const repo = await registerRepo(baseUrl, repoPath);

    const res = await fetch(
      `${baseUrl}/api/lines?repo=${repo.id}&ref=${head}&path=small.js&start=1&end=999999`,
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.totalLines, 50);
    assert.equal(body.lines.length, 50);
  });

  test('nested path within the repo resolves correctly', async () => {
    const repoPath = await trackedTempRepo('lines-nested');
    await mkdir(join(repoPath, 'src', 'lib'), { recursive: true });
    await writeFile(join(repoPath, 'src', 'lib', 'util.js'), 'export const x = 1;\n');
    await git(repoPath, ['add', '.']);
    await git(repoPath, ['commit', '-q', '-m', 'add nested file']);
    const head = (await git(repoPath, ['rev-parse', 'HEAD'])).stdout.trim();
    const repo = await registerRepo(baseUrl, repoPath);

    const res = await fetch(
      `${baseUrl}/api/lines?repo=${repo.id}&ref=${head}&path=src/lib/util.js&start=1&end=1`,
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.lines, [{ n: 1, text: 'export const x = 1;' }]);
  });

  test('missing path returns 400', async () => {
    const repoPath = await trackedTempRepo('lines-missing-path');
    const repo = await registerRepo(baseUrl, repoPath);
    const res = await fetch(`${baseUrl}/api/lines?repo=${repo.id}&ref=HEAD&start=1&end=1`);
    assert.equal(res.status, 400);
  });

  test('missing start/end returns 400', async () => {
    const repoPath = await trackedTempRepo('lines-missing-range');
    const repo = await registerRepo(baseUrl, repoPath);
    const res = await fetch(`${baseUrl}/api/lines?repo=${repo.id}&ref=HEAD&path=foo.js`);
    assert.equal(res.status, 400);
  });

  test('non-integer start/end returns 400', async () => {
    const repoPath = await trackedTempRepo('lines-nan-range');
    const repo = await registerRepo(baseUrl, repoPath);
    const res = await fetch(
      `${baseUrl}/api/lines?repo=${repo.id}&ref=HEAD&path=foo.js&start=abc&end=10`,
    );
    assert.equal(res.status, 400);
  });

  test('reversed range (end before start) returns 400', async () => {
    const repoPath = await trackedTempRepo('lines-reversed-range');
    const repo = await registerRepo(baseUrl, repoPath);
    const res = await fetch(
      `${baseUrl}/api/lines?repo=${repo.id}&ref=HEAD&path=foo.js&start=10&end=5`,
    );
    assert.equal(res.status, 400);
  });

  test('unknown repo id returns 404', async () => {
    const res = await fetch(`${baseUrl}/api/lines?repo=no-such-id&ref=HEAD&path=foo.js&start=1&end=1`);
    assert.equal(res.status, 404);
  });

  test('ref starting with a dash is rejected via the shared requireRef validation', async () => {
    const repoPath = await trackedTempRepo('lines-ref-dash');
    const repo = await registerRepo(baseUrl, repoPath);
    const res = await fetch(
      `${baseUrl}/api/lines?repo=${repo.id}&ref=${encodeURIComponent('--output=/tmp/x')}&path=foo.js&start=1&end=1`,
    );
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /ref must not start with '-'/);
  });

  test('ref containing a colon or whitespace is rejected via the shared requireRef validation', async () => {
    const repoPath = await trackedTempRepo('lines-ref-colon');
    const repo = await registerRepo(baseUrl, repoPath);
    for (const bad of ['HEAD:../../etc/passwd', 'HEAD foo']) {
      const res = await fetch(
        `${baseUrl}/api/lines?repo=${repo.id}&ref=${encodeURIComponent(bad)}&path=foo.js&start=1&end=1`,
      );
      assert.equal(res.status, 400, `expected 400 for ref=${JSON.stringify(bad)}`);
      const body = await res.json();
      assert.match(body.error, /must not contain whitespace, control characters, or ':'/);
    }
  });

  test('a foreign Origin is rejected the same as every other /api/ route', async () => {
    const repoPath = await trackedTempRepo('lines-cross-origin');
    const repo = await registerRepo(baseUrl, repoPath);
    const res = await fetch(
      `${baseUrl}/api/lines?repo=${repo.id}&ref=HEAD&path=foo.js&start=1&end=1`,
      { headers: { Origin: 'http://evil.example' } },
    );
    assert.equal(res.status, 403);
  });

  // -------------------------------------------------------------------------
  // path containment (Critical) — this project has already shipped one
  // argument-injection bug of this exact shape via a query-string parameter
  // reaching git with no validation. `path` gets the same suspicion: every
  // vector below must be rejected with an exact status and must not leak
  // any file content, not merely "not 200".
  //
  // Unlike the static-file traversal tests above, `path` here travels as a
  // *query string value*, not a URL path segment -- the WHATWG URL spec's
  // dot-segment normalisation only applies to the path component, so
  // `fetch` does NOT rewrite `..` inside a query value before it leaves the
  // client. A plain `fetch` genuinely exercises the server's own
  // containment check. The raw-socket variant is kept too, as an
  // independent confirmation that nothing between here and the socket
  // (undici, the URL parser) is quietly doing that normalisation for us.
  // -------------------------------------------------------------------------

  describe('path containment (Critical)', () => {
    let repoPath;
    let repo;
    let secretPath;

    beforeEach(async () => {
      repoPath = await trackedTempRepo('lines-traversal');
      await writeFile(join(repoPath, 'foo.js'), 'safe content\n');
      await git(repoPath, ['add', 'foo.js']);
      await git(repoPath, ['commit', '-q', '-m', 'add foo']);
      repo = await registerRepo(baseUrl, repoPath);

      // A file just outside the repo root, with a unique marker string, so a
      // successful escape is unambiguous (not just "some file leaked" but
      // "this exact secret leaked").
      secretPath = join(tmpdir(), `lcr-lines-secret-${process.pid}-${Date.now()}.txt`);
      await writeFile(secretPath, 'TOP-SECRET-MARKER-DO-NOT-LEAK\n');
      cleanupDirs.push(secretPath);
    });

    afterEach(async () => {
      await rm(secretPath, { force: true });
    });

    test('relative ../ escape is rejected with 400 and leaks no content', async () => {
      const res = await fetch(
        `${baseUrl}/api/lines?repo=${repo.id}&ref=HEAD&path=` +
          encodeURIComponent('../../../../etc/passwd') +
          '&start=1&end=1',
      );
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.doesNotMatch(body.error ?? '', /root:/);
      assert.doesNotMatch(JSON.stringify(body), /root:/);
    });

    test('absolute path is rejected with 400 and leaks no content', async () => {
      const res = await fetch(
        `${baseUrl}/api/lines?repo=${repo.id}&ref=HEAD&path=` +
          encodeURIComponent('/etc/passwd') +
          '&start=1&end=1',
      );
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.doesNotMatch(JSON.stringify(body), /root:/);
    });

    test('a path that only escapes after normalisation is rejected with 400', async () => {
      // Lexically starts inside the repo ("foo.js/...") but normalises to
      // something well outside it. Enough `../` segments to clear any
      // plausible tmpdir nesting depth on any OS.
      const res = await fetch(
        `${baseUrl}/api/lines?repo=${repo.id}&ref=HEAD&path=` +
          encodeURIComponent('foo.js/../../../../../../../../../../../../etc/passwd') +
          '&start=1&end=1',
      );
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.doesNotMatch(JSON.stringify(body), /root:/);
    });

    test('percent-encoded ../ (..%2f) is rejected with 400 and leaks no content', async () => {
      const res = await fetch(
        `${baseUrl}/api/lines?repo=${repo.id}&ref=HEAD&path=` +
          '..%2f..%2f..%2f..%2fetc%2fpasswd' +
          '&start=1&end=1',
      );
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.doesNotMatch(JSON.stringify(body), /root:/);
    });

    test('escape to a real file just outside the repo root leaks no content (raw socket)', async () => {
      // Drives the request over a raw TCP socket so there is no question of
      // any client-side library normalising the query string -- the server
      // sees exactly this byte sequence on the wire.
      const target =
        `/api/lines?repo=${repo.id}&ref=HEAD&path=` +
        encodeURIComponent(`../${secretPath.slice(tmpdir().length + 1)}`) +
        '&start=1&end=1';
      const res = await rawRequest(target);
      assert.equal(res.status, 400);
      assert.doesNotMatch(res.raw, /TOP-SECRET-MARKER-DO-NOT-LEAK/);
    });

    test('escaping the repo root itself (path=..) is rejected with 400', async () => {
      const res = await fetch(
        `${baseUrl}/api/lines?repo=${repo.id}&ref=HEAD&path=..&start=1&end=1`,
      );
      assert.equal(res.status, 400);
    });

    test('the repo root itself (path=.) is rejected with 400, not treated as a readable file', async () => {
      const res = await fetch(
        `${baseUrl}/api/lines?repo=${repo.id}&ref=HEAD&path=.&start=1&end=1`,
      );
      assert.equal(res.status, 400);
    });

    test('a legitimate path in the same repo still works (control case)', async () => {
      const res = await fetch(
        `${baseUrl}/api/lines?repo=${repo.id}&ref=HEAD&path=foo.js&start=1&end=1`,
      );
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.deepEqual(body.lines, [{ n: 1, text: 'safe content' }]);
    });
  });

  // -------------------------------------------------------------------------
  // path containment via WORKING_TREE (Critical) -- every vector above uses
  // ref=HEAD, where `git show <ref>:<path>` refuses to resolve outside the
  // repository on its own ("is outside repository"). That backstop is a git
  // behaviour, not something this code checks, and it does not exist for
  // WORKING_TREE: that branch reads straight off disk via readFile, which
  // has no equivalent protection. Re-running the same vectors here (with
  // ref=WORKING_TREE) is what actually exercises this server's own
  // containment check for the one mode that has no other backstop -- plus a
  // symlink test, since a lexically-contained path that is itself a symlink
  // pointing outside the repo is a vector the lexical check cannot catch at
  // all (WORKING_TREE-only: git show returns a symlink's target string, not
  // its followed content).
  // -------------------------------------------------------------------------

  describe('path containment via WORKING_TREE (Critical)', () => {
    let repoPath;
    let repo;
    let secretPath;

    beforeEach(async () => {
      repoPath = await trackedTempRepo('lines-wt-traversal');
      await writeFile(join(repoPath, 'foo.js'), 'safe content\n');
      await git(repoPath, ['add', 'foo.js']);
      await git(repoPath, ['commit', '-q', '-m', 'add foo']);
      repo = await registerRepo(baseUrl, repoPath);

      secretPath = join(tmpdir(), `lcr-lines-wt-secret-${process.pid}-${Date.now()}.txt`);
      await writeFile(secretPath, 'TOP-SECRET-MARKER-DO-NOT-LEAK\n');
      cleanupDirs.push(secretPath);
    });

    afterEach(async () => {
      await rm(secretPath, { force: true });
    });

    test('relative ../ escape is rejected with 400 and leaks no content', async () => {
      const res = await fetch(
        `${baseUrl}/api/lines?repo=${repo.id}&ref=WORKING_TREE&path=` +
          encodeURIComponent('../../../../etc/passwd') +
          '&start=1&end=1',
      );
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.doesNotMatch(body.error ?? '', /root:/);
      assert.doesNotMatch(JSON.stringify(body), /root:/);
    });

    test('absolute path is rejected with 400 and leaks no content', async () => {
      const res = await fetch(
        `${baseUrl}/api/lines?repo=${repo.id}&ref=WORKING_TREE&path=` +
          encodeURIComponent('/etc/passwd') +
          '&start=1&end=1',
      );
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.doesNotMatch(JSON.stringify(body), /root:/);
    });

    test('a path that only escapes after normalisation is rejected with 400', async () => {
      const res = await fetch(
        `${baseUrl}/api/lines?repo=${repo.id}&ref=WORKING_TREE&path=` +
          encodeURIComponent('foo.js/../../../../../../../../../../../../etc/passwd') +
          '&start=1&end=1',
      );
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.doesNotMatch(JSON.stringify(body), /root:/);
    });

    test('percent-encoded ../ (..%2f) is rejected with 400 and leaks no content', async () => {
      const res = await fetch(
        `${baseUrl}/api/lines?repo=${repo.id}&ref=WORKING_TREE&path=` +
          '..%2f..%2f..%2f..%2fetc%2fpasswd' +
          '&start=1&end=1',
      );
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.doesNotMatch(JSON.stringify(body), /root:/);
    });

    test('escape to a real file just outside the repo root leaks no content (raw socket)', async () => {
      const target =
        `/api/lines?repo=${repo.id}&ref=WORKING_TREE&path=` +
        encodeURIComponent(`../${secretPath.slice(tmpdir().length + 1)}`) +
        '&start=1&end=1';
      const res = await rawRequest(target);
      assert.equal(res.status, 400);
      assert.doesNotMatch(res.raw, /TOP-SECRET-MARKER-DO-NOT-LEAK/);
    });

    test('escaping the repo root itself (path=..) is rejected with 400', async () => {
      const res = await fetch(
        `${baseUrl}/api/lines?repo=${repo.id}&ref=WORKING_TREE&path=..&start=1&end=1`,
      );
      assert.equal(res.status, 400);
    });

    test('the repo root itself (path=.) is rejected with 400, not treated as a readable file', async () => {
      const res = await fetch(
        `${baseUrl}/api/lines?repo=${repo.id}&ref=WORKING_TREE&path=.&start=1&end=1`,
      );
      assert.equal(res.status, 400);
    });

    test('a symlink inside the repo pointing outside it is rejected with 400 and leaks no content', async () => {
      await symlink(secretPath, join(repoPath, 'leak.txt'));

      const res = await fetch(
        `${baseUrl}/api/lines?repo=${repo.id}&ref=WORKING_TREE&path=leak.txt&start=1&end=1`,
      );
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.doesNotMatch(JSON.stringify(body), /TOP-SECRET-MARKER-DO-NOT-LEAK/);
    });

    test('a symlink inside the repo pointing at another file inside the repo still works (control case)', async () => {
      await symlink(join(repoPath, 'foo.js'), join(repoPath, 'alias.js'));

      const res = await fetch(
        `${baseUrl}/api/lines?repo=${repo.id}&ref=WORKING_TREE&path=alias.js&start=1&end=1`,
      );
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.deepEqual(body.lines, [{ n: 1, text: 'safe content' }]);
    });

    test('a legitimate path in the same repo still works (control case)', async () => {
      const res = await fetch(
        `${baseUrl}/api/lines?repo=${repo.id}&ref=WORKING_TREE&path=foo.js&start=1&end=1`,
      );
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.deepEqual(body.lines, [{ n: 1, text: 'safe content' }]);
    });
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

// ---------------------------------------------------------------------------
// Argument injection via ref parameters (Critical)
//
// `base` and `target` are interpolated into a git command line. A value that
// starts with `-` used to be parsed by git as an *option*, so
// `base=--output=/tmp/x` made git write an arbitrary file. Refs must be
// rejected at the edge, and git must never be able to read one as an option.
// ---------------------------------------------------------------------------

describe('ref argument injection', () => {
  test('base=--output=... is rejected with 400 and writes no file', async () => {
    const repoPath = await trackedTempRepo('inject-output');
    const repo = await registerRepo(baseUrl, repoPath);
    const probe = join(tmpdir(), `lcr-PWNED-${process.pid}-${Date.now()}.txt`);

    const res = await fetch(
      `${baseUrl}/api/diff?repo=${repo.id}&base=${encodeURIComponent(`--output=${probe}`)}`,
    );
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /base/);
    assert.equal(await fileExists(probe), false, `git wrote ${probe} -- injection still works`);
  });

  test('the same injection through /api/export is rejected with 400', async () => {
    const repoPath = await trackedTempRepo('inject-export');
    const repo = await registerRepo(baseUrl, repoPath);
    const probe = join(tmpdir(), `lcr-PWNED-export-${process.pid}-${Date.now()}.txt`);

    const res = await fetch(
      `${baseUrl}/api/export?repo=${repo.id}` +
        `&base=${encodeURIComponent(`--output=${probe}`)}&format=markdown`,
    );
    assert.equal(res.status, 400);
    assert.equal(await fileExists(probe), false);
  });

  test('target starting with a dash is rejected with 400', async () => {
    const repoPath = await trackedTempRepo('inject-target');
    const repo = await registerRepo(baseUrl, repoPath);
    // Deliberately no "target" in the probe filename: a message-match against
    // /target/ must succeed because the validator actually named the field,
    // not because the probe's own name happened to contain the word.
    const probe = join(tmpdir(), `lcr-PWNED-dash-${process.pid}-${Date.now()}.txt`);

    const res = await fetch(
      `${baseUrl}/api/diff?repo=${repo.id}&base=HEAD` +
        `&target=${encodeURIComponent(`--output=${probe}`)}`,
    );
    assert.equal(res.status, 400);
    const body = await res.json();
    // Must be the requireRef validation message specifically. Pre-fix, base
    // and target were concatenated into a single `HEAD...--output=...` argv
    // element before ever reaching git, so git parsed it as one (invalid)
    // revision rather than as an option, and failed with its own "ambiguous
    // argument" / "bad revision" error -- which also 400'd, but for the wrong
    // reason and with no mention of "target must not start with '-'".
    assert.match(body.error, /target must not start with '-'/);
    assert.equal(await fileExists(probe), false);
  });

  test('refs containing a colon or whitespace are rejected with 400', async () => {
    const repoPath = await trackedTempRepo('inject-colon');
    const repo = await registerRepo(baseUrl, repoPath);

    for (const bad of ['HEAD:../../etc/passwd', 'HEAD foo', 'HEAD\nfoo']) {
      const res = await fetch(`${baseUrl}/api/diff?repo=${repo.id}&base=${encodeURIComponent(bad)}`);
      assert.equal(res.status, 400, `expected 400 for base=${JSON.stringify(bad)}`);
      const body = await res.json();
      // Pre-fix, `base` only ran through requireString (non-empty check), so
      // these already 400'd -- from git's own "bad revision" error after the
      // malformed ref reached the command line, not from our validation. A
      // bare status check can't tell those apart; require the actual
      // requireRef message.
      assert.match(
        body.error,
        /must not contain whitespace, control characters, or ':'/,
        `expected requireRef's message for base=${JSON.stringify(bad)}, got: ${body.error}`,
      );
    }
  });

  test('legitimate ref shapes are still accepted', async () => {
    const repoPath = await trackedTempRepo('ref-shapes');
    await writeFile(join(repoPath, 'foo.js'), 'let x = 1;\n');
    await git(repoPath, ['add', 'foo.js']);
    await git(repoPath, ['commit', '-q', '-m', 'add foo']);
    await git(repoPath, ['branch', 'feat/some-thing.v2']);
    await git(repoPath, ['tag', 'v1.2.3-rc.1']);
    await writeFile(join(repoPath, 'foo.js'), 'let x = 2;\n');

    const repo = await registerRepo(baseUrl, repoPath);

    // Slashes, dots, non-leading dashes, and `HEAD~N` expressions must all
    // survive validation (they may still 400 from git itself, but not from us).
    for (const ref of ['HEAD', 'feat/some-thing.v2', 'v1.2.3-rc.1', 'HEAD~0', 'HEAD^']) {
      const res = await fetch(
        `${baseUrl}/api/diff?repo=${repo.id}&base=${encodeURIComponent(ref)}`,
      );
      assert.equal(res.status, 200, `ref ${ref} should have been accepted`);
    }
  });

  test('WORKING_TREE remains a valid target sentinel', async () => {
    const repoPath = await trackedTempRepo('ref-sentinel');
    await writeFile(join(repoPath, 'foo.js'), 'let x = 1;\n');
    await git(repoPath, ['add', 'foo.js']);
    await git(repoPath, ['commit', '-q', '-m', 'add foo']);
    await writeFile(join(repoPath, 'foo.js'), 'let x = 2;\n');

    const repo = await registerRepo(baseUrl, repoPath);
    const res = await fetch(`${baseUrl}/api/diff?repo=${repo.id}&base=HEAD&target=WORKING_TREE`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.files.length, 1);
  });
});

// ---------------------------------------------------------------------------
// Cross-origin defence (Critical)
// ---------------------------------------------------------------------------

describe('cross-origin requests', () => {
  test('GET /api/diff with a foreign Origin is rejected', async () => {
    const repoPath = await trackedTempRepo('xorigin-get');
    const repo = await registerRepo(baseUrl, repoPath);

    const res = await fetch(`${baseUrl}/api/diff?repo=${repo.id}&base=HEAD`, {
      headers: { Origin: 'http://evil.example' },
    });
    assert.equal(res.status, 403);
  });

  test('GET /api/repos with Sec-Fetch-Site: cross-site is rejected', async () => {
    const res = await fetch(`${baseUrl}/api/repos`, {
      headers: { 'Sec-Fetch-Site': 'cross-site' },
    });
    assert.equal(res.status, 403);
  });

  test('Sec-Fetch-Site: same-site (different port, same host) is rejected', async () => {
    const res = await fetch(`${baseUrl}/api/repos`, {
      headers: { 'Sec-Fetch-Site': 'same-site' },
    });
    assert.equal(res.status, 403);
  });

  test('an opaque Origin of "null" is rejected', async () => {
    const res = await fetch(`${baseUrl}/api/repos`, { headers: { Origin: 'null' } });
    assert.equal(res.status, 403);
  });

  test('POST /api/repos from a foreign Origin is rejected', async () => {
    const repoPath = await trackedTempRepo('xorigin-post');
    const res = await fetch(`${baseUrl}/api/repos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'http://evil.example' },
      body: JSON.stringify({ path: repoPath }),
    });
    assert.equal(res.status, 403);
  });

  // The tool's own front end lives on the same origin it talks to, so these
  // are exactly the header combinations it produces and they must pass.
  test("the front end's own same-origin GET is allowed", async () => {
    const res = await rawRequest('/api/repos', {
      headers: { 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'cors' },
    });
    assert.equal(res.status, 200);
  });

  test("the front end's own same-origin POST (Origin matching Host) is allowed", async () => {
    const { port } = server.address();
    const repoPath = await trackedTempRepo('xorigin-same');
    const res = await fetch(`${baseUrl}/api/repos`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: `http://127.0.0.1:${port}`,
        'Sec-Fetch-Site': 'same-origin',
      },
      body: JSON.stringify({ path: repoPath }),
    });
    assert.equal(res.status, 200);
  });

  test('direct navigation (Sec-Fetch-Site: none) is allowed', async () => {
    const res = await rawRequest('/api/repos', { headers: { 'Sec-Fetch-Site': 'none' } });
    assert.equal(res.status, 200);
  });

  test('a cross-origin form post cannot reach the body parser (non-JSON Content-Type)', async () => {
    const repoPath = await trackedTempRepo('xorigin-form');
    const res = await fetch(`${baseUrl}/api/repos`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ path: repoPath }),
    });
    assert.equal(res.status, 415);

    // And nothing was registered as a side effect.
    const list = await (await fetch(`${baseUrl}/api/repos`)).json();
    assert.deepEqual(list.repos, []);
  });

  test('form-urlencoded bodies are rejected too', async () => {
    const res = await fetch(`${baseUrl}/api/repos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'path=/tmp',
    });
    assert.equal(res.status, 415);
  });
});

// ---------------------------------------------------------------------------
// Malformed input handling (I2, I3, M4)
// ---------------------------------------------------------------------------

describe('malformed request handling', () => {
  test('malformed percent-encoding in the path returns 400, not 500', async () => {
    const res = await rawRequest('/%zz');
    assert.equal(res.status, 400);

    const followUp = await fetch(`${baseUrl}/api/repos`);
    assert.equal(followUp.status, 200);
  });

  test('malformed percent-encoding under /api/ returns 400, not 500', async () => {
    const res = await rawRequest('/api/%e0%a4%a');
    assert.equal(res.status, 400);
  });

  test('a JSON body of literal null returns 400 on every body endpoint', async () => {
    const endpoints = ['/api/repos', '/api/check', '/api/comment', '/api/note', '/api/orphan/discard'];
    for (const endpoint of endpoints) {
      const res = await fetch(`${baseUrl}${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'null',
      });
      assert.equal(res.status, 400, `${endpoint} should 400 on a null body`);
      const body = await res.json();
      assert.ok(body.error);
    }

    const followUp = await fetch(`${baseUrl}/api/repos`);
    assert.equal(followUp.status, 200);
  });

  test('non-object JSON bodies (array, string, number) return 400', async () => {
    for (const raw of ['[]', '"hello"', '42', 'true']) {
      const res = await fetch(`${baseUrl}/api/repos`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: raw,
      });
      assert.equal(res.status, 400, `body ${raw} should 400`);
      const body = await res.json();
      // Pre-fix, readJsonBody had no object check at all: `[].path`,
      // `"hello".path` and `42..path`/`true.path` are all `undefined`, so the
      // request still 400'd -- from requireString rejecting a missing
      // `path`, not from readJsonBody rejecting the body shape. Assert on
      // the actual message so this test can't pass for that unrelated
      // reason.
      assert.match(
        body.error,
        /request body must be a JSON object/,
        `body ${raw} should fail with the JSON-object-shape message, got: ${body.error}`,
      );
    }
  });

  test('an oversized request body is rejected rather than buffered', async () => {
    const huge = JSON.stringify({ path: 'x'.repeat(5 * 1024 * 1024) });
    const res = await fetch(`${baseUrl}/api/repos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: huge,
    });
    // Exactly 413 -- before the cap existed this request was fully buffered
    // and then 400'd by addRepo for an unrelated reason, so a loose
    // "400 or 413" assertion would have passed against the unfixed server.
    assert.equal(res.status, 413);

    const followUp = await fetch(`${baseUrl}/api/repos`);
    assert.equal(followUp.status, 200);
  });

  test('a body just under the cap is still accepted', async () => {
    const repoPath = await trackedTempRepo('body-under-cap');
    const res = await fetch(`${baseUrl}/api/repos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: repoPath, filler: 'x'.repeat(1000) }),
    });
    assert.equal(res.status, 200);
  });
});

// ---------------------------------------------------------------------------
// The amend / line-shift invariant, end to end through the server.
//
// This is the whole justification for keying change points by content hash
// rather than by line number: rewriting the tip commit so that every line
// number moves must NOT lose the reviewer's checkmarks.
// ---------------------------------------------------------------------------

describe('amend / line-shift invariant', () => {
  test('amending the tip so every line shifts keeps change point ids and checkmarks', async () => {
    const repoPath = await trackedTempRepo('amend-invariant');

    const prelude = Array.from({ length: 20 }, (_, i) => `// header ${i + 1}`).join('\n');
    const fooV1 = `${prelude}\n\nfunction foo() {\n  return 1;\n}\n`;
    const fooV2 = `${prelude}\n\nfunction foo() {\n  return 2;\n}\n`;

    await writeFile(join(repoPath, 'foo.js'), fooV1);
    await git(repoPath, ['add', 'foo.js']);
    await git(repoPath, ['commit', '-q', '-m', 'add foo']);
    const base = (await git(repoPath, ['rev-parse', 'HEAD'])).stdout.trim();

    await writeFile(join(repoPath, 'foo.js'), fooV2);
    await git(repoPath, ['add', 'foo.js']);
    await git(repoPath, ['commit', '-q', '-m', 'change foo']);
    const target = (await git(repoPath, ['rev-parse', 'HEAD'])).stdout.trim();

    const repo = await registerRepo(baseUrl, repoPath);

    const before = await (
      await fetch(`${baseUrl}/api/diff?repo=${repo.id}&base=${base}&target=${target}`)
    ).json();

    const fooFile = before.files.find((f) => f.path === 'foo.js');
    assert.ok(fooFile, 'expected foo.js in the diff');
    const changePoint = fooFile.groups[0].changePoints[0];
    const originalId = changePoint.id;
    const originalLine = changePoint.newLine ?? changePoint.startLine ?? null;
    assert.equal(changePoint.checked, false);

    // Check it, and leave a comment so both kinds of state are exercised.
    const checkRes = await fetch(`${baseUrl}/api/check`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repo: repo.id, key: originalId, checked: true }),
    });
    assert.equal(checkRes.status, 200);

    // Amend the tip commit, prepending 10 lines so every line number below
    // moves. The *content* of foo's change is untouched.
    const shifted = Array.from({ length: 10 }, (_, i) => `// shifted ${i + 1}`).join('\n');
    await writeFile(join(repoPath, 'foo.js'), `${shifted}\n${fooV2}`);
    await git(repoPath, ['add', 'foo.js']);
    await git(repoPath, ['commit', '-q', '--amend', '--no-edit']);
    const amendedTarget = (await git(repoPath, ['rev-parse', 'HEAD'])).stdout.trim();
    assert.notEqual(amendedTarget, target, 'amend should have produced a new commit sha');

    const after = await (
      await fetch(`${baseUrl}/api/diff?repo=${repo.id}&base=${base}&target=${amendedTarget}`)
    ).json();

    const fooAfter = after.files.find((f) => f.path === 'foo.js');
    assert.ok(fooAfter, 'expected foo.js in the post-amend diff');

    const allPoints = fooAfter.groups.flatMap((g) => g.changePoints);
    const survivor = allPoints.find((p) => p.id === originalId);
    assert.ok(
      survivor,
      `change point ${originalId} disappeared after the amend; ` +
        `ids present: ${allPoints.map((p) => p.id).join(', ')}`,
    );
    assert.equal(survivor.checked, true, 'the checkmark must survive the line shift');
    assert.equal(after.stats.checked, 1);
    assert.deepEqual(after.orphans, [], 'nothing should have been orphaned');

    // Sanity: the line numbers really did move, so this test would have failed
    // under a line-number-keyed design.
    const newLine = survivor.newLine ?? survivor.startLine ?? null;
    if (originalLine !== null && newLine !== null) {
      assert.notEqual(newLine, originalLine, 'expected the change point to have shifted lines');
    }
  });
});
