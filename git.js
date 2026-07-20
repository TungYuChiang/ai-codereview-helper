// git.js — 執行 git 指令並解析 unified diff。
//
// 這是 pipeline 的第一站：`parseDiff` 是純函式（吃字串吐結構，不碰檔案系統），
// 其餘的匯出函式負責跟 git / 檔案系統互動。

import { execFile } from 'node:child_process';
import { readFile, realpath, stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';

const MAX_BUFFER = 1024 * 1024 * 100; // 100MB，避免大 diff 被截斷

// Largest file the WORKING_TREE branch of getFileContent will buffer into
// memory. The git-ref branch (git show) is already bounded by MAX_BUFFER
// above; readFile has no equivalent ceiling of its own, so without this a
// large build artifact or log file sitting in the working tree gets read
// wholesale into a JS string before the caller's line-count cap ever gets a
// chance to reject it. 10MB is far beyond any real source file (even a huge
// generated types file or lockfile) while still being well under MAX_BUFFER.
const MAX_WORKING_TREE_FILE_BYTES = 10 * 1024 * 1024; // 10MB

// `--end-of-options` 告訴 git：後面的參數一律不是選項。少了它，一個以 `-`
// 開頭的 ref（例如 `--output=/tmp/x`）會被 git 當成選項解析 —— 那就是任意
// 檔案寫入。呼叫端已經先擋掉這種 ref，這裡是第二層防線：即使驗證被繞過，
// git 也不可能把 ref 讀成選項。
const END_OF_OPTIONS = '--end-of-options';
// diff 的路徑分隔符：`--` 之後只會是 pathspec，ref 不可能溢出到路徑位置。
const PATHSPEC_SEPARATOR = '--';

/**
 * 組錯誤訊息用的參數列表。上面那兩個分隔符純粹是防護用的實作細節，
 * 讓它們出現在錯誤訊息裡只會讓使用者困惑，也會讓「訊息要指名失敗的 git
 * 呼叫」這個契約變得難讀，所以顯示時濾掉。
 */
function describeArgs(args) {
  return args.filter((arg) => arg !== END_OF_OPTIONS && arg !== PATHSPEC_SEPARATOR);
}

/**
 * 執行 git 指令，回傳 stdout。失敗時拋出帶可讀訊息的 Error。
 */
function runGit(repoPath, args) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd: repoPath, maxBuffer: MAX_BUFFER }, (err, stdout, stderr) => {
      if (err) {
        const detail = (stderr && stderr.toString().trim()) || err.message;
        reject(new Error(`git ${describeArgs(args).join(' ')} failed: ${detail}`));
        return;
      }
      resolve(stdout.toString());
    });
  });
}

/**
 * 列出 repo 的 ref。
 * @param {string} repoPath
 * @returns {Promise<{ branches: string[], tags: string[], current: string }>}
 */
export async function listRefs(repoPath) {
  const [branchOut, tagOut, currentOut] = await Promise.all([
    runGit(repoPath, ['branch', '--list', '--format=%(refname:short)']),
    runGit(repoPath, ['tag', '--list']),
    runGit(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']),
  ]);

  return {
    branches: splitLines(branchOut),
    tags: splitLines(tagOut),
    current: currentOut.trim(),
  };
}

function splitLines(output) {
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * 取得原始 diff 文字。
 * target 為 null 或 'WORKING_TREE' -> git diff <base>
 * 否則                              -> git diff <base>...<target>（three-dot）
 * @param {string} repoPath
 * @param {string} base
 * @param {string | null} target
 * @returns {Promise<string>}
 */
export async function getDiff(repoPath, base, target) {
  const revision =
    target === null || target === 'WORKING_TREE' ? base : `${base}...${target}`;
  return runGit(repoPath, ['diff', END_OF_OPTIONS, revision, PATHSPEC_SEPARATOR]);
}

/**
 * 取得某 ref 下某檔案的完整內容。
 * ref 為 null 或 'WORKING_TREE' -> 直接讀工作區檔案
 * 檔案不存在回 null
 * @param {string} repoPath
 * @param {string | null} ref
 * @param {string} filePath
 * @returns {Promise<string | null>}
 */
export async function getFileContent(repoPath, ref, filePath) {
  if (ref === null || ref === 'WORKING_TREE') {
    return await readWorkingTreeFile(repoPath, filePath);
  }

  try {
    // `git show` 不吃 `--` 分隔符（`git show -- <rev>:<path>` 會被當成
    // pathspec 而回傳空字串），所以這裡只用 `--end-of-options`。
    return await runGit(repoPath, ['show', END_OF_OPTIONS, `${ref}:${filePath}`]);
  } catch (err) {
    // git show 對「檔案不存在於該 ref」會用特定的 stderr 訊息表示：
    //   fatal: path '<p>' does not exist in '<ref>'
    //   fatal: path '<p>' exists on disk, but not in '<ref>'
    // 只有這兩種情況視為「檔案不存在」回傳 null；其餘失敗（無效的 ref、
    // repo 路徑錯誤、repo 損毀等）必須照契約拋出可讀的 Error，交給上層處理。
    const message = err instanceof Error ? err.message : String(err);
    if (/path '.*' does not exist in '.*'/.test(message) ||
        /path '.*' exists on disk, but not in '.*'/.test(message)) {
      return null;
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// readWorkingTreeFile — the WORKING_TREE branch of getFileContent.
//
// `filePath` reaching here has already been lexically checked by the caller
// (server.js's resolveRepoRelativePath resolves `..`/`.` segments and rejects
// anything that lands outside the repo *as a string*). That is not enough on
// its own: `readFile` follows symlinks at the OS level, and git supports
// tracked symlinks, so a branch containing e.g. `ln -s ~/.ssh/id_rsa
// leak.txt` becomes a real on-disk symlink the moment it's checked out --
// which is the ordinary thing to do before reviewing a branch. A lexically
// contained path can still resolve, after following that symlink, to a file
// anywhere on the filesystem.
//
// This is deliberately scoped to *this* branch only, not folded into a
// shared "resolve repo-relative path" helper that both this and the git-ref
// branch would call. The two branches need different treatment:
//   - Here, the path is about to be read directly off disk, so the check
//     must be against the *real*, symlink-resolved location.
//   - The git-ref branch (`git show <ref>:<path>`) never touches the
//     filesystem via this path at all -- it reads the git object database
//     through a subprocess, and git itself refuses to resolve a path outside
//     the repository for that command. Worse, applying a disk-based realpath
//     check there would be actively wrong: a file can legitimately exist in
//     a historical ref without existing on disk at all, and realpath()-ing
//     it would throw ENOENT and turn a valid lookup into a false failure.
// A single containment helper reused uncritically by both would either miss
// the symlink case here or misfire on the other -- which is exactly the
// shape of bug this function exists to close.
async function readWorkingTreeFile(repoPath, filePath) {
  const repoRoot = resolve(repoPath);
  const candidate = resolve(repoRoot, filePath);

  let realCandidate;
  try {
    realCandidate = await realpath(candidate);
  } catch (err) {
    // Covers both "never existed" and "was a symlink whose target doesn't
    // exist" -- both are ordinary 404s to the caller, not server errors.
    if (err.code === 'ENOENT') return null;
    throw err;
  }

  const realRepoRoot = await realpath(repoRoot);
  const withinRepo =
    realCandidate === realRepoRoot || realCandidate.startsWith(realRepoRoot + sep);
  if (!withinRepo) {
    throw new Error(`path resolves outside the repository via a symlink: ${filePath}`);
  }

  const info = await stat(realCandidate);
  if (info.size > MAX_WORKING_TREE_FILE_BYTES) {
    throw new Error(
      `file exceeds the ${MAX_WORKING_TREE_FILE_BYTES}-byte working-tree read limit: ${filePath}`,
    );
  }

  try {
    return await readFile(realCandidate, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// parseDiff — 純函式
// ---------------------------------------------------------------------------

const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;

/**
 * 解析 unified diff 字串。純函式：不碰檔案系統、不執行任何指令。
 * @param {string} raw
 * @returns {FileDiff[]}
 */
export function parseDiff(raw) {
  if (!raw || raw.trim().length === 0) return [];

  const lines = raw.split('\n');
  const fileBlocks = [];
  let current = null;

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      current = [line];
      fileBlocks.push(current);
    } else if (current) {
      current.push(line);
    }
  }

  return fileBlocks.map(parseFileBlock);
}

function parseFileBlock(blockLines) {
  const headerLine = blockLines[0];
  const gitPaths = matchDiffGitLine(headerLine);

  let status = 'modified';
  let path = gitPaths ? gitPaths.b : null;
  let oldPath = null;
  let isBinary = false;

  let firstHunkIndex = blockLines.length;

  for (let i = 1; i < blockLines.length; i++) {
    const line = blockLines[i];

    if (line.startsWith('@@ ')) {
      firstHunkIndex = i;
      break;
    }

    if (line.startsWith('new file mode')) {
      status = 'added';
    } else if (line.startsWith('deleted file mode')) {
      status = 'deleted';
    } else if (line.startsWith('rename from ')) {
      status = 'renamed';
      oldPath = line.slice('rename from '.length);
    } else if (line.startsWith('rename to ')) {
      status = 'renamed';
      path = line.slice('rename to '.length);
    } else if (line.startsWith('Binary files ') && line.endsWith(' differ')) {
      isBinary = true;
    } else if (line.startsWith('--- ')) {
      // deleted 檔案的 +++ 是 /dev/null，path 只能從 --- 取得（舊路徑）
      if (status === 'deleted') {
        const p = stripAbPrefix(line.slice('--- '.length));
        if (p !== null) path = p;
      }
    } else if (line.startsWith('+++ ')) {
      const p = stripAbPrefix(line.slice('+++ '.length));
      if (p !== null && status !== 'deleted' && status !== 'renamed') {
        path = p;
      }
    }
  }

  if (isBinary) {
    return {
      path: path ?? (gitPaths ? gitPaths.b : ''),
      oldPath: null,
      status: 'binary',
      hunks: [],
    };
  }

  const hunkLines = blockLines.slice(firstHunkIndex);
  const hunks = parseHunks(hunkLines);

  return {
    path: path ?? (gitPaths ? gitPaths.b : ''),
    oldPath: status === 'renamed' ? oldPath : null,
    status,
    hunks,
  };
}

function matchDiffGitLine(line) {
  const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
  if (!m) return null;
  return { a: m[1], b: m[2] };
}

/** '--- a/foo.js' -> 'foo.js'；'--- /dev/null' -> null */
function stripAbPrefix(value) {
  if (value === '/dev/null') return null;
  if (value.startsWith('a/') || value.startsWith('b/')) return value.slice(2);
  return value;
}

function parseHunks(hunkLines) {
  const hunks = [];
  let i = 0;

  while (i < hunkLines.length) {
    const headerMatch = HUNK_HEADER_RE.exec(hunkLines[i]);
    if (!headerMatch) {
      i++;
      continue;
    }

    const oldStart = Number(headerMatch[1]);
    const oldLines = headerMatch[2] !== undefined ? Number(headerMatch[2]) : 1;
    const newStart = Number(headerMatch[3]);
    const newLines = headerMatch[4] !== undefined ? Number(headerMatch[4]) : 1;
    const header = headerMatch[5] ?? '';

    let oldLine = oldStart;
    let newLine = newStart;
    const contentLines = [];

    i++;
    while (i < hunkLines.length && !hunkLines[i].startsWith('@@ ')) {
      const line = hunkLines[i];

      if (line.startsWith('\\')) {
        // '\ No newline at end of file' — 不是內容行
        i++;
        continue;
      }

      if (line === '') {
        // diff 區塊尾端可能因 split('\n') 產生的空字串（沒有前導字元），略過
        i++;
        continue;
      }

      const marker = line[0];
      const text = line.slice(1);

      if (marker === '+') {
        contentLines.push({ type: '+', text, oldLine: null, newLine });
        newLine++;
      } else if (marker === '-') {
        contentLines.push({ type: '-', text, oldLine, newLine: null });
        oldLine++;
      } else if (marker === ' ') {
        contentLines.push({ type: ' ', text, oldLine, newLine });
        oldLine++;
        newLine++;
      }
      // 其他未知前導字元的行（理論上不該出現）直接忽略

      i++;
    }

    hunks.push({ oldStart, oldLines, newStart, newLines, header, lines: contentLines });
  }

  return hunks;
}
