import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { buildTree } from '../model.js';

// ---------------------------------------------------------------------------
// Fixture helpers — 手寫 FileDiff 物件字面值，不跑 git、不解析字串。
// ---------------------------------------------------------------------------

/** context 行 */
function ctx(text, oldLine, newLine) {
  return { type: ' ', text, oldLine, newLine };
}

/** 新增行 */
function add(text, newLine) {
  return { type: '+', text, oldLine: null, newLine };
}

/** 刪除行 */
function del(text, oldLine) {
  return { type: '-', text, oldLine, newLine: null };
}

function hunk(newStart, lines, extra = {}) {
  return {
    oldStart: extra.oldStart ?? newStart,
    oldLines: extra.oldLines ?? lines.filter((l) => l.type !== '+').length,
    newStart,
    newLines: extra.newLines ?? lines.filter((l) => l.type !== '-').length,
    header: extra.header ?? '',
    lines,
  };
}

function fileDiff(path, hunks, extra = {}) {
  return {
    path,
    oldPath: extra.oldPath ?? null,
    status: extra.status ?? 'modified',
    hunks,
  };
}

// ---------------------------------------------------------------------------

describe('buildTree — 行歸屬與 segment 切割', () => {
  test('同一 function 內的三個 hunk → 三個獨立變更點，同屬一個 group', () => {
    const diffs = [
      fileDiff('src/a.js', [
        hunk(12, [ctx('keep', 11, 12), add('one', 13), ctx('keep2', 12, 14)]),
        hunk(20, [add('two', 20)]),
        hunk(30, [del('three', 28)]),
      ]),
    ];
    const ranges = { 'src/a.js': [{ name: 'foo', startLine: 10, endLine: 50 }] };

    const tree = buildTree(diffs, ranges);

    assert.equal(tree.length, 1);
    const file = tree[0];
    assert.equal(file.path, 'src/a.js');
    assert.equal(file.total, 3);
    assert.equal(file.groups.length, 1);

    const group = file.groups[0];
    assert.equal(group.name, 'foo');
    assert.equal(group.startLine, 10);
    assert.equal(group.endLine, 50);
    assert.equal(group.total, 3);
    assert.equal(group.changePoints.length, 3);

    assert.deepEqual(
      group.changePoints.map((cp) => [cp.hunkIndex, cp.newStart, cp.newEnd]),
      [
        [0, 12, 14],
        [1, 20, 20],
        [2, 30, 30],
      ],
    );
    for (const cp of group.changePoints) {
      assert.equal(cp.filePath, 'src/a.js');
      assert.equal(cp.functionName, 'foo');
    }
  });

  test('橫跨兩個 function 的 hunk → 拆成兩個變更點，各自歸屬正確 function', () => {
    const diffs = [
      fileDiff('src/a.js', [
        hunk(8, [add('a', 8), add('b', 9), add('c', 10), add('d', 11), add('e', 12)]),
      ]),
    ];
    const ranges = {
      'src/a.js': [
        { name: 'foo', startLine: 1, endLine: 10 },
        { name: 'bar', startLine: 11, endLine: 20 },
      ],
    };

    const file = buildTree(diffs, ranges)[0];

    assert.equal(file.total, 2);
    assert.equal(file.groups.length, 2);

    assert.equal(file.groups[0].name, 'foo');
    assert.equal(file.groups[0].total, 1);
    assert.equal(file.groups[0].changePoints[0].newStart, 8);
    assert.equal(file.groups[0].changePoints[0].newEnd, 10);
    assert.equal(file.groups[0].changePoints[0].hunkIndex, 0);
    assert.equal(file.groups[0].changePoints[0].diffText, '+a\n+b\n+c');

    assert.equal(file.groups[1].name, 'bar');
    assert.equal(file.groups[1].total, 1);
    assert.equal(file.groups[1].changePoints[0].newStart, 11);
    assert.equal(file.groups[1].changePoints[0].newEnd, 12);
    assert.equal(file.groups[1].changePoints[0].hunkIndex, 0);
    assert.equal(file.groups[1].changePoints[0].diffText, '+d\n+e');
  });

  test('不在任何 function 內的改動掛在檔案層（name: null）', () => {
    const diffs = [fileDiff('src/a.js', [hunk(1, [add('import x', 1)])])];
    const ranges = { 'src/a.js': [{ name: 'foo', startLine: 10, endLine: 20 }] };

    const file = buildTree(diffs, ranges)[0];

    assert.equal(file.groups.length, 1);
    assert.equal(file.groups[0].name, null);
    assert.equal(file.groups[0].startLine, null);
    assert.equal(file.groups[0].endLine, null);
    assert.equal(file.groups[0].total, 1);
    assert.equal(file.groups[0].changePoints[0].functionName, null);
    assert.equal(file.groups[0].changePoints[0].newStart, 1);
    assert.equal(file.groups[0].changePoints[0].newEnd, 1);
  });

  test('純 context 的 segment 不產生變更點', () => {
    const diffs = [
      fileDiff('src/a.js', [
        hunk(4, [
          add('a', 4),
          ctx('b', 4, 5),
          ctx('c', 5, 6),
          ctx('d', 6, 7),
          ctx('e', 7, 8),
          ctx('f', 8, 9),
          add('g', 10),
          ctx('h', 9, 11),
        ]),
      ]),
    ];
    const ranges = {
      'src/a.js': [
        { name: 'foo', startLine: 1, endLine: 5 },
        { name: 'bar', startLine: 10, endLine: 15 },
      ],
    };

    const file = buildTree(diffs, ranges)[0];

    // 中間 6..9 的純 context segment 被丟棄，不產生 null group
    assert.equal(file.total, 2);
    assert.equal(file.groups.length, 2);
    assert.equal(file.groups[0].name, 'foo');
    assert.equal(file.groups[0].changePoints[0].newStart, 4);
    assert.equal(file.groups[0].changePoints[0].newEnd, 5);
    assert.equal(file.groups[1].name, 'bar');
    assert.equal(file.groups[1].changePoints[0].newStart, 10);
    assert.equal(file.groups[1].changePoints[0].newEnd, 11);
  });

  test('範圍重疊時取最小的範圍（防禦）', () => {
    const diffs = [fileDiff('src/a.js', [hunk(15, [add('x', 15)])])];
    const ranges = {
      'src/a.js': [
        { name: 'outer', startLine: 1, endLine: 100 },
        { name: 'inner', startLine: 10, endLine: 20 },
      ],
    };

    const file = buildTree(diffs, ranges)[0];

    assert.equal(file.groups.length, 1);
    assert.equal(file.groups[0].name, 'inner');
    assert.equal(file.groups[0].startLine, 10);
    assert.equal(file.groups[0].endLine, 20);
  });
});

describe('buildTree — 刪除行的游標規則', () => {
  test('刪除行用當下 cursor 定位，且不推進 cursor', () => {
    const diffs = [
      fileDiff('src/a.js', [
        hunk(10, [
          ctx('a', 10, 10),
          del('b', 11),
          del('c', 12),
          add('d', 11),
          ctx('e', 13, 12),
        ]),
      ]),
    ];
    const ranges = { 'src/a.js': [{ name: 'foo', startLine: 1, endLine: 100 }] };

    const file = buildTree(diffs, ranges)[0];

    const cp = file.groups[0].changePoints[0];
    assert.equal(cp.newStart, 10);
    assert.equal(cp.newEnd, 12);
    assert.equal(cp.diffText, '-b\n-c\n+d');
  });

  test('純刪除的 segment newStart === newEnd', () => {
    const diffs = [
      fileDiff('src/a.js', [hunk(50, [del('gone1', 50), del('gone2', 51)])]),
    ];
    const ranges = { 'src/a.js': [{ name: 'foo', startLine: 1, endLine: 100 }] };

    const file = buildTree(diffs, ranges)[0];

    const cp = file.groups[0].changePoints[0];
    assert.equal(cp.newStart, 50);
    assert.equal(cp.newEnd, 50);
    assert.equal(cp.diffText, '-gone1\n-gone2');
  });

  test('刪除行落在 function 結尾之後 → 歸屬檔案層', () => {
    const diffs = [
      fileDiff('src/a.js', [hunk(10, [ctx('last', 10, 10), del('after', 11)])]),
    ];
    const ranges = { 'src/a.js': [{ name: 'foo', startLine: 1, endLine: 10 }] };

    const file = buildTree(diffs, ranges)[0];

    // context 行 (10) 屬 foo 但純 context → 丟棄；刪除行位置 11 → 檔案層
    assert.equal(file.total, 1);
    assert.equal(file.groups.length, 1);
    assert.equal(file.groups[0].name, null);
    assert.equal(file.groups[0].changePoints[0].newStart, 11);
    assert.equal(file.groups[0].changePoints[0].newEnd, 11);
  });

  test('非預期的 line.type（既非 "-" 也非 "+"/" "）被跳過，不會用 null newLine 污染 cursor', () => {
    const diffs = [
      fileDiff('src/a.js', [
        hunk(10, [
          ctx('keep', 10, 10),
          // 假設性的未來 line type：不是 '-'，也不是 '+' / ' '，且沒有 newLine。
          // 若程式碼用 `type !== '-'` 判斷，會把它當成 add/context 處理，
          // 讀到 undefined 的 newLine 並把 cursor 污染成 NaN，
          // 導致緊接著的刪除行位置也跟著錯。
          { type: '~', text: 'unexpected', oldLine: 11, newLine: null },
          del('gone', 11),
        ]),
      ]),
    ];
    const ranges = { 'src/a.js': [{ name: 'foo', startLine: 1, endLine: 100 }] };

    const file = buildTree(diffs, ranges)[0];

    const cp = file.groups[0].changePoints[0];
    // cursor 沒被污染：del 用的仍是 ctx 行推進後的正確位置 11。
    assert.equal(cp.newStart, 10);
    assert.equal(cp.newEnd, 11);
    assert.equal(cp.diffText, '-gone');
    // 未預期類型的行本身被跳過，不進入 segment.lines。
    assert.equal(cp.lines.some((line) => line.type === '~'), false);
  });
});

describe('buildTree — group 建立與排序', () => {
  test('檔案層改動散落在多個 function 前後時切成多個 null group，樹序 == 捲動序', () => {
    const diffs = [
      fileDiff('src/a.js', [
        hunk(5, [add('top', 5)]),
        hunk(15, [add('in-foo', 15)]),
        hunk(25, [add('between', 25)]),
        hunk(35, [add('in-bar', 35)]),
        hunk(45, [add('bottom', 45)]),
      ]),
    ];
    const ranges = {
      'src/a.js': [
        { name: 'foo', startLine: 10, endLine: 20 },
        { name: 'bar', startLine: 30, endLine: 40 },
      ],
    };

    const file = buildTree(diffs, ranges)[0];

    assert.equal(file.total, 5);
    assert.deepEqual(
      file.groups.map((g) => [g.name, g.total, g.changePoints[0].newStart]),
      [
        [null, 1, 5],
        ['foo', 1, 15],
        [null, 1, 25],
        ['bar', 1, 35],
        [null, 1, 45],
      ],
    );
  });

  test('連續的檔案層變更點合併為同一個 null group', () => {
    const diffs = [
      fileDiff('src/a.js', [
        hunk(1, [add('a', 1)]),
        hunk(3, [add('b', 3)]),
        hunk(15, [add('c', 15)]),
      ]),
    ];
    const ranges = { 'src/a.js': [{ name: 'foo', startLine: 10, endLine: 20 }] };

    const file = buildTree(diffs, ranges)[0];

    assert.equal(file.groups.length, 2);
    assert.equal(file.groups[0].name, null);
    assert.equal(file.groups[0].total, 2);
    assert.deepEqual(
      file.groups[0].changePoints.map((cp) => cp.newStart),
      [1, 3],
    );
    assert.equal(file.groups[1].name, 'foo');
    assert.equal(file.groups[1].total, 1);
  });

  test('同一 function 的變更點被其他 group 隔開時仍合併，排序用最小 newStart', () => {
    const diffs = [
      fileDiff('src/a.js', [
        hunk(15, [add('foo-1', 15)]),
        hunk(25, [add('outside', 25)]),
        hunk(18, [add('foo-2', 18)]),
      ]),
    ];
    const ranges = { 'src/a.js': [{ name: 'foo', startLine: 10, endLine: 20 }] };

    const file = buildTree(diffs, ranges)[0];

    assert.equal(file.total, 3);
    assert.equal(file.groups.length, 2);
    assert.equal(file.groups[0].name, 'foo');
    assert.equal(file.groups[0].total, 2);
    assert.deepEqual(
      file.groups[0].changePoints.map((cp) => cp.newStart),
      [15, 18],
    );
    assert.equal(file.groups[1].name, null);
    assert.equal(file.groups[1].changePoints[0].newStart, 25);
  });

  test('同名但不同範圍的兩個 function 不會被合併成一個 group', () => {
    const diffs = [
      fileDiff('src/a.js', [hunk(15, [add('a', 15)]), hunk(35, [add('b', 35)])]),
    ];
    const ranges = {
      'src/a.js': [
        { name: 'handle', startLine: 10, endLine: 20 },
        { name: 'handle', startLine: 30, endLine: 40 },
      ],
    };

    const file = buildTree(diffs, ranges)[0];

    assert.equal(file.total, 2);
    assert.deepEqual(
      file.groups.map((g) => [g.name, g.startLine, g.endLine, g.total]),
      [
        ['handle', 10, 20, 1],
        ['handle', 30, 40, 1],
      ],
    );
  });

  test('同名但不同範圍的兩個 function 被單一 hunk 橫跨時仍拆成兩個 segment（不比對名字，比對 range 物件 identity）', () => {
    const diffs = [
      fileDiff('src/a.js', [hunk(10, [add('a', 10), add('b', 21)])]),
    ];
    const ranges = {
      'src/a.js': [
        { name: 'handle', startLine: 1, endLine: 20 },
        { name: 'handle', startLine: 21, endLine: 40 },
      ],
    };

    const file = buildTree(diffs, ranges)[0];

    assert.equal(file.total, 2);
    assert.equal(file.groups.length, 2);

    assert.equal(file.groups[0].name, 'handle');
    assert.equal(file.groups[0].startLine, 1);
    assert.equal(file.groups[0].endLine, 20);
    assert.equal(file.groups[0].total, 1);
    assert.equal(file.groups[0].changePoints[0].newStart, 10);
    assert.equal(file.groups[0].changePoints[0].newEnd, 10);

    assert.equal(file.groups[1].name, 'handle');
    assert.equal(file.groups[1].startLine, 21);
    assert.equal(file.groups[1].endLine, 40);
    assert.equal(file.groups[1].total, 1);
    assert.equal(file.groups[1].changePoints[0].newStart, 21);
    assert.equal(file.groups[1].changePoints[0].newEnd, 21);
  });

  test('hunk 抵達順序非遞增時，groups 仍依 newStart 遞增排序', () => {
    const diffs = [
      fileDiff('src/a.js', [
        hunk(35, [add('in-bar', 35)]),
        hunk(5, [add('top', 5)]),
        hunk(15, [add('in-foo', 15)]),
      ]),
    ];
    const ranges = {
      'src/a.js': [
        { name: 'foo', startLine: 10, endLine: 20 },
        { name: 'bar', startLine: 30, endLine: 40 },
      ],
    };

    const file = buildTree(diffs, ranges)[0];

    assert.equal(file.total, 3);
    assert.deepEqual(
      file.groups.map((g) => g.name),
      [null, 'foo', 'bar'],
    );
    assert.deepEqual(
      file.groups.map((g) => g.changePoints[0].newStart),
      [5, 15, 35],
    );
  });

  test('排序鍵是「每個 group 最小的 newStart」，不是出現順序、也不是最大的 newStart', () => {
    // 刻意讓「插入順序」「依 min(newStart) 排序」「依 max(newStart) 排序」三種結果互不相同，
    // 這樣不管是刪掉 sort（=看插入順序）還是把排序鍵改成 max，測試都會抓到。
    // A：單一變更點 newStart=50（min=max=50），最先出現。
    // B：兩個變更點 newStart=10, 40（min=10, max=40），第二個出現。
    // C：單一變更點 newStart=25（min=max=25），nested 在 B 範圍內，第三個出現。
    const diffs = [
      fileDiff('src/a.js', [
        hunk(50, [add('a-only', 50)]),
        hunk(10, [add('b-1', 10)]),
        hunk(40, [add('b-2', 40)]),
        hunk(25, [add('c-only', 25)]),
      ]),
    ];
    const ranges = {
      'src/a.js': [
        { name: 'A', startLine: 45, endLine: 100 },
        { name: 'B', startLine: 1, endLine: 44 },
        { name: 'C', startLine: 21, endLine: 30 },
      ],
    };

    const file = buildTree(diffs, ranges)[0];

    assert.equal(file.total, 4);
    // 插入順序會是 [A, B, C]；依 max(newStart) 排序會是 [C(25), B(40), A(50)]。
    // 正確答案（依 min(newStart) 遞增）是 [B(10), C(25), A(50)]。
    assert.deepEqual(
      file.groups.map((g) => g.name),
      ['B', 'C', 'A'],
    );
    assert.deepEqual(
      file.groups.map((g) => g.total),
      [2, 1, 1],
    );
  });

  test('各層 total 正確加總', () => {
    const diffs = [
      fileDiff('src/a.js', [
        hunk(5, [add('a', 5)]),
        hunk(12, [add('b', 12), add('c', 13)]),
        hunk(16, [add('d', 16)]),
        hunk(31, [add('e', 31)]),
      ]),
    ];
    const ranges = {
      'src/a.js': [
        { name: 'foo', startLine: 10, endLine: 20 },
        { name: 'bar', startLine: 30, endLine: 40 },
      ],
    };

    const file = buildTree(diffs, ranges)[0];

    assert.equal(file.total, 4);
    assert.deepEqual(
      file.groups.map((g) => [g.name, g.total, g.changePoints.length]),
      [
        [null, 1, 1],
        ['foo', 2, 2],
        ['bar', 1, 1],
      ],
    );
    assert.equal(
      file.groups.reduce((sum, g) => sum + g.total, 0),
      file.total,
    );
  });
});

describe('buildTree — 降級與邊界情況', () => {
  test('rangesByPath 給 [] → 自動降級為兩層，每個 hunk 一個變更點', () => {
    const diffs = [
      fileDiff('README.md', [
        hunk(3, [add('a', 3)]),
        hunk(10, [del('b', 10)]),
      ]),
    ];

    const file = buildTree(diffs, { 'README.md': [] })[0];

    assert.equal(file.total, 2);
    assert.equal(file.groups.length, 1);
    assert.equal(file.groups[0].name, null);
    assert.equal(file.groups[0].startLine, null);
    assert.equal(file.groups[0].endLine, null);
    assert.deepEqual(
      file.groups[0].changePoints.map((cp) => [cp.hunkIndex, cp.newStart, cp.newEnd]),
      [
        [0, 3, 3],
        [1, 10, 10],
      ],
    );
  });

  test('rangesByPath 缺 key → 等同於 []', () => {
    const diffs = [fileDiff('styles.css', [hunk(7, [add('a', 7)])])];

    const file = buildTree(diffs, {})[0];

    assert.equal(file.total, 1);
    assert.equal(file.groups.length, 1);
    assert.equal(file.groups[0].name, null);
    assert.equal(file.groups[0].changePoints[0].functionName, null);
  });

  test('檔名剛好等於 Object.prototype 上的內建鍵（constructor / toString / __proto__）不會誤判為有效 ranges', () => {
    for (const path of ['constructor', 'toString', '__proto__']) {
      const diffs = [fileDiff(path, [hunk(1, [add('a', 1)])])];

      // rangesByPath 沒有這個檔案的「自有」鍵，但 {}['constructor'] 等
      // 會透過 prototype chain 取到內建、truthy 的值，若查表用 `[]` 存取
      // 就會誤判為「有 ranges」而非落到 `|| []` 的降級路徑。
      const file = buildTree(diffs, {})[0];

      assert.equal(file.path, path);
      assert.equal(file.total, 1);
      assert.equal(file.groups.length, 1);
      assert.equal(file.groups[0].name, null);
      assert.equal(file.groups[0].changePoints[0].functionName, null);
    }
  });

  test('binary 檔得到空 groups、total 0', () => {
    const diffs = [fileDiff('logo.png', [], { status: 'binary' })];

    const file = buildTree(diffs, {})[0];

    assert.equal(file.path, 'logo.png');
    assert.equal(file.status, 'binary');
    assert.deepEqual(file.groups, []);
    assert.equal(file.total, 0);
  });

  test('空的 fileDiffs → 空陣列', () => {
    assert.deepEqual(buildTree([], {}), []);
  });

  test('保留 path / oldPath / status 並維持檔案順序', () => {
    const diffs = [
      fileDiff('new.js', [hunk(1, [add('a', 1)])], { status: 'added' }),
      fileDiff('moved.js', [hunk(1, [add('b', 1)])], {
        status: 'renamed',
        oldPath: 'old.js',
      }),
      fileDiff('gone.js', [hunk(1, [del('c', 1)])], { status: 'deleted' }),
    ];

    const tree = buildTree(diffs, {});

    assert.deepEqual(
      tree.map((f) => [f.path, f.oldPath, f.status, f.total]),
      [
        ['new.js', null, 'added', 1],
        ['moved.js', 'old.js', 'renamed', 1],
        ['gone.js', null, 'deleted', 1],
      ],
    );
  });
});

describe('buildTree — ChangePoint 內容', () => {
  test('lines 含夾在其中的 context，diffText 只含變更行且帶 +/- 前綴', () => {
    const diffs = [
      fileDiff('src/a.js', [
        hunk(10, [
          ctx('unchanged-1', 10, 10),
          add('added-1', 11),
          ctx('unchanged-2', 11, 12),
          del('removed-1', 12),
          add('added-2', 13),
        ]),
      ]),
    ];
    const ranges = { 'src/a.js': [{ name: 'foo', startLine: 1, endLine: 100 }] };

    const cp = buildTree(diffs, ranges)[0].groups[0].changePoints[0];

    assert.equal(cp.lines.length, 5);
    assert.deepEqual(
      cp.lines.map((l) => l.type),
      [' ', '+', ' ', '-', '+'],
    );
    assert.equal(cp.diffText, '+added-1\n-removed-1\n+added-2');
    assert.equal(cp.diffText.includes('unchanged'), false);
    assert.match(cp.diffText, /^[+-]/);
  });

  test('ChangePoint 不含 checked / comment / hash 欄位', () => {
    const diffs = [fileDiff('src/a.js', [hunk(1, [add('a', 1)])])];

    const cp = buildTree(diffs, {})[0].groups[0].changePoints[0];

    assert.deepEqual(Object.keys(cp).sort(), [
      'diffText',
      'filePath',
      'functionName',
      'hunkIndex',
      'lines',
      'newEnd',
      'newStart',
    ]);
  });
});

describe('buildTree — 純函式', () => {
  test('不修改傳入的 fileDiffs 與 rangesByPath', () => {
    const diffs = [
      fileDiff('src/a.js', [
        hunk(5, [add('a', 5)]),
        hunk(15, [ctx('c', 15, 15), del('b', 16), add('d', 16)]),
      ]),
      fileDiff('logo.png', [], { status: 'binary' }),
    ];
    const ranges = {
      'src/a.js': [
        { name: 'bar', startLine: 30, endLine: 40 },
        { name: 'foo', startLine: 10, endLine: 20 },
      ],
    };

    const diffsBefore = structuredClone(diffs);
    const rangesBefore = structuredClone(ranges);

    buildTree(diffs, ranges);

    assert.deepEqual(diffs, diffsBefore);
    assert.deepEqual(ranges, rangesBefore);
  });
});
