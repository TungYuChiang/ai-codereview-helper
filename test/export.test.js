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
    note: null,
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

  test('includes the function name for a commented change point', () => {
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
  });

  test('does not include the enclosing function source, even when ctx.sources has it (finding: slim export)', () => {
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
    // The diff/comment text is allowed to mention the function, but none of
    // the *other* lines of the function body (never referenced by the diff
    // or comment) may leak in -- that would mean the full source got
    // embedded again.
    assert.ok(!prompt.includes('doSomething()'), 'function body statement must not appear');
    assert.ok(!prompt.includes('Function 原始碼'), 'the "function source" label must not appear at all');
    assert.ok(!prompt.includes('// line 1'), 'unrelated source lines must not appear');
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

  test('a note-only change point (no comment) still stays out of the Claude prompt', () => {
    const noteOnly = annotatedChangePoint({
      comment: null,
      note: 'this is just a note to self, not a question',
      diffText: '+note-only-line-should-not-appear',
      lines: [{ type: '+', text: 'note-only-line-should-not-appear', oldLine: null, newLine: 20 }],
    });

    const ctx = baseCtx({
      files: [annotatedFile({ groups: [annotatedGroup({ changePoints: [noteOnly] })] })],
    });

    const prompt = toClaudePrompt(ctx);
    assert.ok(!prompt.includes('note-only-line-should-not-appear'), 'note-only diff must not appear');
    assert.ok(!prompt.includes('this is just a note to self'), 'note text must never reach the Claude prompt');
    assert.ok(
      prompt.includes('這次 review 沒有留下任何 comment'),
      'a note-only review (no comments, no orphans) has no real questions to send',
    );
  });

  test('never includes orphan content in the Claude prompt, even when a live commented entry also exists', () => {
    const ctx = baseCtx({
      files: [
        annotatedFile({
          groups: [
            annotatedGroup({ changePoints: [annotatedChangePoint({ comment: 'a live, real question' })] }),
          ],
        }),
      ],
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
    assert.ok(prompt.includes('a live, real question'), 'the live entry must still be there');
    assert.ok(!prompt.includes('src/auth.js'), 'orphan file path must not leak into the Claude prompt');
    assert.ok(!prompt.includes('handleLogin'), 'orphan function name must not leak into the Claude prompt');
    assert.ok(
      !prompt.includes('double-check the token expiry'),
      'orphan comment text must not leak into the Claude prompt',
    );
    assert.ok(
      !prompt.includes('+const token = signToken(user);'),
      'orphan diff snapshot must not leak into the Claude prompt',
    );
  });

  test('a review whose only annotations are orphans produces a sensible, non-misleading note (not empty, not "no questions")', () => {
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
      !prompt.includes('這次 review 沒有留下任何 comment'),
      'must not claim there are no questions when a comment did exist, just orphaned',
    );
    // Orphans are dropped from this export entirely -- the point of this
    // test is that the *absence* of the orphan's content is explained, not
    // that the content itself shows up here (that's the Markdown export's
    // job).
    assert.ok(!prompt.includes('this is a real orphaned comment'), 'orphan comment text must not appear');
    assert.ok(!prompt.includes('src/gone.js'), 'orphan file path must not appear');
    assert.ok(prompt.length > 0);
    assert.notEqual(prompt.trim(), '');
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

  test('a review with no annotations at all (no comments, no orphans) returns the "no questions" note, not the orphans-only note', () => {
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
    assert.ok(prompt.includes('這次 review 沒有留下任何 comment'), 'expected the plain "no questions" note');
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

  test('orphan comments get their own history section', () => {
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
    assert.ok(md.includes('## 歷史 comment'));
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
    assert.ok(md.includes('## 歷史 comment'));
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

// ---------------------------------------------------------------------------
// Anchored comments — a comment pointing at ONE line (or a run of lines)
// inside a change point. The whole point of the feature is that the exported
// prompt POINTS at something instead of gesturing at it, so these tests are
// about what the reader can actually tell from the text.
// ---------------------------------------------------------------------------

// A change point big enough that "here" is genuinely ambiguous without an
// anchor. diffText holds the changed lines only (model.js), while `lines`
// also carries context -- exactly the real shape.
function bigChangePoint(overrides = {}) {
  return annotatedChangePoint({
    newStart: 20,
    newEnd: 26,
    lines: [
      { type: ' ', text: 'function processMVPF(mvpf) {', oldLine: 19, newLine: 20 },
      { type: '-', text: '  if(!mvpf) return;', oldLine: 20, newLine: null },
      { type: '+', text: '  if(!mvpf) return [];', oldLine: null, newLine: 21 },
      { type: ' ', text: '  const node = lookup(mvpf);', oldLine: 21, newLine: 22 },
      { type: '+', text: '  const nm = node.getAttribute("name");', oldLine: null, newLine: 23 },
      { type: '+', text: '  if (!nm) return null;', oldLine: null, newLine: 24 },
      { type: ' ', text: '  return build(nm);', oldLine: 22, newLine: 25 },
    ],
    diffText: [
      '-  if(!mvpf) return;',
      '+  if(!mvpf) return [];',
      '+  const nm = node.getAttribute("name");',
      '+  if (!nm) return null;',
    ].join('\n'),
    ...overrides,
  });
}

function anchoredCtx(anchoredComments, cpOverrides = {}) {
  return baseCtx({
    files: [
      annotatedFile({
        groups: [
          annotatedGroup({
            name: 'processMVPF',
            changePoints: [bigChangePoint({ anchoredComments, ...cpOverrides })],
          }),
        ],
      }),
    ],
  });
}

describe('toClaudePrompt — anchored comments', () => {
  test('quotes the exact anchored line, on its own, so nothing has to be searched for', () => {
    const prompt = toClaudePrompt(
      anchoredCtx([{ anchorStart: 3, anchorEnd: 3, text: 'is nm always set here?' }]),
    );

    assert.ok(prompt.includes('is nm always set here?'), 'the comment itself must appear');
    // The anchored line, isolated in its own fenced block.
    assert.ok(
      /```diff\n\+  if \(!nm\) return null;\n```/.test(prompt),
      `expected the anchored line alone in its own fence:\n${prompt}`,
    );
  });

  test('names the file line the anchor points at, so the reader can open it directly', () => {
    const prompt = toClaudePrompt(
      anchoredCtx([{ anchorStart: 3, anchorEnd: 3, text: 'is nm always set here?' }]),
    );
    // `+  if (!nm) return null;` is newLine 24 in the fixture.
    assert.ok(prompt.includes('第 24 行'), `expected the file line number:\n${prompt}`);
  });

  test('a multi-line anchor quotes every line it covers, and names the whole range', () => {
    const prompt = toClaudePrompt(
      anchoredCtx([{ anchorStart: 2, anchorEnd: 3, text: 'both of these' }]),
    );

    assert.ok(
      /```diff\n\+  const nm = node\.getAttribute\("name"\);\n\+  if \(!nm\) return null;\n```/.test(prompt),
      `expected both anchored lines alone in one fence:\n${prompt}`,
    );
    assert.ok(prompt.includes('第 23-24 行'), `expected the file line range:\n${prompt}`);
  });

  test('marks the anchored lines inside the full diff, so the surrounding context is still readable', () => {
    const prompt = toClaudePrompt(
      anchoredCtx([{ anchorStart: 3, anchorEnd: 3, text: 'is nm always set here?' }]),
    );

    // Every diff line is still present...
    assert.ok(prompt.includes('function processMVPF(mvpf) {'), 'context line must survive');
    // ...but only the anchored one carries the pointer marker.
    assert.ok(prompt.includes('» +  if (!nm) return null;'), `expected the anchored line marked:\n${prompt}`);
    assert.ok(
      prompt.includes('  +  const nm = node.getAttribute("name");'),
      'a non-anchored line must be padded to the marker width, not marked',
    );
    assert.equal(
      (prompt.match(/^» /gm) ?? []).length,
      1,
      'exactly one diff line may carry the marker',
    );
  });

  test('an anchor on a deleted line is labelled as the OLD file line, never a new one', () => {
    const prompt = toClaudePrompt(
      anchoredCtx([{ anchorStart: 0, anchorEnd: 0, text: 'why drop the early return?' }]),
    );
    // '-  if(!mvpf) return;' is oldLine 20 and has no new-side line at all.
    assert.ok(prompt.includes('舊版第 20 行'), `expected an old-side label:\n${prompt}`);
  });

  test('several anchored comments on one change point each get their own entry', () => {
    const prompt = toClaudePrompt(
      anchoredCtx([
        { anchorStart: 1, anchorEnd: 1, text: 'first question' },
        { anchorStart: 3, anchorEnd: 3, text: 'second question' },
      ]),
    );

    assert.ok(prompt.includes('first question'));
    assert.ok(prompt.includes('second question'));
    assert.ok(prompt.includes('## 1.'), 'expected a numbered entry');
    assert.ok(prompt.includes('## 2.'), 'expected a SECOND numbered entry');
    assert.ok(!prompt.includes('## 3.'), 'and no more than two');
  });

  test('an unanchored comment on the same change point still gets its own, unmarked entry', () => {
    const prompt = toClaudePrompt(
      anchoredCtx([{ anchorStart: 3, anchorEnd: 3, text: 'anchored question' }], {
        comment: 'whole-block question',
      }),
    );

    assert.ok(prompt.includes('whole-block question'));
    assert.ok(prompt.includes('anchored question'));
    assert.ok(prompt.includes('## 2.'), 'two entries, one per comment');
    // The unanchored entry must be rendered exactly as it always was: no
    // pointer marker, no anchored-lines block.
    const unanchoredEntry = prompt.split('\n---\n').find((s) => s.includes('whole-block question'));
    assert.ok(!unanchoredEntry.includes('»'), 'the unanchored entry must carry no anchor marker');
  });

  test('a change point whose ONLY annotation is anchored still reaches the prompt', () => {
    const prompt = toClaudePrompt(
      anchoredCtx([{ anchorStart: 3, anchorEnd: 3, text: 'only annotation here' }], {
        comment: null,
        note: null,
      }),
    );
    assert.ok(prompt.includes('only annotation here'));
    assert.ok(!prompt.includes('沒有留下任何 comment'), 'must not claim the review was empty');
  });

  test('notes are still excluded — an anchored comment does not smuggle them in', () => {
    const prompt = toClaudePrompt(
      anchoredCtx([{ anchorStart: 3, anchorEnd: 3, text: 'anchored question' }], {
        comment: null,
        note: 'a private note',
      }),
    );
    assert.ok(!prompt.includes('a private note'), 'notes must never reach the Claude prompt');
  });

  test('a change point with no anchoredComments field at all is unaffected', () => {
    // Every pre-existing state file, and every fixture written before this
    // feature: the field is simply absent.
    const cp = annotatedChangePoint({ comment: 'plain old comment' });
    delete cp.anchoredComments;
    const prompt = toClaudePrompt(
      baseCtx({ files: [annotatedFile({ groups: [annotatedGroup({ changePoints: [cp] })] })] }),
    );
    assert.ok(prompt.includes('plain old comment'));
    assert.ok(!prompt.includes('»'));
  });
});

describe('toMarkdown — anchored comments', () => {
  test('carries the anchored lines and the comment', () => {
    const md = toMarkdown(
      anchoredCtx([{ anchorStart: 3, anchorEnd: 3, text: 'is nm always set here?' }]),
    );
    assert.ok(md.includes('is nm always set here?'), 'the comment must appear');
    assert.ok(md.includes('第 24 行'), `the anchored file line must appear:\n${md}`);
    assert.ok(md.includes('> +  if (!nm) return null;'), 'the anchored line must be quoted');
  });

  test('a change point whose ONLY annotation is anchored still earns a heading', () => {
    const md = toMarkdown(
      anchoredCtx([{ anchorStart: 3, anchorEnd: 3, text: 'only annotation' }], {
        comment: null,
        note: null,
      }),
    );
    assert.ok(md.includes('### processMVPF'), `expected a heading:\n${md}`);
    assert.ok(md.includes('only annotation'));
    assert.ok(!md.includes('這次 review 沒有留下 comment'), 'must not claim the review was empty');
  });

  test('a history entry carries its anchored comments too', () => {
    const md = toMarkdown(
      baseCtx({
        orphans: [
          {
            key: 'deadbeef',
            text: null,
            note: null,
            anchored: [{ anchorStart: 1, anchorEnd: 1, text: 'anchored on gone code' }],
            updatedAt: '2026-07-20T00:00:00.000Z',
            filePath: 'web/sims/js/selector.js',
            functionName: 'processMVPF',
            diffText: '-if(!mvpf) return;\n+if(!mvpf) return [];',
          },
        ],
      }),
    );
    assert.ok(md.includes('anchored on gone code'), `the anchored text must survive:\n${md}`);
    assert.ok(md.includes('+if(!mvpf) return [];'), 'the line it pointed at must be shown');
  });
});
