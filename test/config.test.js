import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readFile, readdir, stat } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join, resolve, relative } from 'node:path';

import {
  baseDir,
  configPath,
  stateDir,
  statePath,
  repoId,
  listRepos,
  addRepo,
  removeRepo,
  getRepo,
} from '../config.js';

const ORIGINAL_LCR_HOME = process.env.LCR_HOME;

let lcrHome;

beforeEach(async () => {
  lcrHome = await mkdtemp(join(tmpdir(), 'local-code-review-config-test-'));
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

async function makeFakeGitRepo(label = 'repo') {
  const dir = await mkdtemp(join(tmpdir(), `local-code-review-repo-${label}-`));
  await mkdir(join(dir, '.git'));
  return dir;
}

// ---------------------------------------------------------------------------
// path construction
// ---------------------------------------------------------------------------

describe('baseDir / configPath / stateDir / statePath', () => {
  test('baseDir returns $LCR_HOME when set', () => {
    assert.equal(baseDir(), lcrHome);
  });

  test('baseDir falls back to ~/.local-code-review when LCR_HOME unset', () => {
    delete process.env.LCR_HOME;
    assert.equal(baseDir(), join(homedir(), '.local-code-review'));
    process.env.LCR_HOME = lcrHome;
  });

  test('baseDir is resolved per call, not cached at module load', () => {
    const first = baseDir();
    const otherDir = join(tmpdir(), 'some-other-lcr-home');
    process.env.LCR_HOME = otherDir;
    const second = baseDir();
    assert.equal(first, lcrHome);
    assert.equal(second, otherDir);
    process.env.LCR_HOME = lcrHome;
  });

  test('configPath is $LCR_HOME/config.json', () => {
    assert.equal(configPath(), join(lcrHome, 'config.json'));
  });

  test('stateDir is $LCR_HOME/state', () => {
    assert.equal(stateDir(), join(lcrHome, 'state'));
  });

  test('statePath is $LCR_HOME/state/<repoId>.json', () => {
    assert.equal(statePath('abc123'), join(lcrHome, 'state', 'abc123.json'));
  });
});

// ---------------------------------------------------------------------------
// repoId
// ---------------------------------------------------------------------------

describe('repoId', () => {
  test('same absolute path always yields the same id', () => {
    const id1 = repoId('/Users/dev/projects/foo');
    const id2 = repoId('/Users/dev/projects/foo');
    assert.equal(id1, id2);
  });

  test('different paths do not collide', () => {
    const id1 = repoId('/Users/dev/projects/foo');
    const id2 = repoId('/Users/dev/projects/bar');
    assert.notEqual(id1, id2);
  });

  test('paths with the same basename but different parents do not collide', () => {
    const id1 = repoId('/Users/dev/one/app');
    const id2 = repoId('/Users/dev/two/app');
    assert.notEqual(id1, id2);
  });

  test('trailing slash does not change the id', () => {
    const id1 = repoId('/Users/dev/projects/foo');
    const id2 = repoId('/Users/dev/projects/foo/');
    assert.equal(id1, id2);
  });

  test('relative and absolute paths normalize to the same id', () => {
    const absolute = resolve(process.cwd(), 'some-repo-dir');
    const rel = relative(process.cwd(), absolute);
    assert.equal(repoId(rel), repoId(absolute));
  });

  test('id only contains [a-z0-9-]', () => {
    const id = repoId('/Users/Dev/My Projects/Foo_Bar 123!');
    assert.match(id, /^[a-z0-9-]+$/);
  });
});

// ---------------------------------------------------------------------------
// listRepos
// ---------------------------------------------------------------------------

describe('listRepos', () => {
  test('returns [] and creates baseDir/state without writing config.json', async () => {
    const repos = await listRepos();
    assert.deepEqual(repos, []);

    const baseStat = await stat(baseDir());
    assert.ok(baseStat.isDirectory());
    const stateStat = await stat(stateDir());
    assert.ok(stateStat.isDirectory());

    await assert.rejects(() => readFile(configPath()));
  });

  test('treats corrupt config.json as empty list without crashing, and backs it up', async () => {
    await mkdir(baseDir(), { recursive: true });
    await writeFile(configPath(), '{ this is not valid json');

    const repos = await listRepos();
    assert.deepEqual(repos, []);

    const entries = await readdir(baseDir());
    const backup = entries.find((f) => /^config\.json\.corrupt-\d+$/.test(f));
    assert.ok(backup, `expected a corrupt-* backup file, got: ${entries.join(', ')}`);
  });

  test('treats config.json with unexpected structure as empty list, and backs it up', async () => {
    await mkdir(baseDir(), { recursive: true });
    await writeFile(configPath(), JSON.stringify({ notRepos: 'oops' }));

    const repos = await listRepos();
    assert.deepEqual(repos, []);

    const entries = await readdir(baseDir());
    const backup = entries.find((f) => /^config\.json\.corrupt-\d+$/.test(f));
    assert.ok(backup, `expected a corrupt-* backup file, got: ${entries.join(', ')}`);
  });
});

// ---------------------------------------------------------------------------
// addRepo
// ---------------------------------------------------------------------------

describe('addRepo', () => {
  test('adds a valid git repo and returns the Repo shape', async () => {
    const dir = await makeFakeGitRepo('add-basic');
    const repo = await addRepo(dir);

    assert.equal(repo.path, resolve(dir));
    assert.equal(repo.name, dir.split('/').pop());
    assert.equal(repo.id, repoId(dir));
    assert.match(repo.id, /^[a-z0-9-]+$/);

    await rm(dir, { recursive: true, force: true });
  });

  test('adding the same path twice does not duplicate', async () => {
    const dir = await makeFakeGitRepo('add-dup');
    const first = await addRepo(dir);
    const second = await addRepo(dir);

    assert.deepEqual(first, second);
    const repos = await listRepos();
    assert.equal(repos.length, 1);

    await rm(dir, { recursive: true, force: true });
  });

  test('persists the repo to config.json', async () => {
    const dir = await makeFakeGitRepo('add-persist');
    await addRepo(dir);

    const raw = await readFile(configPath(), 'utf8');
    const parsed = JSON.parse(raw);
    assert.equal(parsed.repos.length, 1);
    assert.equal(parsed.repos[0].path, resolve(dir));

    await rm(dir, { recursive: true, force: true });
  });

  test('throws a readable error for a nonexistent path', async () => {
    const missing = join(tmpdir(), 'local-code-review-does-not-exist-xyz');
    await assert.rejects(() => addRepo(missing), /does not exist|no such/i);
  });

  test('throws a readable error for a directory that is not a git repo', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'local-code-review-not-git-'));
    await assert.rejects(() => addRepo(dir), /git/i);
    await rm(dir, { recursive: true, force: true });
  });

  test('write is atomic: no leftover tmp files after addRepo', async () => {
    const dir = await makeFakeGitRepo('add-atomic');
    await addRepo(dir);

    const entries = await readdir(baseDir());
    const leftovers = entries.filter((f) => f.includes('.tmp'));
    assert.deepEqual(leftovers, []);

    await rm(dir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// removeRepo
// ---------------------------------------------------------------------------

describe('removeRepo', () => {
  test('removes an existing repo and returns true', async () => {
    const dir = await makeFakeGitRepo('remove-existing');
    const repo = await addRepo(dir);

    const result = await removeRepo(repo.id);
    assert.equal(result, true);

    const repos = await listRepos();
    assert.deepEqual(repos, []);

    await rm(dir, { recursive: true, force: true });
  });

  test('returns false for an id that does not exist', async () => {
    const result = await removeRepo('no-such-repo-id');
    assert.equal(result, false);
  });
});

// ---------------------------------------------------------------------------
// concurrency: serialized read-modify-write
// ---------------------------------------------------------------------------

describe('concurrent addRepo / removeRepo', () => {
  test('concurrent addRepo of two different paths yields two entries, not one', async () => {
    const dir1 = await makeFakeGitRepo('concurrent-add-1');
    const dir2 = await makeFakeGitRepo('concurrent-add-2');

    const [r1, r2] = await Promise.all([addRepo(dir1), addRepo(dir2)]);

    assert.equal(r1.path, resolve(dir1));
    assert.equal(r2.path, resolve(dir2));

    const repos = await listRepos();
    assert.equal(repos.length, 2);
    assert.ok(repos.some((r) => r.id === r1.id));
    assert.ok(repos.some((r) => r.id === r2.id));

    await rm(dir1, { recursive: true, force: true });
    await rm(dir2, { recursive: true, force: true });
  });

  test('concurrent addRepo of the same path yields one entry and consistent return values', async () => {
    const dir = await makeFakeGitRepo('concurrent-add-same');

    const [r1, r2] = await Promise.all([addRepo(dir), addRepo(dir)]);

    assert.deepEqual(r1, r2);

    const repos = await listRepos();
    assert.equal(repos.length, 1);

    await rm(dir, { recursive: true, force: true });
  });

  test('many concurrent addRepo calls for distinct paths never lose a write', async () => {
    const dirs = await Promise.all(
      Array.from({ length: 8 }, (_, i) => makeFakeGitRepo(`concurrent-add-many-${i}`))
    );

    await Promise.all(dirs.map((dir) => addRepo(dir)));

    const repos = await listRepos();
    assert.equal(repos.length, dirs.length);

    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
  });

  test('concurrent removeRepo calls do not lose entries', async () => {
    const dir1 = await makeFakeGitRepo('concurrent-remove-1');
    const dir2 = await makeFakeGitRepo('concurrent-remove-2');
    const dir3 = await makeFakeGitRepo('concurrent-remove-3');

    const repo1 = await addRepo(dir1);
    const repo2 = await addRepo(dir2);
    const repo3 = await addRepo(dir3);

    const [removed1, removed2] = await Promise.all([
      removeRepo(repo1.id),
      removeRepo(repo2.id),
    ]);

    assert.equal(removed1, true);
    assert.equal(removed2, true);

    const repos = await listRepos();
    assert.equal(repos.length, 1);
    assert.equal(repos[0].id, repo3.id);

    await rm(dir1, { recursive: true, force: true });
    await rm(dir2, { recursive: true, force: true });
    await rm(dir3, { recursive: true, force: true });
  });

  test('concurrent readers never observe an uncaught rejection on corrupt config.json', async () => {
    await mkdir(baseDir(), { recursive: true });
    await writeFile(configPath(), '{ this is not valid json');

    // Several concurrent reads should all resolve to an empty list, never
    // reject -- even though the underlying recovery does a rename() that
    // cannot succeed twice against the same source file.
    const results = await Promise.all([
      listRepos(),
      listRepos(),
      getRepo('anything'),
      listRepos(),
    ]);

    assert.deepEqual(results[0], []);
    assert.deepEqual(results[1], []);
    assert.equal(results[2], null);
    assert.deepEqual(results[3], []);

    const entries = await readdir(baseDir());
    const backups = entries.filter((f) => /^config\.json\.corrupt-\d+$/.test(f));
    assert.ok(backups.length >= 1, `expected at least one corrupt-* backup file, got: ${entries.join(', ')}`);
  });
});

// ---------------------------------------------------------------------------
// getRepo
// ---------------------------------------------------------------------------

describe('getRepo', () => {
  test('returns the repo matching the id', async () => {
    const dir = await makeFakeGitRepo('get-existing');
    const added = await addRepo(dir);

    const fetched = await getRepo(added.id);
    assert.deepEqual(fetched, added);

    await rm(dir, { recursive: true, force: true });
  });

  test('returns null for an unknown id', async () => {
    const fetched = await getRepo('no-such-repo-id');
    assert.equal(fetched, null);
  });
});
