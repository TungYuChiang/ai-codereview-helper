import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { toClaudePrompt, toMarkdown } from '../export.js';

// ---------------------------------------------------------------------------
// Fixture helpers — hand-built annotate()-shaped AnnotatedFileNode /
// GroupNode / ChangePoint (export.js must NOT import model.js/state.js, so
// these are literal object shapes matching model.js + state.js's annotate()
// output, per the brief).
// ---------------------------------------------------------------------------

function annotatedChangePoint(overrides = {}) {
  return {
    filePath: 'web/sims/js/selector.js',
    functionName: 'processMVPF',
    hunkIndex: 0,
    newStart: 20,
    newEnd: 22,
    lines: [
      { type: ' ', text: 'function processMVPF(mvpf) {', oldLine: 19, newLine: 20 },
      { type: '-', text: 'if(!mvpf) return;', oldLine: 20, newLine: null },
      { type: '+', text: 'if(!mvpf) return [];', oldLine: null, newLine: 21 },
    ],
    diffText: '-if(!mvpf) return;\n+if(!mvpf) return [];',
    id: 'abc123deadbeef01',
    checked: true,
    comment: null,
    ...overrides,
  };
}

function annotatedGroup(overrides = {}) {
  const changePoints = overrides.changePoints ?? [annotatedChangePoint()];
  const { changePoints: _omit, ...rest } = overrides;
  return {
    name: 'processMVPF',
    startLine: 15,
    endLine: 25,
    changePoints,
    total: changePoints.length,
    checked: 0,
    allChecked: false,
    ...rest,
  };
}

function annotatedFile(overrides = {}) {
  const groups = overrides.groups ?? [annotatedGroup()];
  const { groups: _omit, ...rest } = overrides;
  return {
    path: 'web/sims/js/selector.js',
    oldPath: null,
    status: 'modified',
    groups,
    total: groups.reduce((sum, g) => sum + g.total, 0),
    checked: 0,
    allChecked: false,
    ...rest,
  };
}

function longestBacktickRun(text) {
  const runs = text.match(/`+/g) ?? [];
  return runs.reduce((max, run) => Math.max(max, run.length), 0);
}

function baseCtx(overrides = {}) {
  return {
    repoName: 'ragic',
    repoPath: '/Users/dev/repos/ragic',
    base: 'dev',
    target: 'fix/21839',
    date: '2026-07-20',
    files: [],
    orphans: [],
    stats: { total: 0, checked: 0, comments: 0 },
    sources: {},
    ...overrides,
  };
}

const SELECTOR_SOURCE = [
  '// line 1',
  '// line 2',
  '// line 3',
  '// line 4',
  '// line 5',
  'function processMVPF(mvpf) {', // line 6
  '  doSomething();', // line 7
  '  return null;', // line 8
  '}', // line 9
  '// line 10',
].join('\n');

// ---------------------------------------------------------------------------
// toClaudePrompt
// ---------------------------------------------------------------------------

describe('toClaudePrompt', () => {
  test('includes the absolute file path for a commented change point', () => {
    const ctx = baseCtx({
      files: [
        annotatedFile({
          groups: [
            annotatedGroup({
              changePoints: [annotatedChangePoint({ comment: 'why does this change?' })],
            }),
          ],
        }),
      ],
    });

    const prompt = toClaudePrompt(ctx);
    assert.ok(
      prompt.includes('/Users/dev/repos/ragic/web/sims/js/selector.js'),
      'expected absolute path to appear',
    );
  });

  test('includes the function name and its line range for a commented change point', () => {
    const ctx = baseCtx({
      files: [
        annotatedFile({
          groups: [
            annotatedGroup({
              name: 'processMVPF',
              startLine: 15,
              endLine: 25,
              changePoints: [annotatedChangePoint({ comment: 'check this' })],
            }),
          ],
        }),
      ],
    });

    const prompt = toClaudePrompt(ctx);
    assert.ok(prompt.includes('processMVPF'), 'expected function name to appear');
    assert.ok(prompt.includes('15'), 'expected startLine to appear');
    assert.ok(prompt.includes('25'), 'expected endLine to appear');
  });

  test('includes the full function source sliced from sources[path] by group startLine..endLine', () => {
    const ctx = baseCtx({
      files: [
        annotatedFile({
          groups: [
            annotatedGroup({
              name: 'processMVPF',
              startLine: 6,
              endLine: 9,
              changePoints: [annotatedChangePoint({ comment: 'check this' })],
            }),
          ],
        }),
      ],
      sources: { 'web/sims/js/selector.js': SELECTOR_SOURCE },
    });

    const prompt = toClaudePrompt(ctx);
    assert.ok(prompt.includes('function processMVPF(mvpf) {'), 'expected sliced source start line');
    assert.ok(prompt.includes('  doSomething();'), 'expected sliced source middle line');
    assert.ok(prompt.includes('}'), 'expected sliced source end line');
    // Lines outside the slice must not appear.
    assert.ok(!prompt.includes('// line 1'), 'lines before startLine must be excluded');
    assert.ok(!prompt.includes('// line 10'), 'lines after endLine must be excluded');
  });

  test('includes the diff with +/-/space prefixes taken from `lines`', () => {
    const ctx = baseCtx({
      files: [
        annotatedFile({
          groups: [
            annotatedGroup({
              changePoints: [
                annotatedChangePoint({
                  comment: 'check this',
                  lines: [
                    { type: ' ', text: 'function processMVPF(mvpf) {', oldLine: 19, newLine: 20 },
                    { type: '-', text: 'if(!mvpf) return;', oldLine: 20, newLine: null },
                    { type: '+', text: 'if(!mvpf) return [];', oldLine: null, newLine: 21 },
                  ],
                }),
              ],
            }),
          ],
        }),
      ],
    });

    const prompt = toClaudePrompt(ctx);
    assert.ok(prompt.includes(' function processMVPF(mvpf) {'), 'expected space-prefixed context line');
    assert.ok(prompt.includes('-if(!mvpf) return;'), 'expected minus-prefixed line');
    assert.ok(prompt.includes('+if(!mvpf) return [];'), 'expected plus-prefixed line');
  });

  test('includes the user comment text', () => {
    const ctx = baseCtx({
      files: [
        annotatedFile({
          groups: [
            annotatedGroup({
              changePoints: [annotatedChangePoint({ comment: '回傳型別變了，caller 都改到了嗎？' })],
            }),
          ],
        }),
      ],
    });

    const prompt = toClaudePrompt(ctx);
    assert.ok(prompt.includes('回傳型別變了，caller 都改到了嗎？'));
  });

  test('excludes change points without a comment', () => {
    const commented = annotatedChangePoint({
      comment: 'please check',
      diffText: '+commented-line',
      lines: [{ type: '+', text: 'commented-line', oldLine: null, newLine: 20 }],
    });
    const uncommented = annotatedChangePoint({
      comment: null,
      newStart: 40,
      newEnd: 41,
      diffText: '+uncommented-line-should-not-appear',
      lines: [{ type: '+', text: 'uncommented-line-should-not-appear', oldLine: null, newLine: 40 }],
    });

    const ctx = baseCtx({
      files: [
        annotatedFile({
          groups: [annotatedGroup({ changePoints: [commented, uncommented] })],
        }),
      ],
    });

    const prompt = toClaudePrompt(ctx);
    assert.ok(prompt.includes('commented-line'));
    assert.ok(!prompt.includes('uncommented-line-should-not-appear'));
  });

  test('omits function name/line-range/source for a file-level change point (name null)', () => {
    const ctx = baseCtx({
      files: [
        annotatedFile({
          groups: [
            annotatedGroup({
              name: null,
              startLine: null,
              endLine: null,
              changePoints: [
                annotatedChangePoint({
                  functionName: null,
                  comment: 'file-level question',
                  diffText: '+top level change',
                  lines: [{ type: '+', text: 'top level change', oldLine: null, newLine: 1 }],
                }),
              ],
            }),
          ],
        }),
      ],
      sources: { 'web/sims/js/selector.js': SELECTOR_SOURCE },
    });

    const prompt = toClaudePrompt(ctx);
    assert.ok(prompt.includes('file-level question'), 'comment must still appear');
    assert.ok(!prompt.includes('function processMVPF'), 'no function source should be sliced for file-level points');
  });

  test('does not throw and omits the source section when sources[path] is missing', () => {
    const ctx = baseCtx({
      files: [
        annotatedFile({
          groups: [
            annotatedGroup({
              changePoints: [annotatedChangePoint({ comment: 'no source available' })],
            }),
          ],
        }),
      ],
      sources: {},
    });

    let prompt;
    assert.doesNotThrow(() => {
      prompt = toClaudePrompt(ctx);
    });
    assert.ok(prompt.includes('no source available'));
  });

  test('lists orphan comments in a separate section, noting they are no longer in the diff', () => {
    const ctx = baseCtx({
      orphans: [
        {
          key: 'orphankey1234567',
          text: 'double-check the token expiry',
          updatedAt: '2026-07-19T10:00:00.000Z',
          filePath: 'src/auth.js',
          functionName: 'handleLogin',
          diffText: '+const token = signToken(user);',
        },
      ],
    });

    const prompt = toClaudePrompt(ctx);
    assert.ok(prompt.includes('src/auth.js'));
    assert.ok(prompt.includes('handleLogin'));
    assert.ok(prompt.includes('+const token = signToken(user);'));
    assert.ok(prompt.includes('double-check the token expiry'));
    assert.ok(prompt.includes('不在') || prompt.includes('no longer') || prompt.includes('not in'), 'expected a note that the change point is no longer in the current diff');
  });

  test('does not claim there are no comments when an orphan carries a real comment (finding 1)', () => {
    const ctx = baseCtx({
      files: [
        annotatedFile({
          groups: [annotatedGroup({ changePoints: [annotatedChangePoint({ comment: null })] })],
        }),
      ],
      orphans: [
        {
          key: 'orphankey1234567',
          text: 'this is a real orphaned comment',
          updatedAt: '2026-07-19T10:00:00.000Z',
          filePath: 'src/gone.js',
          functionName: 'deletedFn',
          diffText: '+this code no longer exists',
        },
      ],
    });

    const prompt = toClaudePrompt(ctx);
    assert.ok(
      !prompt.includes('這次 review 沒有留下任何疑問'),
      'must not claim there are no questions when an orphan comment exists',
    );
    assert.ok(prompt.includes('this is a real orphaned comment'));
  });

  test('wraps function source in a fence long enough to survive embedded triple-backtick content (finding 2)', () => {
    const sourceWithFence = [
      'function weird() {',
      '  const example = `template ```nested``` end`;',
      '  return example;',
      '}',
    ].join('\n');

    const ctx = baseCtx({
      files: [
        annotatedFile({
          groups: [
            annotatedGroup({
              name: 'weird',
              startLine: 1,
              endLine: 4,
              changePoints: [annotatedChangePoint({ comment: 'check the fence', functionName: 'weird' })],
            }),
          ],
        }),
      ],
      sources: { 'web/sims/js/selector.js': sourceWithFence },
    });

    const prompt = toClaudePrompt(ctx);
    const match = prompt.match(/Function 原始碼：\n(`+)\n/);
    assert.ok(match, 'expected a fenced code block after the source label');
    const fenceLength = match[1].length;
    const longestInner = longestBacktickRun(sourceWithFence);
    assert.ok(
      fenceLength > longestInner,
      `fence length ${fenceLength} must exceed the longest embedded backtick run ${longestInner}`,
    );
  });

  test('wraps the diff block in a fence long enough to survive embedded backtick content (finding 2)', () => {
    const trickyText = 'const s = `a ```b``` c`;';
    const ctx = baseCtx({
      files: [
        annotatedFile({
          groups: [
            annotatedGroup({
              changePoints: [
                annotatedChangePoint({
                  comment: 'check this diff',
                  lines: [{ type: '+', text: trickyText, oldLine: null, newLine: 5 }],
                }),
              ],
            }),
          ],
        }),
      ],
    });

    const prompt = toClaudePrompt(ctx);
    const match = prompt.match(/Diff：\n(`+)diff\n/);
    assert.ok(match, 'expected a fenced diff block after the diff label');
    const fenceLength = match[1].length;
    const longestInner = longestBacktickRun(`+${trickyText}`);
    assert.ok(
      fenceLength > longestInner,
      `fence length ${fenceLength} must exceed the longest embedded backtick run ${longestInner}`,
    );
  });

  test('wraps orphan diff snapshots in a fence long enough to survive embedded backtick content (finding 2)', () => {
    const trickyDiff = '+const s = `a ```b``` c`;';
    const ctx = baseCtx({
      orphans: [
        {
          key: 'k1',
          text: 'orphan text',
          updatedAt: '2026-07-19T10:00:00.000Z',
          filePath: 'src/gone.js',
          functionName: 'deletedFn',
          diffText: trickyDiff,
        },
      ],
    });

    const prompt = toClaudePrompt(ctx);
    const match = prompt.match(/Diff 快照：\n(`+)diff\n/);
    assert.ok(match, 'expected a fenced diff block after the orphan diff snapshot label');
    const fenceLength = match[1].length;
    const longestInner = longestBacktickRun(trickyDiff);
    assert.ok(
      fenceLength > longestInner,
      `fence length ${fenceLength} must exceed the longest embedded backtick run ${longestInner}`,
    );
  });

  test('returns a non-empty explanatory string when there are no comments at all, without throwing', () => {
    const ctx = baseCtx({
      files: [annotatedFile({ groups: [annotatedGroup({ changePoints: [annotatedChangePoint({ comment: null })] })] })],
      orphans: [],
    });

    let prompt;
    assert.doesNotThrow(() => {
      prompt = toClaudePrompt(ctx);
    });
    assert.equal(typeof prompt, 'string');
    assert.ok(prompt.length > 0);
  });

  test('is a pure function: does not mutate ctx', () => {
    const ctx = baseCtx({
      files: [
        annotatedFile({
          groups: [annotatedGroup({ changePoints: [annotatedChangePoint({ comment: 'check' })] })],
        }),
      ],
      orphans: [
        {
          key: 'k',
          text: 'orphan text',
          updatedAt: '2026-07-19T10:00:00.000Z',
          filePath: 'src/auth.js',
          functionName: null,
          diffText: '+x',
        },
      ],
      sources: { 'web/sims/js/selector.js': SELECTOR_SOURCE },
    });
    const before = structuredClone(ctx);

    toClaudePrompt(ctx);

    assert.deepEqual(ctx, before);
  });
});

// ---------------------------------------------------------------------------
// toMarkdown
// ---------------------------------------------------------------------------

describe('toMarkdown', () => {
  test('header line has the form "# Review: <repoName>  <base>...<target>"', () => {
    const ctx = baseCtx({ repoName: 'ragic', base: 'dev', target: 'fix/21839' });
    const md = toMarkdown(ctx);
    assert.ok(md.includes('# Review: ragic  dev...fix/21839'));
  });

  test('stats line reports date, total, checked, and comment counts from ctx.stats', () => {
    const ctx = baseCtx({
      date: '2026-07-20',
      stats: { total: 19, checked: 19, comments: 3 },
    });
    const md = toMarkdown(ctx);
    assert.ok(md.includes('2026-07-20'));
    assert.ok(md.includes('19'));
    assert.ok(md.includes('3'));
  });

  test('emits a file heading and a function heading with (+newStart..newEnd) for a commented change point', () => {
    const ctx = baseCtx({
      files: [
        annotatedFile({
          path: 'web/sims/js/selector.js',
          groups: [
            annotatedGroup({
              name: 'processMVPF',
              changePoints: [
                annotatedChangePoint({
                  newStart: 3020,
                  newEnd: 3031,
                  comment: 'check this',
                }),
              ],
            }),
          ],
        }),
      ],
    });

    const md = toMarkdown(ctx);
    assert.ok(md.includes('## web/sims/js/selector.js'));
    assert.ok(md.includes('### processMVPF  (+3020..3031)'));
  });

  test('quotes the diff lines (from diffText) with "> " and places the comment after a blank line', () => {
    const ctx = baseCtx({
      files: [
        annotatedFile({
          groups: [
            annotatedGroup({
              changePoints: [
                annotatedChangePoint({
                  diffText: '-if(!mvpf) return;\n+if(!mvpf) return [];',
                  comment: '回傳型別變了，caller 都改到了嗎？',
                }),
              ],
            }),
          ],
        }),
      ],
    });

    const md = toMarkdown(ctx);
    assert.ok(md.includes('> -if(!mvpf) return;'));
    assert.ok(md.includes('> +if(!mvpf) return [];'));
    assert.ok(md.includes('回傳型別變了，caller 都改到了嗎？'));

    const quoteIdx = md.indexOf('> +if(!mvpf) return [];');
    const commentIdx = md.indexOf('回傳型別變了，caller 都改到了嗎？');
    assert.ok(commentIdx > quoteIdx, 'comment should appear after the quoted diff');
  });

  test('a file-level change point (name null) uses "(檔案層)" as its function label', () => {
    const ctx = baseCtx({
      files: [
        annotatedFile({
          groups: [
            annotatedGroup({
              name: null,
              startLine: null,
              endLine: null,
              changePoints: [
                annotatedChangePoint({
                  functionName: null,
                  newStart: 5,
                  newEnd: 5,
                  comment: 'file-level question',
                  diffText: '+import x from "y";',
                }),
              ],
            }),
          ],
        }),
      ],
    });

    const md = toMarkdown(ctx);
    assert.ok(md.includes('### (檔案層)  (+5..5)'));
    assert.ok(md.includes('file-level question'));
  });

  test('change points without a comment are not listed', () => {
    const commented = annotatedChangePoint({ comment: 'keep me', diffText: '+kept' });
    const uncommented = annotatedChangePoint({
      comment: null,
      newStart: 99,
      newEnd: 100,
      diffText: '+drop-me-not-listed',
    });

    const ctx = baseCtx({
      files: [
        annotatedFile({
          groups: [annotatedGroup({ changePoints: [commented, uncommented] })],
        }),
      ],
    });

    const md = toMarkdown(ctx);
    assert.ok(md.includes('kept'));
    assert.ok(!md.includes('drop-me-not-listed'));
  });

  test('a file with no commented change points does not get a heading at all', () => {
    const ctx = baseCtx({
      files: [
        annotatedFile({
          path: 'src/silent.js',
          groups: [annotatedGroup({ changePoints: [annotatedChangePoint({ comment: null })] })],
        }),
      ],
    });

    const md = toMarkdown(ctx);
    assert.ok(!md.includes('## src/silent.js'));
  });

  test('orphan comments get their own "## 孤兒 comment" section', () => {
    const ctx = baseCtx({
      orphans: [
        {
          key: 'orphankey1234567',
          text: 'this code is gone now',
          updatedAt: '2026-07-19T10:00:00.000Z',
          filePath: 'src/gone.js',
          functionName: 'deletedFn',
          diffText: '+this code no longer exists',
        },
      ],
    });

    const md = toMarkdown(ctx);
    assert.ok(md.includes('## 孤兒 comment'));
    assert.ok(md.includes('src/gone.js'));
    assert.ok(md.includes('deletedFn'));
    assert.ok(md.includes('this code is gone now'));
  });

  test('does not claim there are no comments when an orphan carries a real comment (finding 1)', () => {
    const ctx = baseCtx({
      files: [
        annotatedFile({
          groups: [annotatedGroup({ changePoints: [annotatedChangePoint({ comment: null })] })],
        }),
      ],
      orphans: [
        {
          key: 'orphankey1234567',
          text: 'this is a real orphaned comment',
          updatedAt: '2026-07-19T10:00:00.000Z',
          filePath: 'src/gone.js',
          functionName: 'deletedFn',
          diffText: '+this code no longer exists',
        },
      ],
      stats: { total: 0, checked: 0, comments: 1 },
    });

    const md = toMarkdown(ctx);
    assert.ok(
      !md.includes('這次 review 沒有留下 comment。'),
      'must not claim there are no comments when an orphan comment exists',
    );
    assert.ok(md.includes('## 孤兒 comment'));
    assert.ok(md.includes('this is a real orphaned comment'));
  });

  test('with multiple files, only files containing a commented change point get a heading (finding 3)', () => {
    const commentedFile = annotatedFile({
      path: 'web/sims/js/selector.js',
      groups: [annotatedGroup({ changePoints: [annotatedChangePoint({ comment: 'keep me' })] })],
    });
    const silentFile = annotatedFile({
      path: 'src/silent.js',
      groups: [annotatedGroup({ changePoints: [annotatedChangePoint({ comment: null })] })],
    });

    const ctx = baseCtx({ files: [commentedFile, silentFile] });
    const md = toMarkdown(ctx);

    assert.ok(md.includes('## web/sims/js/selector.js'), 'file with a commented change point should get a heading');
    assert.ok(!md.includes('## src/silent.js'), 'file with no commented change points should not get a heading');
  });

  test('with no comments anywhere, still outputs the header and stats line, plus a note, not an empty string', () => {
    const ctx = baseCtx({
      files: [annotatedFile({ groups: [annotatedGroup({ changePoints: [annotatedChangePoint({ comment: null })] })] })],
      stats: { total: 1, checked: 1, comments: 0 },
      orphans: [],
    });

    const md = toMarkdown(ctx);
    assert.ok(md.includes('# Review: ragic  dev...fix/21839'));
    assert.equal(typeof md, 'string');
    assert.ok(md.length > 0);
    assert.ok(!md.includes('###'), 'no change-point headings should appear when nothing is commented');
  });

  test('is a pure function: does not mutate ctx', () => {
    const ctx = baseCtx({
      files: [
        annotatedFile({
          groups: [annotatedGroup({ changePoints: [annotatedChangePoint({ comment: 'check' })] })],
        }),
      ],
      orphans: [
        {
          key: 'k',
          text: 'orphan text',
          updatedAt: '2026-07-19T10:00:00.000Z',
          filePath: 'src/auth.js',
          functionName: null,
          diffText: '+x',
        },
      ],
    });
    const before = structuredClone(ctx);

    toMarkdown(ctx);

    assert.deepEqual(ctx, before);
  });
});
