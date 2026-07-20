// server.js — HTTP + JSON API. Assembles config.js / git.js / functions.js /
// model.js / state.js / export.js into the endpoints the front end talks to,
// and serves public/ as static files.
//
// Exports createServer(), which returns an http.Server that is NOT yet
// listening -- the caller (review.js in production, tests in test/) decides
// the port. This is what lets tests use port 0 for an ephemeral server.

import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, sep, extname } from 'node:path';

import * as config from './config.js';
import * as git from './git.js';
import * as functions from './functions.js';
import * as model from './model.js';
import * as state from './state.js';
import * as exportModule from './export.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = resolve(__dirname, 'public');

// How many `git show`/file-read subprocesses run concurrently while building
// a diff. Unbounded parallelism would spawn one git subprocess per changed
// file at once, which for a large branch diff can mean hundreds of
// concurrent subprocesses -- this caps it to a small, fixed batch.
const CONTENT_FETCH_CONCURRENCY = 8;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

// ---------------------------------------------------------------------------
// HttpError — the only kind of error a route handler should throw on
// purpose. Its `.status` is what the top-level catch uses to pick a status
// code; anything else is treated as unexpected and mapped to 500.
// ---------------------------------------------------------------------------

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// createServer
// ---------------------------------------------------------------------------

export function createServer() {
  return http.createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      // Safety net only -- handleRequest already catches everything it can.
      // Reaching here means something went wrong in the catch path itself
      // (e.g. writing the response failed); never let it crash the process.
      console.error(err);
      if (!res.headersSent) {
        try {
          sendJson(res, 500, { error: 'internal error' });
        } catch {
          res.end();
        }
      } else {
        res.end();
      }
    });
  });
}

async function handleRequest(req, res) {
  try {
    const url = new URL(req.url, 'http://localhost');
    const pathname = decodeURIComponent(url.pathname);

    if (pathname.startsWith('/api/')) {
      await routeApi(req, res, url, pathname);
      return;
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      await serveStatic(req, res, pathname);
      return;
    }

    sendJson(res, 404, { error: 'not found' });
  } catch (err) {
    if (err instanceof HttpError) {
      sendJson(res, err.status, { error: err.message });
    } else {
      // Unexpected exception: never leak a stack trace to the client, but do
      // print it to the server console so the developer running this
      // locally can see what happened.
      console.error(err);
      sendJson(res, 500, { error: 'internal error' });
    }
  }
}

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(text);
}

function readJsonBody(req) {
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (raw.trim() === '') {
        resolvePromise({});
        return;
      }
      try {
        resolvePromise(JSON.parse(raw));
      } catch {
        rejectPromise(new HttpError(400, 'invalid JSON body'));
      }
    });
    req.on('error', (err) => rejectPromise(err));
  });
}

async function getRepoOr404(id) {
  if (typeof id !== 'string' || id.length === 0) {
    throw new HttpError(400, 'repo is required');
  }
  const repo = await config.getRepo(id);
  if (!repo) {
    throw new HttpError(404, `repo not found: ${id}`);
  }
  return repo;
}

function requireString(value, fieldName) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new HttpError(400, `${fieldName} is required and must be a non-empty string`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// API routing
// ---------------------------------------------------------------------------

async function routeApi(req, res, url, pathname) {
  const { method } = req;

  if (pathname === '/api/repos' && method === 'GET') {
    return sendJson(res, 200, { repos: await config.listRepos() });
  }

  if (pathname === '/api/repos' && method === 'POST') {
    const body = await readJsonBody(req);
    const path = requireString(body.path, 'path');
    let repo;
    try {
      repo = await config.addRepo(path);
    } catch (err) {
      throw new HttpError(400, err.message);
    }
    return sendJson(res, 200, { repo });
  }

  if (pathname.startsWith('/api/repos/') && method === 'DELETE') {
    const id = pathname.slice('/api/repos/'.length);
    const removed = await config.removeRepo(id);
    return sendJson(res, 200, { removed });
  }

  if (pathname === '/api/refs' && method === 'GET') {
    const repo = await getRepoOr404(url.searchParams.get('repo'));
    let refs;
    try {
      refs = await git.listRefs(repo.path);
    } catch (err) {
      throw new HttpError(400, err.message);
    }
    return sendJson(res, 200, refs);
  }

  if (pathname === '/api/diff' && method === 'GET') {
    const repo = await getRepoOr404(url.searchParams.get('repo'));
    const base = requireString(url.searchParams.get('base'), 'base');
    const target = url.searchParams.get('target') || 'WORKING_TREE';

    const { annotated } = await runDiffPipeline(repo, base, target);
    return sendJson(res, 200, {
      files: annotated.files,
      orphans: annotated.orphans,
      stats: annotated.stats,
      base,
      target,
    });
  }

  if (pathname === '/api/check' && method === 'POST') {
    const body = await readJsonBody(req);
    const key = requireString(body.key, 'key');
    if (typeof body.checked !== 'boolean') {
      throw new HttpError(400, 'checked is required and must be a boolean');
    }
    const repo = await getRepoOr404(body.repo);
    await state.setChecked(repo.id, key, body.checked);
    return sendJson(res, 200, { ok: true });
  }

  if (pathname === '/api/comment' && method === 'POST') {
    const body = await readJsonBody(req);
    const key = requireString(body.key, 'key');
    if (typeof body.text !== 'string') {
      throw new HttpError(400, 'text is required and must be a string');
    }
    const repo = await getRepoOr404(body.repo);
    try {
      await state.setComment(repo.id, key, body.text, body.context);
    } catch (err) {
      throw new HttpError(400, err.message);
    }
    return sendJson(res, 200, { ok: true });
  }

  if (pathname === '/api/orphan/discard' && method === 'POST') {
    const body = await readJsonBody(req);
    const key = requireString(body.key, 'key');
    const repo = await getRepoOr404(body.repo);
    await state.discardOrphan(repo.id, key);
    return sendJson(res, 200, { ok: true });
  }

  if (pathname === '/api/export' && method === 'GET') {
    const repo = await getRepoOr404(url.searchParams.get('repo'));
    const base = requireString(url.searchParams.get('base'), 'base');
    const target = url.searchParams.get('target') || 'WORKING_TREE';
    const format = url.searchParams.get('format');
    if (format !== 'claude' && format !== 'markdown') {
      throw new HttpError(400, "format must be 'claude' or 'markdown'");
    }

    const { annotated, contentByPath } = await runDiffPipeline(repo, base, target);
    const ctx = {
      repoPath: repo.path,
      repoName: repo.name,
      base,
      target,
      date: new Date().toISOString(),
      files: annotated.files,
      orphans: annotated.orphans,
      stats: annotated.stats,
      sources: contentByPath,
    };
    const text = format === 'claude' ? exportModule.toClaudePrompt(ctx) : exportModule.toMarkdown(ctx);
    return sendJson(res, 200, { text });
  }

  throw new HttpError(404, `not found: ${method} ${pathname}`);
}

// ---------------------------------------------------------------------------
// Diff pipeline — config.getRepo -> git.getDiff -> git.parseDiff -> (per
// file) git.getFileContent + functions.getFunctionRanges -> model.buildTree
// -> state.annotate. See task-server-api-brief.md for the full picture.
// ---------------------------------------------------------------------------

async function runDiffPipeline(repo, base, target) {
  let raw;
  try {
    raw = await git.getDiff(repo.path, base, target);
  } catch (err) {
    throw new HttpError(400, err.message);
  }

  const fileDiffs = git.parseDiff(raw);
  const rangesByPath = {};
  const contentByPath = {};

  await mapWithConcurrency(fileDiffs, CONTENT_FETCH_CONCURRENCY, async (fileDiff) => {
    // Binary files have no meaningful text content to fetch or scan for
    // function ranges.
    if (fileDiff.status === 'binary') {
      rangesByPath[fileDiff.path] = [];
      return;
    }

    let content;
    try {
      content = await git.getFileContent(repo.path, target, fileDiff.path);
    } catch (err) {
      throw new HttpError(400, err.message);
    }

    // A file that doesn't exist under `target` (e.g. it was deleted) is not
    // an error -- it just has no ranges to report.
    if (content === null) {
      rangesByPath[fileDiff.path] = [];
      return;
    }

    contentByPath[fileDiff.path] = content;
    rangesByPath[fileDiff.path] = functions.getFunctionRanges(fileDiff.path, content);
  });

  const fileNodes = model.buildTree(fileDiffs, rangesByPath);
  const annotated = await state.annotate(repo.id, fileNodes);
  return { annotated, contentByPath };
}

/**
 * Runs `fn` over `items` with at most `limit` in flight at once, to avoid
 * spawning one git subprocess per changed file simultaneously on a large
 * diff. A rejection from any item propagates once all in-flight work for
 * that worker settles.
 */
async function mapWithConcurrency(items, limit, fn) {
  let index = 0;
  let firstError = null;

  async function worker() {
    while (index < items.length) {
      const current = index++;
      try {
        await fn(items[current], current);
      } catch (err) {
        if (firstError === null) firstError = err;
      }
    }
  }

  const workerCount = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: workerCount }, worker));

  if (firstError !== null) throw firstError;
}

// ---------------------------------------------------------------------------
// Static file serving — anything under public/, with `/` mapped to
// public/index.html. Path traversal outside public/ must never be served:
// the requested path is resolved and then checked to still be inside
// PUBLIC_DIR before it's read.
// ---------------------------------------------------------------------------

async function serveStatic(req, res, pathname) {
  const relativePath = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const filePath = resolve(PUBLIC_DIR, relativePath);

  const withinPublicDir = filePath === PUBLIC_DIR || filePath.startsWith(PUBLIC_DIR + sep);
  if (!withinPublicDir) {
    return sendJson(res, 404, { error: 'not found' });
  }

  let stats;
  try {
    stats = await stat(filePath);
  } catch {
    return sendJson(res, 404, { error: 'not found' });
  }
  if (!stats.isFile()) {
    return sendJson(res, 404, { error: 'not found' });
  }

  const data = await readFile(filePath);
  const contentType = MIME_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': contentType });
  if (req.method === 'HEAD') {
    res.end();
  } else {
    res.end(data);
  }
}
