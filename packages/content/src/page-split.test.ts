import { describe, expect, it } from 'vitest';
import { splitDocByHeading, extractSection, headingText } from './page-split';

const h = (level: number, text: string, id?: string) => ({
  type: 'heading',
  attrs: id ? { level, id } : { level },
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

const txt = (b: unknown) => (b as { content?: { text: string }[] }).content?.[0]?.text;

describe('extractSection', () => {
  it('lifts a heading + its body, splitting before/after around it', () => {
    const d = doc([p('intro'), h(2, 'Target', 'h1'), p('b1'), p('b2'), h(2, 'Next', 'h2'), p('n1')]);
    const r = extractSection(d, 'h1')!;
    expect(r.title).toBe('Target');
    expect(r.childBlocks.map(txt)).toEqual(['b1', 'b2']); // heading not repeated
    expect(r.before.map(txt)).toEqual(['intro']);
    expect(r.after.map((b) => (b as { type: string }).type)).toEqual(['heading', 'paragraph']);
  });

  it('section ends at the next EQUAL-or-higher heading (h1 ends an h2 section)', () => {
    const d = doc([h(2, 'Sec', 's'), p('x'), h(3, 'sub'), p('y'), h(1, 'Top'), p('z')]);
    const r = extractSection(d, 's')!;
    // the nested h3 + its paragraph ride along; the h1 is the boundary
    expect(r.childBlocks.map((b) => (b as { type: string }).type)).toEqual([
      'paragraph',
      'heading',
      'paragraph',
    ]);
    expect(r.after.map((b) => (b as { type: string }).type)).toEqual(['heading', 'paragraph']);
  });

  it('runs to end of doc when no boundary heading follows', () => {
    const d = doc([h(1, 'Only', 'o'), p('a'), p('b')]);
    const r = extractSection(d, 'o')!;
    expect(r.childBlocks.map(txt)).toEqual(['a', 'b']);
    expect(r.after).toEqual([]);
  });

  it('returns null for an unknown id or a non-heading block', () => {
    const para = { ...p('plain'), attrs: { id: 'pid' } };
    const d = doc([para, h(1, 'H', 'hid')]);
    expect(extractSection(d, 'missing')).toBeNull();
    expect(extractSection(d, 'pid')).toBeNull(); // id exists but isn't a heading
  });

  it('preserves block object references (byte-faithful)', () => {
    const body = p('keep me');
    const d = doc([h(1, 'S', 'sid'), body]);
    expect(extractSection(d, 'sid')!.childBlocks[0]).toBe(body);
  });
});
