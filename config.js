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

async function readConfig() {
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
    // Corrupt or unexpected structure: back it up, then rebuild an empty config
    // so the tool keeps working instead of crashing.
    const backupPath = `${configPath()}.corrupt-${Date.now()}`;
    await rename(configPath(), backupPath);
    const empty = { repos: [] };
    await writeConfig(empty);
    return empty;
  }

  return parsed;
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
  const config = await readConfig();
  const existing = config.repos.find((r) => r.id === id);
  if (existing) return existing;

  const repo = { id, path: normalized, name: basename(normalized) };
  config.repos.push(repo);
  await writeConfig(config);
  return repo;
}

export async function removeRepo(id) {
  const config = await readConfig();
  const index = config.repos.findIndex((r) => r.id === id);
  if (index === -1) return false;

  config.repos.splice(index, 1);
  await writeConfig(config);
  return true;
}

export async function getRepo(id) {
  const config = await readConfig();
  return config.repos.find((r) => r.id === id) ?? null;
}
