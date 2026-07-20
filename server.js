// server.js — HTTP + JSON API. Assembles config.js / git.js / functions.js /
// model.js / state.js / export.js into the endpoints the front end talks to,
// and serves public/ as static files.
//
// Exports createServer(), which returns an http.Server that is NOT yet
// listening -- the caller (review.js in production, tests in test/) decides
// the port. This is what lets tests use port 0 for an ephemeral server.

import http from 'node:http';
import { readFile, stat, mkdir, appendFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, resolve, sep, extname } from 'node:path';

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

// Largest request body we will accept. Every body this API takes is a small
// JSON object (a repo id, a change point key, a comment); nothing legitimate
// comes close. Without a cap, readJsonBody buffers whatever it is sent.
const MAX_BODY_BYTES = 1024 * 1024; // 1MB

// Longest ref we will accept. Git itself has no hard limit, but a ref this
// long is not something a human typed.
const MAX_REF_LENGTH = 255;

// Largest line range /api/lines will return in one call. Context expansion
// is meant to be progressive (click above/below, pull in a chunk, repeat) --
// there is no legitimate reason for one request to pull an entire large
// file at once.
const MAX_LINES_PER_REQUEST = 2000;

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

    // Malformed percent-encoding (`/%zz`) makes decodeURIComponent throw a
    // URIError. That is bad *input*, not a server fault -- letting it reach
    // the generic handler turns every stray port scan into a 500 plus a stack
    // trace on the console, which drowns out real errors.
    let pathname;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      sendJson(res, 400, { error: 'malformed percent-encoding in request path' });
      return;
    }

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
  // Require a JSON Content-Type. This is what stops a plain cross-origin HTML
  // form -- which can only send text/plain, multipart/form-data or
  // application/x-www-form-urlencoded, and needs no CORS preflight -- from
  // reaching this parser at all. A same-origin `fetch` with an explicit JSON
  // Content-Type (what the front end sends) is unaffected.
  const contentType = req.headers['content-type'];
  const mediaType = typeof contentType === 'string' ? contentType.split(';')[0].trim().toLowerCase() : '';
  if (mediaType !== 'application/json') {
    return Promise.reject(
      new HttpError(415, 'Content-Type must be application/json'),
    );
  }

  return new Promise((resolvePromise, rejectPromise) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;

    req.on('data', (chunk) => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        // Stop buffering immediately -- the whole point is to bound memory.
        // We keep draining the socket (rather than destroying it) so the
        // client gets a clean 413 instead of a connection reset.
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (tooLarge) {
        rejectPromise(
          new HttpError(413, `request body exceeds the ${MAX_BODY_BYTES} byte limit`),
        );
        return;
      }

      const raw = Buffer.concat(chunks).toString('utf8');
      if (raw.trim() === '') {
        resolvePromise({});
        return;
      }

      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        rejectPromise(new HttpError(400, 'invalid JSON body'));
        return;
      }

      // JSON.parse happily returns null, arrays, strings and numbers. Every
      // caller here immediately does `body.someField`, which throws on null
      // and silently misbehaves on the rest. Rejecting anything that is not a
      // plain object fixes all four body endpoints in one place.
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        rejectPromise(new HttpError(400, 'request body must be a JSON object'));
        return;
      }

      resolvePromise(parsed);
    });

    req.on('error', (err) => rejectPromise(err));
  });
}

// ---------------------------------------------------------------------------
// Cross-origin defence.
//
// Every /api/ route is guarded, not just the mutating ones: the argument
// injection this defends against is a plain GET, so `<img src=...>` on any
// page the user happens to visit is a live attack vector.
//
// The rule, in order:
//
//   1. `Sec-Fetch-Site`, when present, is authoritative. Browsers set it on
//      every request and page JavaScript cannot forge it. We allow only
//      `same-origin` (the tool's own front end calling its own API) and
//      `none` (the user typing the URL / opening a bookmark). `cross-site`
//      and `same-site` are both rejected -- `same-site` matters here because
//      a page on http://localhost:3000 is "same site" as :7777, ports being
//      irrelevant to the site definition, and that is exactly the neighbour
//      we do not want reaching in.
//
//   2. `Origin`, when present, must equal `http(s)://<Host>`, where `Host` is
//      whatever the client sent -- a literal `null` Origin (sandboxed
//      iframe, data: URL) is rejected too. Be honest about what this proves:
//      the comparison is against the client's own `Host` header, not against
//      a value this server independently knows to be true, so a raw HTTP
//      client can set `Host: evil.example` and `Origin: http://evil.example`
//      and pass. That is not browser-exploitable -- a real browser always
//      puts the true authority in `Host` and would also send
//      `Sec-Fetch-Site: cross-site`, which step 1 already rejects -- and DNS
//      rebinding defeats any header-based check no matter how it is written,
//      so this is not a gap this code introduces. It just means this branch
//      is not, by itself, a trustworthy origin check; the guarantee it adds
//      is narrow (catches non-browser clients that forge `Origin` without
//      also matching `Host`), and the real protection is steps 1 and 3.
//
//   3. If neither header is present, allow. This is NOT because a browser
//      attack is guaranteed to produce one of the two -- it isn't, and a
//      future maintainer should not read this as an airtight origin check.
//      A cross-origin `<img src=...>` / `<script src=...>` / `<link>` /
//      `<form method=GET>` hit is a no-cors subresource load: browsers never
//      attach `Origin` to it. `Sec-Fetch-Site` covers it on recent engines
//      (Chrome 76+ (2019), Firefox 90+ (2021)) but Safari only added it in
//      16.4 (2023); Safari <= 16.3, older WebViews, older Electron shells,
//      and any header-stripping proxy in front of this server will deliver a
//      genuine cross-origin GET with neither header, and it is let through.
//
//      That gap is accepted, not overlooked, because the residual risk is
//      nil for reasons that do not depend on this header check: such a
//      request can only be a GET, and only to the read-only routes; the
//      response is opaque to the attacker under the same-origin policy; the
//      one GET that used to have a dangerous side effect -- arbitrary file
//      write via a ref like `--output=<path>` -- is closed at the ref
//      validation and `--end-of-options` layers below, neither of which
//      depends on origin; mutating endpoints are POST-only and additionally
//      require a JSON `Content-Type` that a cross-origin HTML form cannot
//      send; and the remaining impact of an allowed request is spawning a
//      git subprocess -- a mild DoS, not a data or integrity issue. Defaulting
//      this case closed would break curl and the test suite for no security
//      gain beyond what those other layers already provide. If a future
//      change adds a side-effecting GET, or removes the ref/Content-Type
//      guards, that reasoning breaks and this default needs revisiting.
// ---------------------------------------------------------------------------

function assertNotCrossOrigin(req) {
  const secFetchSite = req.headers['sec-fetch-site'];
  if (typeof secFetchSite === 'string' && secFetchSite !== '') {
    if (secFetchSite !== 'same-origin' && secFetchSite !== 'none') {
      throw new HttpError(403, 'cross-origin requests are not allowed');
    }
  }

  const origin = req.headers.origin;
  if (typeof origin === 'string' && origin !== '') {
    const host = req.headers.host;
    const allowed = typeof host === 'string' && host !== ''
      ? new Set([`http://${host}`, `https://${host}`])
      : new Set();
    if (!allowed.has(origin)) {
      throw new HttpError(403, 'cross-origin requests are not allowed');
    }
  }
}

// ---------------------------------------------------------------------------
// Ref validation.
//
// `base` and `target` are interpolated straight into a git command line, so a
// value beginning with `-` is read by git as an *option* -- `--output=<path>`
// turns a read-only diff endpoint into arbitrary file write. git.js also
// passes `--end-of-options` now, but that is the second layer; this is the
// first, and it is the one that produces a readable 400 rather than a
// confusing git error.
//
// The rule is deliberately permissive about *characters* and strict about the
// things that actually matter, so that it does not reject refs git considers
// perfectly ordinary:
//
//   accepted: `main`, `HEAD`, `feat/some-thing.v2`, `v1.2.3-rc.1`, `HEAD~3`,
//             `HEAD^`, `@{u}`, 40-char SHAs, non-ASCII branch names, and the
//             `WORKING_TREE` sentinel -- i.e. `/`, `.`, non-leading `-`, and
//             `~`/`^`/`@`/`{}` revision syntax all pass.
//
//   rejected: anything starting with `-` (the injection itself); anything
//             containing whitespace or a control character (no ref legally
//             contains either, and they are how a value smuggles a second
//             argument); anything containing `:` (which would let a ref
//             smuggle a path into `git show <ref>:<path>` in
//             git.getFileContent); and anything over 255 characters.
// ---------------------------------------------------------------------------

// \p{C} = control / format code points, \s = any whitespace, plus a literal ':'.
const REF_FORBIDDEN_CHARS = /[\p{C}\s:]/u;

function requireRef(value, fieldName) {
  const ref = requireString(value, fieldName);

  if (ref.startsWith('-')) {
    throw new HttpError(
      400,
      `${fieldName} must not start with '-' (it would be interpreted as a git option)`,
    );
  }
  if (REF_FORBIDDEN_CHARS.test(ref)) {
    throw new HttpError(
      400,
      `${fieldName} must not contain whitespace, control characters, or ':'`,
    );
  }
  if (ref.length > MAX_REF_LENGTH) {
    throw new HttpError(400, `${fieldName} must be at most ${MAX_REF_LENGTH} characters`);
  }

  return ref;
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

// Any base-10 integer, sign included. Deliberately permissive about *range*
// (negative, zero, absurdly large) -- /api/lines clamps those to the file's
// actual bounds rather than rejecting them, since the front end legitimately
// asks for e.g. `end=999999` to mean "to the end of the file". This only
// rejects things that are not an integer at all.
function requireInteger(value, fieldName) {
  const str = requireString(value, fieldName);
  if (!/^-?\d+$/.test(str) || !Number.isSafeInteger(Number(str))) {
    throw new HttpError(400, `${fieldName} must be an integer`);
  }
  return Number(str);
}

// ---------------------------------------------------------------------------
// Path containment for /api/lines.
//
// `path` is user input reaching a route that ultimately hands it to
// `git.getFileContent`, which for a real ref runs `git show <ref>:<path>` and
// for WORKING_TREE reads the file straight off disk. Neither of those is
// safe against a path that escapes the repo -- this is exactly the shape of
// bug that previously let `base` reach `git diff` unvalidated, just with a
// filesystem read as the payload instead of an argv option.
//
// This check is purely lexical: resolve to an absolute path (which mirrors
// serveStatic's `withinPublicDir` check below), then require it to be the
// repo root or a descendant of it. `resolve()` collapses `..` and `.`
// segments, so this also catches paths that only escape *after*
// normalisation (e.g. `foo/../../../etc`), not just ones that are lexically
// outside to begin with. Absolute paths are caught the same way --
// `resolve(repoRoot, '/etc/passwd')` discards `repoRoot` entirely per Node's
// documented behaviour for an absolute second argument, so the result
// plainly fails the containment check.
//
// Being lexical, this does NOT catch a path that is lexically contained but
// resolves outside the repo via a symlink (e.g. a tracked symlink pointing
// at `~/.ssh/id_rsa`, checked out as an ordinary part of reviewing a
// branch). `readFile` follows symlinks at the OS level; `path.resolve` never
// does. That gap only matters for WORKING_TREE, since `git show <ref>:<path>`
// reads the git object database and returns a symlink's target *string*
// rather than following it -- so it is closed at the other end, in
// `readWorkingTreeFile` in git.js, which re-checks containment against the
// `fs.realpath`-resolved location right before the disk read. See the
// comment there for why that check lives in git.js and not here.
// ---------------------------------------------------------------------------

function resolveRepoRelativePath(repoPath, rawPath) {
  const repoRoot = resolve(repoPath);
  const absolute = resolve(repoRoot, rawPath);

  const withinRepo = absolute === repoRoot || absolute.startsWith(repoRoot + sep);
  if (!withinRepo) {
    throw new HttpError(400, 'path must resolve to a location inside the repository');
  }

  const relativePath = relative(repoRoot, absolute);
  if (relativePath === '') {
    throw new HttpError(400, 'path must refer to a file, not the repository root');
  }

  return relativePath;
}

// Splits file content into lines the way a human counts them: a trailing
// newline does not count as one more (empty) line. `''` (empty file) has 0
// lines, not 1.
function splitFileLines(content) {
  if (content === '') return [];
  const lines = content.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

// ---------------------------------------------------------------------------
// API routing
// ---------------------------------------------------------------------------

// Appends one JSON line to $LCR_HOME/diag.log. Best-effort by design: every
// caller wraps it, because a diagnostic that throws would take down the page
// it is meant to observe.
async function appendDiagLine(entry) {
  const dir = config.baseDir();
  await mkdir(dir, { recursive: true });
  await appendFile(join(dir, 'diag.log'), JSON.stringify(entry) + '\n', 'utf8');
}

async function routeApi(req, res, url, pathname) {
  const { method } = req;

  // Applies to every /api/ route including the read-only GETs -- the argument
  // injection this guards against is itself a GET.
  assertNotCrossOrigin(req);

  // Diagnostic sink. Only ever written to by public/diag.js, which the page
  // loads solely when the URL carries ?diag=1. It exists because a frozen or
  // killed renderer takes the console with it, so the record has to leave the
  // browser as it happens rather than being read back afterwards.
  if (pathname === '/api/diag' && method === 'POST') {
    try {
      const body = await readJsonBody(req);
      await appendDiagLine(body);
    } catch {
      // A diagnostic that can break the thing it is diagnosing is worthless.
    }
    return sendJson(res, 200, { ok: true });
  }

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
    const base = requireRef(url.searchParams.get('base'), 'base');
    const target = requireRef(url.searchParams.get('target') || 'WORKING_TREE', 'target');

    const { annotated } = await runDiffPipeline(repo, base, target);
    return sendJson(res, 200, {
      files: annotated.files,
      orphans: annotated.orphans,
      stats: annotated.stats,
      base,
      target,
    });
  }

  if (pathname === '/api/lines' && method === 'GET') {
    const repo = await getRepoOr404(url.searchParams.get('repo'));
    const ref = requireRef(url.searchParams.get('ref'), 'ref');
    const rawPath = requireString(url.searchParams.get('path'), 'path');
    const relPath = resolveRepoRelativePath(repo.path, rawPath);
    const rawStart = requireInteger(url.searchParams.get('start'), 'start');
    const rawEnd = requireInteger(url.searchParams.get('end'), 'end');
    if (rawEnd < rawStart) {
      throw new HttpError(400, 'end must be greater than or equal to start');
    }

    let content;
    try {
      content = await git.getFileContent(repo.path, ref, relPath);
    } catch (err) {
      throw new HttpError(400, err.message);
    }
    if (content === null) {
      throw new HttpError(404, `file not found: ${relPath} at ${ref}`);
    }

    const allLines = splitFileLines(content);
    const totalLines = allLines.length;

    let start = 0;
    let end = 0;
    let lines = [];
    if (totalLines > 0) {
      start = Math.min(Math.max(rawStart, 1), totalLines);
      end = Math.min(Math.max(rawEnd, start), totalLines);

      const requestedCount = end - start + 1;
      if (requestedCount > MAX_LINES_PER_REQUEST) {
        throw new HttpError(
          400,
          `requested range spans ${requestedCount} lines, which exceeds the ${MAX_LINES_PER_REQUEST}-line limit per request`,
        );
      }

      lines = allLines
        .slice(start - 1, end)
        .map((text, i) => ({ n: start + i, text }));
    }

    return sendJson(res, 200, { path: relPath, ref, start, end, totalLines, lines });
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
    const base = requireRef(url.searchParams.get('base'), 'base');
    const target = requireRef(url.searchParams.get('target') || 'WORKING_TREE', 'target');
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
