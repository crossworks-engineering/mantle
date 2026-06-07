import { describe, expect, it } from 'vitest';
import { splitDocByHeading, headingText } from './page-split';

const h = (level: number, text: string) => ({
  type: 'heading',
  attrs: { level },
  content: [{ type: 'text', text }],
});
const p = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text }] });
const doc = (content: unknown[]) => ({ type: 'doc', content });

describe('headingText', () => {
  it('concatenates descendant text and trims', () => {
    expect(headingText({ type: 'heading', content: [{ type: 'text', text: '🔥 Point ' }, { type: 'text', text: 'One ' }] })).toBe('🔥 Point One');
  });
});

describe('splitDocByHeading', () => {
  it('splits on the chosen level: heading → title, following blocks → body', () => {
    const d = doc([h(2, 'Alpha'), p('a1'), p('a2'), h(2, 'Beta'), p('b1')]);
    const { intro, sections } = splitDocByHeading(d, 2);
    expect(intro).toEqual([]);
    expect(sections).toHaveLength(2);
    expect(sections[0]!.title).toBe('Alpha');
    expect(sections[0]!.blocks.map((b) => (b as { content?: { text: string }[] }).content?.[0]?.text)).toEqual(['a1', 'a2']);
    expect(sections[1]!.title).toBe('Beta');
    expect(sections[1]!.blocks).toHaveLength(1);
  });

  it('keeps pre-heading blocks as the intro', () => {
    const d = doc([p('lead-in'), h(1, 'One'), p('x')]);
    const { intro, sections } = splitDocByHeading(d, 1);
    expect(intro.map((b) => (b as { content?: { text: string }[] }).content?.[0]?.text)).toEqual(['lead-in']);
    expect(sections).toHaveLength(1);
    expect(sections[0]!.title).toBe('One');
  });

  it('does NOT repeat the heading block in the section body (it becomes the title)', () => {
    const d = doc([h(1, 'Title'), p('body')]);
    const { sections } = splitDocByHeading(d, 1);
    expect(sections[0]!.blocks.some((b) => (b as { type?: string }).type === 'heading')).toBe(false);
  });

  it('only splits on the requested level — other-level headings stay in the body', () => {
    const d = doc([h(1, 'Big'), p('x'), h(2, 'Small'), p('y')]);
    const { sections } = splitDocByHeading(d, 1);
    expect(sections).toHaveLength(1);
    // the h2 + its paragraph ride along inside the h1 section, verbatim
    expect(sections[0]!.blocks.map((b) => (b as { type?: string }).type)).toEqual([
      'paragraph',
      'heading',
      'paragraph',
    ]);
  });

  it('returns no sections when the level is absent (caller treats as no-op)', () => {
    const d = doc([p('just text'), h(3, 'deep')]);
    expect(splitDocByHeading(d, 1).sections).toEqual([]);
    expect(splitDocByHeading(d, 2).sections).toEqual([]);
  });

  it('handles an empty section (heading with no following blocks)', () => {
    const d = doc([h(2, 'Lonely')]);
    const { sections } = splitDocByHeading(d, 2);
    expect(sections).toHaveLength(1);
    expect(sections[0]!.blocks).toEqual([]);
  });

  it('preserves block object references (byte-faithful redistribution)', () => {
    const body = p('keep me');
    const d = doc([h(1, 'S'), body]);
    const { sections } = splitDocByHeading(d, 1);
    expect(sections[0]!.blocks[0]).toBe(body); // same reference, not a copy
  });
});
