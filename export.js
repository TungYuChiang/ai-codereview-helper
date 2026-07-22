// export.js — turns a finished (or half-finished) review into two clipboard
// strings: a prompt for Claude and a Markdown note for Obsidian.
//
// Pure functions: read ctx, return a string, never touch the filesystem,
// never spawn a subprocess, never import another project module, never
// mutate ctx. The caller (server/UI layer) assembles ctx and hands it over;
// this module never reads the clock or computes change-point ids.

import { join } from 'node:path';

// 用「comment」而不是「疑問」：一則 comment 可能是疑問，也可能是建議、或
// 「這裡我想確認一下」。UI 上建立它的按鈕就叫 "+ Comment"，這裡跟著同一個詞。
const NO_QUESTIONS_NOTE = '這次 review 沒有留下任何 comment（沒有變更點被加上 comment）。';
// Distinct from NO_QUESTIONS_NOTE on purpose: saying "no questions" when
// comments do exist -- they just all landed in the orphan list -- would be
// false. Orphans are dropped from this export by design (the code they
// pointed at is gone, so the snippet/question pairing is stale), but the
// reader still deserves to know that's *why* the prompt is empty rather
// than being handed a blank or misleading document.
const ORPHANS_ONLY_NOTE =
  '這次 review 留下的 comment 對應的程式碼都已被修改或移除，' +
  '因此沒有可以送出的 comment。這些紀錄仍保留在 Markdown 筆記與畫面上。';
const FILE_LEVEL_LABEL = '(檔案層)';

// ---------------------------------------------------------------------------
// Shared traversal — walk ctx.files and collect every change point that has
// a comment, alongside the file/group it came from. Both formats need this,
// just render it differently.
// ---------------------------------------------------------------------------

// One entry per COMMENT, not per change point: a change point can carry a
// whole-change-point comment and any number of anchored ones (a comment with
// an extra `anchor` field -- see state.js's setAnchoredComment), and each of
// them is a separate question that deserves its own numbered section rather
// than being stapled under a shared diff. The unanchored one comes first so
// its rendering, and its position, are exactly what they were before anchors
// existed.
function collectCommentedEntries(files) {
  const entries = [];
  for (const file of files ?? []) {
    for (const group of file.groups ?? []) {
      for (const changePoint of group.changePoints ?? []) {
        if (changePoint.comment) {
          entries.push({ file, group, changePoint, text: changePoint.comment, anchor: null });
        }
        for (const anchored of changePoint.anchoredComments ?? []) {
          entries.push({
            file,
            group,
            changePoint,
            text: anchored.text,
            anchor: { start: anchored.anchorStart, end: anchored.anchorEnd },
          });
        }
      }
    }
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Anchor resolution — shared by both export formats.
//
// An anchor is a 0-based inclusive index range into
// `changePoint.diffText.split('\n')`: the change point's CHANGED lines only
// (model.js builds diffText from `lines.filter(type !== ' ')`). `lines`, by
// contrast, also carries context lines and is what both formats render. So
// resolving an anchor means walking `lines` and counting only the changed
// ones -- the k-th changed line in `lines` is diffText line k.
//
// diffText is the authority for the anchored TEXT (it is literally the string
// the indices address, and it is inside changePointKey, so it cannot have
// drifted while the key survives). `lines` is consulted only for the two
// things diffText deliberately does not store: real file line numbers, and
// the surrounding context. If `lines` is missing or malformed, the text still
// resolves and only the line-number label degrades to absent -- never to a
// guess, per the same rule state.js applies to snapshots.
// ---------------------------------------------------------------------------

function anchoredDiffLines(changePoint, anchor) {
  const all = (changePoint.diffText ?? '').split('\n');
  return all.slice(anchor.start, anchor.end + 1);
}

// Positions within `changePoint.lines` covered by the anchor, as a Set.
function anchoredLinePositions(changePoint, anchor) {
  const positions = new Set();
  let changedIndex = 0;
  (changePoint.lines ?? []).forEach((line, position) => {
    if (line.type === ' ') return;
    if (changedIndex >= anchor.start && changedIndex <= anchor.end) positions.add(position);
    changedIndex += 1;
  });
  return positions;
}

// "檔案第 24 行" / "檔案第 23-24 行" / "舊版第 20 行" (a deleted line has no
// new-side number at all, and claiming one would be inventing it) / '' when
// `lines` cannot answer.
function anchorLineLabel(changePoint, anchor) {
  const lines = changePoint.lines ?? [];
  const covered = [...anchoredLinePositions(changePoint, anchor)].map((p) => lines[p]).filter(Boolean);
  if (covered.length === 0) return '';

  const newNumbers = covered.map((line) => line.newLine).filter((n) => n != null);
  if (newNumbers.length > 0) return `檔案第 ${formatRange(newNumbers)} 行`;

  const oldNumbers = covered.map((line) => line.oldLine).filter((n) => n != null);
  if (oldNumbers.length > 0) return `舊版第 ${formatRange(oldNumbers)} 行（此行已被刪除）`;
  return '';
}

function formatRange(numbers) {
  const min = Math.min(...numbers);
  const max = Math.max(...numbers);
  return min === max ? String(min) : `${min}-${max}`;
}

// ---------------------------------------------------------------------------
// toClaudePrompt
// ---------------------------------------------------------------------------

export function toClaudePrompt(ctx) {
  const { repoPath, files, orphans } = ctx;
  const intro =
    '這是一份 code review 的 comment 清單，每一則都是我看 diff 時留下的，' +
    '可能是疑問，也可能是建議或我想確認的地方。' +
    '請針對每一則實際查證程式碼（必要時打開檔案）並回應。';

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

function formatClaudeEntry({ file, group, changePoint, text, anchor }, index, repoPath) {
  const parts = [`## ${index}. ${join(repoPath, file.path)}`];

  // Only the function's name and diff are kept -- not its source. The
  // absolute path above already lets the reader open the file and read as
  // much surrounding code (including callers) as they need; embedding the
  // full function body here just burns context for no benefit a fixed
  // snippet couldn't have given anyway. See task-export-slim brief.
  if (group.name !== null) {
    parts.push(`所在 function：${group.name}`);
  }

  if (anchor) {
    // The whole reason anchoring exists: a comment saying "is nm always set
    // here?" against a 67-line change point makes the reader guess which line
    // "here" is. So the anchored lines are shown TWICE, deliberately --
    //
    // So the anchored lines are shown alone, in their own fence, plus the
    // real file line number where one exists so the reader can open the file
    // at the right place instead of scanning for it.
    //
    // The full diff is deliberately NOT repeated underneath. It was at first,
    // on the theory that a line without its surrounding change is often
    // unanswerable. But that hands straight back the context the anchor was
    // drawn to remove -- in practice a 24-line anchor was arriving under a
    // 60-line diff, and the duplication grows with the size of the change
    // point, which is exactly when anchoring matters most. Choosing a range
    // IS the statement that the rest is not what the question is about, and
    // the preamble already tells the reader to open the file when it needs
    // more. A comment that really is about the whole change point carries no
    // anchor, and the else branch below still sends the entire diff.
    const anchoredText = anchoredDiffLines(changePoint, anchor).join('\n');
    const label = anchorLineLabel(changePoint, anchor);
    const count = anchor.end - anchor.start + 1;
    parts.push(
      `我的 comment 指向下面這 ${count} 行${label ? `（${label}）` : ''}：\n` +
        fence(anchoredText, 'diff'),
    );
  } else {
    parts.push(`Diff：\n${fence(formatRawLines(changePoint.lines), 'diff')}`);
  }

  parts.push(`我的 comment：\n${text}`);

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
    (changePoint) =>
      changePoint.comment || changePoint.note || (changePoint.anchoredComments ?? []).length > 0,
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
  // Anchored comments after both, each re-quoting just the lines it points at
  // under its own labeled heading. The full change-point quote is already
  // above, so this is not a duplicate for its own sake: it is the difference
  // between "somewhere in these seven lines" and "this line", which is the
  // only thing an anchored comment adds over an unanchored one and therefore
  // the one thing the note must not lose on the way into Obsidian.
  for (const anchored of changePoint.anchoredComments ?? []) {
    parts.push(formatMarkdownAnchored(changePoint, anchored));
  }
  return parts.join('\n\n');
}

function formatMarkdownAnchored(changePoint, anchored) {
  const anchor = { start: anchored.anchorStart, end: anchored.anchorEnd };
  const label = anchorLineLabel(changePoint, anchor);
  const heading = `**Anchored${label ? ` — ${label}` : ''}:**`;
  const quote = quoteDiffText(anchoredDiffLines(changePoint, anchor).join('\n'));
  return [heading, quote, anchored.text].join('\n\n');
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
    // An orphan carries the same diffText snapshot its anchors index into
    // (see state.js buildAnnotated), so the lines an anchored comment pointed
    // at are still recoverable here even though the code itself is gone --
    // which is the entire value of keeping history at all. No file line
    // label: the snapshot has no line numbers by design, and inventing one
    // against a file that has since changed would be worse than none.
    for (const anchored of orphan.anchored ?? []) {
      parts.push(
        [
          '**Anchored:**',
          quoteDiffText(
            anchoredDiffLines({ diffText: orphan.diffText }, {
              start: anchored.anchorStart,
              end: anchored.anchorEnd,
            }).join('\n'),
          ),
          anchored.text,
        ].join('\n\n'),
      );
    }
    return parts.join('\n\n');
  });

  return ['## 歷史 comment（對應的程式碼已被修改或移除）', ...items].join('\n\n');
}
