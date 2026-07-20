// export.js — turns a finished (or half-finished) review into two clipboard
// strings: a prompt for Claude and a Markdown note for Obsidian.
//
// Pure functions: read ctx, return a string, never touch the filesystem,
// never spawn a subprocess, never import another project module, never
// mutate ctx. The caller (server/UI layer) assembles ctx and hands it over;
// this module never reads the clock or computes change-point ids.

import { join } from 'node:path';

const NO_QUESTIONS_NOTE = '這次 review 沒有留下任何疑問（沒有變更點被加上 comment）。';
const FILE_LEVEL_LABEL = '(檔案層)';

// ---------------------------------------------------------------------------
// Shared traversal — walk ctx.files and collect every change point that has
// a comment, alongside the file/group it came from. Both formats need this,
// just render it differently.
// ---------------------------------------------------------------------------

function collectCommentedEntries(files) {
  const entries = [];
  for (const file of files ?? []) {
    for (const group of file.groups ?? []) {
      for (const changePoint of group.changePoints ?? []) {
        if (changePoint.comment) entries.push({ file, group, changePoint });
      }
    }
  }
  return entries;
}

// ---------------------------------------------------------------------------
// toClaudePrompt
// ---------------------------------------------------------------------------

export function toClaudePrompt(ctx) {
  const { repoPath, files, orphans, sources } = ctx;
  const intro =
    '這是一份 code review 的疑問清單，每一則都是我看 diff 時留下的疑問，' +
    '請針對每一則實際查證程式碼（必要時打開檔案）並回答。';

  const entries = collectCommentedEntries(files);
  const hasOrphans = Array.isArray(orphans) && orphans.length > 0;

  if (entries.length === 0 && !hasOrphans) {
    return `${intro}\n\n${NO_QUESTIONS_NOTE}`;
  }

  const sections = [intro];

  if (entries.length === 0 && !hasOrphans) {
    sections.push(NO_QUESTIONS_NOTE);
  } else {
    entries.forEach((entry, index) => {
      sections.push(formatClaudeEntry(entry, index + 1, repoPath, sources));
    });
  }

  if (hasOrphans) {
    sections.push(formatClaudeOrphanSection(orphans));
  }

  return sections.join('\n\n---\n\n');
}

function formatClaudeEntry({ file, group, changePoint }, index, repoPath, sources) {
  const parts = [`## ${index}. ${join(repoPath, file.path)}`];

  if (group.name !== null) {
    parts.push(`所在 function：${group.name}（第 ${group.startLine}-${group.endLine} 行）`);

    const source = sources ? sources[file.path] : undefined;
    if (source !== undefined) {
      const sourceLines = source.split('\n');
      const snippet = sourceLines.slice(group.startLine - 1, group.endLine).join('\n');
      parts.push(`Function 原始碼：\n${fence(snippet)}`);
    }
  }

  parts.push(`Diff：\n${fence(formatRawLines(changePoint.lines), 'diff')}`);
  parts.push(`我的 comment：\n${changePoint.comment}`);

  return parts.join('\n\n');
}

function formatRawLines(lines) {
  return (lines ?? []).map((line) => `${line.type}${line.text}`).join('\n');
}

// Wrap `content` in a fenced code block whose backtick run is guaranteed to
// be longer than any backtick run already inside `content`. This is the
// standard CommonMark rule (a fence of N backticks is only closed by a run
// of N or more) applied defensively: since `content` here is arbitrary
// reviewed source/diff text, a plain ``` fence can be closed early by an
// embedded ``` sequence (e.g. a Markdown file, or a JS template literal
// containing a fenced snippet), corrupting everything that follows in the
// entry. Sizing the fence to the content avoids that without having to
// change the overall block format (still gets ```diff syntax highlighting).
function fence(content, lang = '') {
  const runs = content.match(/`+/g) ?? [];
  const longestRun = runs.reduce((max, run) => Math.max(max, run.length), 0);
  const fenceLength = Math.max(3, longestRun + 1);
  const marker = '`'.repeat(fenceLength);
  return `${marker}${lang}\n${content}\n${marker}`;
}

function formatClaudeOrphanSection(orphans) {
  const parts = ['## 孤兒 comment（這些變更點已不在目前的 diff 中）'];
  orphans.forEach((orphan, index) => {
    const heading = `### ${index + 1}. ${orphan.filePath ?? '(未知檔案)'}`;
    const fnLine = orphan.functionName ? `所在 function：${orphan.functionName}` : null;
    const diffBlock = `Diff 快照：\n${fence(orphan.diffText ?? '', 'diff')}`;
    const commentLine = `我的 comment：\n${orphan.text}`;
    parts.push([heading, fnLine, diffBlock, commentLine].filter(Boolean).join('\n\n'));
  });
  return parts.join('\n\n');
}

// ---------------------------------------------------------------------------
// toMarkdown
// ---------------------------------------------------------------------------

export function toMarkdown(ctx) {
  const { repoName, base, target, date, files, orphans, stats } = ctx;

  const headerLine = `# Review: ${repoName}  ${base}...${target}`;
  const statsLine = `${date} · ${stats.total} 個變更點 · 已看 ${stats.checked} · ${stats.comments} 則 comment`;

  const blocks = [headerLine, statsLine];

  const fileSections = (files ?? [])
    .map((file) => formatMarkdownFile(file))
    .filter((section) => section !== null);

  const hasOrphans = Array.isArray(orphans) && orphans.length > 0;

  if (fileSections.length === 0 && !hasOrphans) {
    blocks.push('這次 review 沒有留下 comment。');
  } else {
    blocks.push(...fileSections);
  }

  if (hasOrphans) {
    blocks.push(formatMarkdownOrphanSection(orphans));
  }

  return blocks.join('\n\n');
}

function formatMarkdownFile(file) {
  const groupSections = (file.groups ?? [])
    .map((group) => formatMarkdownGroup(group))
    .filter((section) => section !== null);

  if (groupSections.length === 0) return null;

  return [`## ${file.path}`, ...groupSections].join('\n\n');
}

function formatMarkdownGroup(group) {
  const commented = (group.changePoints ?? []).filter((changePoint) => changePoint.comment);
  if (commented.length === 0) return null;

  return commented.map((changePoint) => formatMarkdownChangePoint(group, changePoint)).join('\n\n');
}

function formatMarkdownChangePoint(group, changePoint) {
  const label = group.name === null ? FILE_LEVEL_LABEL : group.name;
  const heading = `### ${label}  (+${changePoint.newStart}..${changePoint.newEnd})`;
  const quote = quoteDiffText(changePoint.diffText);
  return [heading, quote, changePoint.comment].join('\n\n');
}

function quoteDiffText(diffText) {
  return (diffText ?? '')
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
}

function formatMarkdownOrphanSection(orphans) {
  const items = orphans.map((orphan) => {
    const label = orphan.functionName ?? FILE_LEVEL_LABEL;
    const heading = `### ${orphan.filePath ?? '(未知檔案)'} — ${label}`;
    const quote = quoteDiffText(orphan.diffText);
    const note = '（此變更點已不在目前的 diff 中）';
    return [heading, quote, note, orphan.text].join('\n\n');
  });

  return ['## 孤兒 comment', ...items].join('\n\n');
}
