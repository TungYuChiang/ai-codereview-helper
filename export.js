// export.js — turns a finished (or half-finished) review into two clipboard
// strings: a prompt for Claude and a Markdown note for Obsidian.
//
// Pure functions: read ctx, return a string, never touch the filesystem,
// never spawn a subprocess, never import another project module, never
// mutate ctx. The caller (server/UI layer) assembles ctx and hands it over;
// this module never reads the clock or computes change-point ids.

import { join } from 'node:path';

const NO_QUESTIONS_NOTE = '這次 review 沒有留下任何疑問（沒有變更點被加上 comment）。';
// Distinct from NO_QUESTIONS_NOTE on purpose: saying "no questions" when
// comments do exist -- they just all landed in the orphan list -- would be
// false. Orphans are dropped from this export by design (the code they
// pointed at is gone, so the snippet/question pairing is stale), but the
// reader still deserves to know that's *why* the prompt is empty rather
// than being handed a blank or misleading document.
const ORPHANS_ONLY_NOTE =
  '這次 review 留下的 comment 對應的程式碼都已被修改或移除，' +
  '因此沒有可以送出的疑問。這些紀錄仍保留在 Markdown 匯出與畫面上。';
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
  const { repoPath, files, orphans } = ctx;
  const intro =
    '這是一份 code review 的疑問清單，每一則都是我看 diff 時留下的疑問，' +
    '請針對每一則實際查證程式碼（必要時打開檔案）並回答。';

  const entries = collectCommentedEntries(files);
  // Notes are deliberately excluded from this export end to end -- see the
  // brief's table: a note means "I understood this, recording it for
  // myself", the opposite of "please check this". collectCommentedEntries
  // above already only looks at changePoint.comment, so a note-only change
  // point never becomes an entry here. Orphans need the same filter applied
  // explicitly, because state.js's buildAnnotated now orphans a key that
  // has *either* a comment or a note (or both) -- an orphan carrying only a
  // note (commentOrphan.text === null) must not count as "there were real
  // questions, just orphaned" below.
  //
  // Orphans themselves are never rendered into this export (see
  // ORPHANS_ONLY_NOTE above for why) -- they stay visible in the UI and in
  // the Markdown export only. hasOrphans exists purely so the "no
  // questions" guard below can tell "genuinely nothing was ever commented"
  // apart from "there were comments, they just all got orphaned".
  const hasOrphans = (orphans ?? []).some((orphan) => orphan.text);

  if (entries.length === 0) {
    const note = hasOrphans ? ORPHANS_ONLY_NOTE : NO_QUESTIONS_NOTE;
    return `${intro}\n\n${note}`;
  }

  const sections = [intro];
  entries.forEach((entry, index) => {
    sections.push(formatClaudeEntry(entry, index + 1, repoPath));
  });

  return sections.join('\n\n---\n\n');
}

function formatClaudeEntry({ file, group, changePoint }, index, repoPath) {
  const parts = [`## ${index}. ${join(repoPath, file.path)}`];

  // Only the function's name and diff are kept -- not its source. The
  // absolute path above already lets the reader open the file and read as
  // much surrounding code (including callers) as they need; embedding the
  // full function body here just burns context for no benefit a fixed
  // snippet couldn't have given anyway. See task-export-slim brief.
  if (group.name !== null) {
    parts.push(`所在 function：${group.name}`);
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

// Unlike the Claude prompt, Markdown is the export the brief calls out as
// the natural home for notes ("a note about what a change actually does is
// often the most useful thing to paste into Obsidian") -- so a change point
// with a note but no comment still earns a heading here, where the same
// change point would be invisible in the Claude prompt.
function formatMarkdownGroup(group) {
  const annotated = (group.changePoints ?? []).filter(
    (changePoint) => changePoint.comment || changePoint.note,
  );
  if (annotated.length === 0) return null;

  return annotated.map((changePoint) => formatMarkdownChangePoint(group, changePoint)).join('\n\n');
}

function formatMarkdownChangePoint(group, changePoint) {
  const label = group.name === null ? FILE_LEVEL_LABEL : group.name;
  const heading = `### ${label}  (+${changePoint.newStart}..${changePoint.newEnd})`;
  const quote = quoteDiffText(changePoint.diffText);
  const parts = [heading, quote];
  // Comment stays unlabeled (exactly the pre-notes rendering, so existing
  // comment-only output is byte-identical) -- the note gets an explicit
  // "**Note:**" prefix so the two are never ambiguous when both are present
  // on the same change point, and so a note-only entry (no comment at all)
  // still reads as a deliberate note rather than an unlabeled stray
  // paragraph.
  if (changePoint.comment) parts.push(changePoint.comment);
  if (changePoint.note) parts.push(`**Note:** ${changePoint.note}`);
  return parts.join('\n\n');
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
    const goneNote = '（此變更點已不在目前的 diff 中）';
    const parts = [heading, quote, goneNote];
    // Same independent nullability as the live-tree case above: an orphan
    // can carry a comment, a note, or (unlike the Claude prompt, which
    // filters these out entirely) both.
    if (orphan.text) parts.push(orphan.text);
    if (orphan.note) parts.push(`**Note:** ${orphan.note}`);
    return parts.join('\n\n');
  });

  return ['## 歷史 comment（對應的程式碼已被修改或移除）', ...items].join('\n\n');
}
