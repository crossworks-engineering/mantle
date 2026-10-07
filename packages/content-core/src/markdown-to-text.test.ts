// markdownToPlainText / markdownPreview: what a push notification's
// lock-screen line shows of a reply. Real reply shapes, mark by mark.

import { describe, expect, it } from 'vitest';
import { markdownPreview, markdownToPlainText } from './markdown-to-text';

const plain = markdownToPlainText;

describe('markdownToPlainText', () => {
  it('a heading, bold, italic, strike and highlight keep their words only', () => {
    expect(plain('## Summary\n\nThe **pump** spec is _ready_, ~~not late~~ ==today==.')).toBe(
      'Summary The pump spec is ready, not late today.',
    );
    expect(plain('# Title\ntext')).toBe('Title text');
  });

  it('a list loses its markers, a to-do its box, a quote its mark', () => {
    expect(plain('- one\n- two\n  - nested\n\n1. first\n2. second')).toBe(
      'one two nested first second',
    );
    expect(plain('- [x] booked flights\n- [ ] book hotel')).toBe('booked flights book hotel');
    expect(plain('> quoted line\n\nafter')).toBe('quoted line after');
  });

  it('a link keeps its text, never its address', () => {
    const out = plain(
      'See [the docs](https://example.invalid/x?y=1) and <https://example.invalid/z>.',
    );
    expect(out).toContain('See the docs and');
    expect(out).not.toContain('](');
    expect(out).not.toContain('x?y=1');
  });

  it('a reference chip keeps its label and drops its target', () => {
    const id = '11111111-1111-4111-8111-111111111111';
    const out = plain(
      `Open [Pump spec](page:${id}), ask [Ada](mention:entity:${id}), read [the file](media:${id}).`,
    );
    expect(out).toContain('Pump spec');
    expect(out).toContain('Ada');
    expect(out).toContain('the file');
    expect(out).not.toContain(id);
    expect(out).not.toMatch(/page:|mention:|media:|\]\(/);
  });

  it('an image and a drawing leave their alt text or nothing, never a path', () => {
    const id = '22222222-2222-4222-8222-222222222222';
    const out = plain(`Here ![the chart](media:${id}) and ![](draw:${id}) end`);
    expect(out).not.toContain(id);
    expect(out).not.toMatch(/!\[|media:|draw:|\/api\//);
    expect(out.startsWith('Here')).toBe(true);
    expect(out.endsWith('end')).toBe(true);
    expect(plain(`![chart](/api/member/files/${id})`)).not.toContain('/api/');
  });

  it('code keeps its text and loses its marks and its language', () => {
    expect(plain('Run this:\n```bash\npnpm verify\n```\nthen `git status`.')).toBe(
      'Run this: pnpm verify then git status.',
    );
  });

  it('a table keeps its cell text', () => {
    const out = plain('| Item | Qty |\n|---|---|\n| Pump | 2 |\n| Valve | 5 |');
    expect(out).toBe('Item Qty Pump 2 Valve 5');
  });

  it('math keeps its source without the marks; a rule says nothing', () => {
    const out = plain('Area $x^2$ here\n\n---\n\nend');
    expect(out).not.toContain('$');
    expect(out).not.toContain('---');
    expect(out).toContain('x^2');
    expect(out.endsWith('end')).toBe(true);
  });

  it('a callout and columns keep their text, not their fences', () => {
    const out = plain(':::info\nMind the gap\n:::\n\n:::columns\nleft\n+++\nright\n:::');
    expect(out).toContain('Mind the gap');
    expect(out).toContain('left');
    expect(out).toContain('right');
    expect(out).not.toContain(':::');
    expect(out).not.toContain('+++');
  });

  it('raw HTML tags go, their words stay', () => {
    expect(plain('a <b>bold</b> word<br>next')).toBe('a bold word next');
  });

  it('plain text comes back as it is, on one line', () => {
    expect(plain('  We fixed the date.\n\nSee you at 2 * 3 pm, snake_case_name stays.  ')).toBe(
      'We fixed the date. See you at 2 * 3 pm, snake_case_name stays.',
    );
  });

  it('nothing in, nothing out', () => {
    expect(plain('')).toBe('');
    expect(plain('   \n ')).toBe('');
    expect(plain('---')).toBe('');
    expect(plain(undefined as unknown as string)).toBe('');
  });
});

describe('markdownPreview', () => {
  it('cuts after the marks are gone, so no half mark is left at the end', () => {
    const out = markdownPreview(`## ${'**word** '.repeat(60)}`, 140);
    expect(out).toHaveLength(140);
    expect(out.endsWith('…')).toBe(true);
    expect(out).not.toMatch(/[*#]/);
  });

  it('is empty for a text with no words, so the caller can say something generic', () => {
    expect(markdownPreview('![](media:abc)')).toBe('');
    expect(markdownPreview('```\n```')).toBe('');
  });

  it('reads only the start of a very long text', () => {
    const out = markdownPreview(`${'a '.repeat(10_000)}**end**`, 50);
    expect(out).toHaveLength(50);
  });
});
