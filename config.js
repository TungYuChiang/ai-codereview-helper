// config.js — repo list configuration and progress-state path resolution.
//
// Owns:
//   $LCR_HOME/config.json        list of repos this tool serves
//   $LCR_HOME/state/<id>.json    per-repo progress path (contents owned by state.js)
//
// $LCR_HOME defaults to ~/.local-code-review and is resolved from
// process.env.LCR_HOME on every call (never cached), so tests can point it at
// a temp directory without polluting the real home directory.

import { mkdir, readFile, writeFile, rename, stat, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve, basename } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { createMutex } from './lock.js';

// Serializes every read-modify-write against config.json so that concurrent
// callers (e.g. two addRepo() calls from a double-click, or two open tabs)
// can never both read the pre-mutation config and have the second write
// silently clobber the first. Also serializes the corrupt-config recovery
// path (rename + rebuild) so two concurrent readers can't race each other.
const configLock = createMutex();

export function baseDir() {
  return process.env.LCR_HOME || join(homedir(), '.local-code-review');
}

export function configPath() {
  return join(baseDir(), 'config.json');
}

export function stateDir() {
  return join(baseDir(), 'state');
}

export function statePath(repoId) {
  return join(stateDir(), `${repoId}.json`);
}

export function repoId(repoPath) {
  const normalized = normalizePath(repoPath);
  // Hash the full normalized path so two different paths never collide, even
  // if they share a basename (e.g. ~/work/app vs ~/side/app). Prefix with a
  // human-readable slug purely so ids are recognizable in the state/ dir.
  const hash = createHash('sha256').update(normalized).digest('hex').slice(0, 12);
  const slug = basename(normalized)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug ? `${slug}-${hash}` : hash;
}

function normalizePath(repoPath) {
  // resolve() expands to an absolute path (relative to cwd) and strips any
  // trailing slash, satisfying the "normalize before hashing" requirement.
  return resolve(repoPath);
}

async function ensureDirs() {
  // stateDir is nested under baseDir, so a single recursive mkdir creates both.
  await mkdir(stateDir(), { recursive: true });
}

// Reads config.json without acquiring configLock. Only call this from
// inside a configLock-guarded critical section (either directly, as
// readConfig() does, or as part of a larger read-modify-write like
// addRepo/removeRepo) -- never standalone, or the corrupt-recovery race
// this is meant to prevent comes right back.
async function readConfigLocked() {
  await ensureDirs();

  let raw;
  try {
    raw = await readFile(configPath(), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { repos: [] };
    throw err;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.repos)) {
      throw new Error('config.json does not have the expected { repos: [] } shape');
    }
  } catch {
    // Corrupt or unexpected structure: back it up, then rebuild an empty
    // config so the tool keeps working instead of crashing. This whole
    // branch is best-effort and must never itself throw -- a corrupt
    // config.json should degrade to an empty list, never crash the caller,
    // regardless of what the backup/rebuild steps below do.
    const empty = { repos: [] };
    try {
      const backupPath = `${configPath()}.corrupt-${Date.now()}`;
      await rename(configPath(), backupPath);
    } catch {
      // Best effort only: if the corrupt file can't be moved (e.g. it was
      // already moved by an earlier recovery), fall through and still
      // recover to an empty, working config below.
    }
    try {
      await writeConfig(empty);
    } catch {
      // Best effort only: even if the rebuilt config can't be persisted
      // right now, return the in-memory empty list so the caller never
      // crashes on a corrupt file.
    }
    return empty;
  }

  return parsed;
}

async function readConfig() {
  return configLock(() => readConfigLocked());
}

async function writeConfig(config) {
  await ensureDirs();
  const tmpPath = join(baseDir(), `.config.json.tmp-${process.pid}-${randomBytes(4).toString('hex')}`);
  await writeFile(tmpPath, JSON.stringify(config, null, 2));
  try {
    await rename(tmpPath, configPath());
  } catch (err) {
    await unlink(tmpPath).catch(() => {});
    throw err;
  }
}

export async function listRepos() {
  const config = await readConfig();
  return config.repos;
}

export async function addRepo(repoPath) {
  const normalized = normalizePath(repoPath);

  let stats;
  try {
    stats = await stat(normalized);
  } catch {
    throw new Error(`Repo path does not exist: ${normalized}`);
  }
  if (!stats.isDirectory()) {
    throw new Error(`Repo path is not a directory: ${normalized}`);
  }
  try {
    await stat(join(normalized, '.git'));
  } catch {
    throw new Error(`Not a git repository (no .git found): ${normalized}`);
  }

  const id = repoId(normalized);

  // Read, mutate, and write as a single critical section so a concurrent
  // addRepo/removeRepo can never read the same pre-mutation config and
  // silently clobber this write (or vice versa).
  return configLock(async () => {
    const config = await readConfigLocked();
    const existing = config.repos.find((r) => r.id === id);
    if (existing) return existing;

    const repo = { id, path: normalized, name: basename(normalized) };
    config.repos.push(repo);
    await writeConfig(config);
    return repo;
  });
}

export async function removeRepo(id) {
  return configLock(async () => {
    const config = await readConfigLocked();
    const index = config.repos.findIndex((r) => r.id === id);
    if (index === -1) return false;

    config.repos.splice(index, 1);
    await writeConfig(config);
    return true;
  });
}

export async function getRepo(id) {
  const config = await readConfig();
  return config.repos.find((r) => r.id === id) ?? null;
}
