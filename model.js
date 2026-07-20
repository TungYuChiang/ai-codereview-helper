// model.js — 把 diff 的變更行按「所在 function」分桶，合成三層樹：
// 檔案 → function → 變更點。
//
// 純函式：不碰檔案系統、不執行子行程、不 import 專案內其他模組，
// 也不修改傳入的物件。呼叫端負責準備好 fileDiffs 與 rangesByPath。

/**
 * @param {FileDiff[]} fileDiffs               git.js parseDiff() 的輸出
 * @param {{ [filePath: string]: FunctionRange[] }} rangesByPath
 *        functions.js getFunctionRanges() 的結果，以新版檔案路徑為 key。
 *        缺 key 或值為 [] → 該檔所有改動都落在檔案層。
 * @returns {FileNode[]}
 */
export function buildTree(fileDiffs, rangesByPath) {
  return fileDiffs.map((fileDiff) => buildFileNode(fileDiff, rangesByPath));
}

function buildFileNode(fileDiff, rangesByPath) {
  // 用 Object.hasOwn 而非 `[]` 直接取值：若檔名剛好等於
  // 'constructor' / 'toString' / '__proto__' 之類的內建鍵，`[]` 存取會沿著
  // prototype chain 拿到一個 truthy 的非陣列值，讓 `|| []` 的降級判斷失效。
  const ranges =
    (rangesByPath && Object.hasOwn(rangesByPath, fileDiff.path) && rangesByPath[fileDiff.path]) ||
    [];
  const entries = collectChangePoints(fileDiff, ranges);
  const groups = groupChangePoints(entries);

  return {
    path: fileDiff.path,
    oldPath: fileDiff.oldPath,
    status: fileDiff.status,
    groups,
    total: groups.reduce((sum, group) => sum + group.total, 0),
  };
}

// ---------------------------------------------------------------------------
// 1 + 2 + 3：行歸屬 → segment 切割 → ChangePoint
// ---------------------------------------------------------------------------

/**
 * 依 hunk 順序走訪所有行，切成 segment，產出 ChangePoint（保持檔案中的先後順序）。
 * 回傳 { changePoint, owner } — owner 是該變更點所屬的 FunctionRange 物件（檔案層為 null），
 * group 階段用它辨識「同名但不同範圍」的兩個 function。
 *
 * 假設 fileDiff.hunks 依 newStart 遞增排列（真實 git diff 輸出即是如此）；
 * 下游 groupChangePoints() 的排序邏輯依賴這個順序假設才能正確運作。
 */
function collectChangePoints(fileDiff, ranges) {
  const entries = [];

  fileDiff.hunks.forEach((hunk, hunkIndex) => {
    // 游標代表「下一行在新版檔案的位置」，初始為 hunk 的新版起始行。
    let cursor = hunk.newStart;
    let segment = null;

    const flush = () => {
      const changePoint = makeChangePoint(segment, fileDiff.path, hunkIndex);
      if (changePoint !== null) entries.push({ changePoint, owner: segment.owner });
      segment = null;
    };

    for (const line of hunk.lines) {
      let position;
      if (line.type === '+' || line.type === ' ') {
        position = line.newLine;
        cursor = line.newLine + 1;
      } else if (line.type === '-') {
        // 刪除行的 newLine 為 null，位置＝這行「原本會出現的位置」，游標不前進。
        position = cursor;
      } else {
        // 非預期的 line.type：目前的 git.js 只會產出 '+' / '-' / ' '，但若上游
        // 未來放寬了這個約束，寧可跳過這行也不要讓 cursor 被 null/undefined 污染
        // （否則後面每一個刪除行的位置都會被連帶算錯）。
        continue;
      }

      const owner = findOwner(ranges, position);

      if (segment !== null && segment.owner !== owner) flush();

      if (segment === null) {
        segment = { owner, lines: [], newStart: position, newEnd: position };
      }

      // segment.lines 直接引用傳入的 Line 物件（不複製）；下游只能讀取，不可修改，
      // 否則會違反 buildTree 的「不修改輸入」保證。
      segment.lines.push(line);
      if (position < segment.newStart) segment.newStart = position;
      if (position > segment.newEnd) segment.newEnd = position;
    }

    if (segment !== null) flush();
  });

  return entries;
}

/**
 * 某位置屬於某 function ⟺ startLine <= 位置 <= endLine。
 * 同時落在多個範圍時（理論上不該發生）取範圍最小的那個。
 * 不落在任何範圍 → null（檔案層）。
 */
function findOwner(ranges, position) {
  let best = null;
  let bestSize = Infinity;

  for (const range of ranges) {
    if (position < range.startLine || position > range.endLine) continue;
    const size = range.endLine - range.startLine;
    if (size < bestSize) {
      best = range;
      bestSize = size;
    }
  }

  return best;
}

/** 完全不含 '+' / '-' 的 segment（純 context）不產生 ChangePoint。 */
function makeChangePoint(segment, filePath, hunkIndex) {
  const changedLines = segment.lines.filter((line) => line.type !== ' ');
  if (changedLines.length === 0) return null;

  return {
    filePath,
    functionName: segment.owner === null ? null : segment.owner.name,
    hunkIndex,
    newStart: segment.newStart,
    newEnd: segment.newEnd,
    lines: segment.lines,
    diffText: changedLines.map((line) => `${line.type}${line.text}`).join('\n'),
  };
}

// ---------------------------------------------------------------------------
// 4：Group 的建立與排序
// ---------------------------------------------------------------------------

/**
 * 同一 function 的變更點合併進同一個 GroupNode；
 * 檔案層變更點則依出現順序切成數個「連續區段」，每段一個 name: null 的 group，
 * 這樣左側樹的順序才會與右側長捲軸的順序一致。
 * 最後依「該 group 第一個變更點的 newStart」遞增排序。
 */
function groupChangePoints(entries) {
  const groups = [];
  const groupsByOwner = new Map();
  let openNullGroup = null;

  for (const { changePoint, owner } of entries) {
    if (owner === null) {
      if (openNullGroup === null) {
        openNullGroup = { name: null, startLine: null, endLine: null, changePoints: [] };
        groups.push(openNullGroup);
      }
      openNullGroup.changePoints.push(changePoint);
      continue;
    }

    // 遇到 function 層的變更點就結束目前的檔案層區段，維持順序。
    openNullGroup = null;

    let group = groupsByOwner.get(owner);
    if (group === undefined) {
      group = {
        name: owner.name,
        startLine: owner.startLine,
        endLine: owner.endLine,
        changePoints: [],
      };
      groupsByOwner.set(owner, group);
      groups.push(group);
    }
    group.changePoints.push(changePoint);
  }

  for (const group of groups) {
    group.total = group.changePoints.length;
  }

  // 排序鍵：該 group 第一個（＝ newStart 最小的）變更點的 newStart。
  return groups.sort((a, b) => sortKey(a) - sortKey(b));
}

function sortKey(group) {
  return group.changePoints.reduce(
    (min, changePoint) => Math.min(min, changePoint.newStart),
    Infinity,
  );
}
