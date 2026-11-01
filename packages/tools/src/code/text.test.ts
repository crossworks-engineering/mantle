/**
 * The code tools' text work: the exact-match rule (once, or say how many
 * and where), all-or-nothing edits, line inserts, numbered views, the diff
 * and the file glob.
 */
import { describe, expect, it } from 'vitest';
import {
  applyEdits,
  crlfOf,
  globMatcher,
  insertAfterLine,
  numberedView,
  splitLines,
  toCrlf,
  toLf,
  unifiedDiff,
} from './text';

const SRC = [
  'import { useState } from "react";',
  'export default function App() {',
  '  const [n, setN] = useState(0);',
  '  return <button onClick={() => setN(n + 1)}>{n}</button>;',
  '}',
  '',
].join('\n');

describe('applyEdits: match once', () => {
  it('replaces text found exactly once', () => {
    const out = applyEdits(SRC, [{ old: 'useState(0)', new: 'useState(10)' }]);
    expect(out).toEqual({ text: SRC.replace('useState(0)', 'useState(10)'), replaced: 1 });
  });

  it('fails on no match and changes nothing, pointing at a near match', () => {
    const out = applyEdits(SRC, [{ old: 'const [n,   setN] = useState(0);', new: 'x' }]);
    expect('error' in out && out.error).toMatch(/not found/);
    expect('error' in out && out.error).toMatch(/line\(s\) 3/);
    expect('error' in out && out.error).toMatch(/Nothing was changed/);
  });

  it('fails on two matches, naming the count and the lines', () => {
    const out = applyEdits(SRC, [{ old: 'setN', new: 'setCount' }]);
    expect('error' in out && out.error).toMatch(/matches 2 times \(lines 3, 4\)/);
    expect('error' in out && out.error).toMatch(/replace_all/);
  });

  it('replace_all replaces every match', () => {
    const out = applyEdits(SRC, [{ old: 'setN', new: 'setCount', replace_all: true }]);
    expect(out).toMatchObject({ replaced: 2 });
    expect('text' in out && out.text).not.toMatch(/setN\b/);
  });

  it('overlapping matches are more than one place', () => {
    expect(applyEdits('aaa', [{ old: 'aa', new: 'b' }])).toMatchObject({
      error: expect.stringMatching(/matches 2 times/),
    });
    expect(applyEdits('aaa', [{ old: 'aa', new: 'b', replace_all: true }])).toEqual({
      text: 'ba',
      replaced: 1,
    });
  });

  it('refuses an empty old and an edit that changes nothing', () => {
    expect(applyEdits(SRC, [{ old: '', new: 'x' }])).toMatchObject({
      error: expect.stringMatching(/old is empty/),
    });
    expect(applyEdits(SRC, [{ old: 'App', new: 'App' }])).toMatchObject({
      error: expect.stringMatching(/the same text/),
    });
  });
});

describe('applyEdits: all or nothing', () => {
  it('a later edit that fails leaves no edit applied, and names which one', () => {
    const out = applyEdits(SRC, [
      { old: 'useState(0)', new: 'useState(1)' },
      { old: 'not in the file', new: 'x' },
    ]);
    expect(out).toEqual({
      error: expect.stringMatching(/^edit 2 of 2: old was not found \(after the edits before it\)/),
    });
  });

  it('edits apply in order, each to the text the one before left', () => {
    const out = applyEdits(SRC, [
      { old: 'useState(0)', new: 'useState(START)' },
      { old: 'useState(START)', new: 'useState(5)' },
    ]);
    expect('text' in out && out.text).toContain('useState(5)');
  });

  it('a dollar sign in new is literal text', () => {
    const out = applyEdits('a = 1;\n', [{ old: '1', new: '$& $1 $$' }]);
    expect(out).toEqual({ text: 'a = $& $1 $$;\n', replaced: 1 });
  });
});

describe('insertAfterLine', () => {
  it('inserts after a line, at the top (0) and at the end', () => {
    expect(insertAfterLine('a\nb\n', 1, 'x')).toEqual({ text: 'a\nx\nb\n' });
    expect(insertAfterLine('a\nb\n', 0, 'x\ny')).toEqual({ text: 'x\ny\na\nb\n' });
    expect(insertAfterLine('a\nb\n', 2, 'x\n')).toEqual({ text: 'a\nb\nx\n' });
    expect(insertAfterLine('', 0, 'x')).toEqual({ text: 'x\n' });
  });

  it('refuses a line past the end, naming the last one', () => {
    expect(insertAfterLine('a\nb\n', 3, 'x')).toEqual({
      error: expect.stringMatching(/has 2 line\(s\)\. Use 2/),
    });
  });
});

describe('numberedView', () => {
  it('numbers lines and keeps to the range', () => {
    expect(numberedView(SRC, { start: 2, end: 3 }, 100)).toMatchObject({
      text: '2\texport default function App() {\n3\t  const [n, setN] = useState(0);',
      total: 5,
      start: 2,
      end: 3,
      more: 0,
    });
  });

  it('caps at the line limit and says how many more', () => {
    const v = numberedView('a\nb\nc\nd\n', {}, 2);
    expect(v).toMatchObject({ start: 1, end: 2, more: 2 });
  });

  it('a start or end below 1, or not whole, is an error', () => {
    expect(numberedView('a\n', { start: -5 }, 10)).toMatchObject({
      error: expect.stringMatching(/start must be/),
    });
    expect(numberedView('a\n', { end: 1.5 }, 10)).toMatchObject({
      error: expect.stringMatching(/end must be/),
    });
  });

  it('a start past the end is an error', () => {
    expect(numberedView('a\n', { start: 5 }, 10)).toEqual({
      error: expect.stringMatching(/past the end/),
    });
  });
});

describe('unifiedDiff', () => {
  it('is empty when nothing changed', () => {
    expect(unifiedDiff('a.ts', SRC, SRC)).toBe('');
  });

  it('shows one hunk with context and the right line numbers', () => {
    const after = SRC.replace('useState(0)', 'useState(10)');
    expect(unifiedDiff('App.tsx', SRC, after)).toBe(
      [
        '--- a/App.tsx',
        '+++ b/App.tsx',
        '@@ -1,5 +1,5 @@',
        ' import { useState } from "react";',
        ' export default function App() {',
        '-  const [n, setN] = useState(0);',
        '+  const [n, setN] = useState(10);',
        '   return <button onClick={() => setN(n + 1)}>{n}</button>;',
        ' }',
      ].join('\n'),
    );
  });

  it('splits far changes into hunks and cuts a long diff, saying so', () => {
    const before = Array.from({ length: 40 }, (_, i) => `l${i}`).join('\n') + '\n';
    const after = before.replace('l2\n', 'L2\n').replace('l35\n', 'L35\n');
    const d = unifiedDiff('f', before, after);
    expect(d.match(/^@@/gm)).toHaveLength(2);
    expect(d).toContain('@@ -33,7 +33,7 @@');
    const cut = unifiedDiff('f', before, after, 5);
    expect(cut.split('\n')).toHaveLength(6);
    expect(cut).toMatch(/diff cut: \d+ more line/);
  });
});

describe('globMatcher', () => {
  const m = (glob: string, path: string) => globMatcher(glob)!(path);
  it('matches names in any folder without a slash, paths with one', () => {
    expect(m('*.tsx', 'App.tsx')).toBe(true);
    expect(m('*.tsx', 'lib/Chart.tsx')).toBe(true);
    expect(m('*.tsx', 'lib/fmt.ts')).toBe(false);
    expect(m('lib/**', 'lib/a/b.ts')).toBe(true);
    expect(m('lib/*', 'lib/a/b.ts')).toBe(false);
    expect(m('lib/*', 'lib/a.ts')).toBe(true);
    expect(m('**/*.{ts,tsx}', 'App.tsx')).toBe(true);
    expect(m('**/*.{ts,tsx}', 'a/b/c.ts')).toBe(true);
    expect(m('src/**/x.ts', 'src/x.ts')).toBe(true);
    expect(m('a?c.ts', 'abc.ts')).toBe(true);
    expect(m('a?c.ts', 'a/c.ts')).toBe(false);
    expect(m('a.b', 'axb')).toBe(false);
  });

  it('a glob of many stars cannot stall the process (no regex, no backtracking)', () => {
    const started = Date.now();
    const glob = '*'.repeat(400) + 'z';
    for (let i = 0; i < 50; i++) m(glob, 'components/ExpenseReportTable.tsx');
    expect(m('*a*a*a*a*a*a*a*a*a*a*a*a*z', 'a'.repeat(256))).toBe(false);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('refuses a glob that expands past the cap', () => {
    expect(globMatcher('{a,b,c,d}{a,b,c,d}{a,b,c,d}')).toBeNull();
  });
});

describe('CRLF', () => {
  it('reads CRLF and writes it back', () => {
    expect(crlfOf('a\r\nb\r\n')).toBe(true);
    expect(crlfOf('a\nb\n')).toBe(false);
    expect(toLf('a\r\nb\r\n')).toBe('a\nb\n');
    expect(toCrlf('a\nb\n')).toBe('a\r\nb\r\n');
    expect(toCrlf('a\r\nb\n')).toBe('a\r\nb\r\n');
  });
});

it('splitLines keeps the last newline apart', () => {
  expect(splitLines('a\nb\n')).toEqual({ lines: ['a', 'b'], trailingNewline: true });
  expect(splitLines('')).toEqual({ lines: [], trailingNewline: false });
});
