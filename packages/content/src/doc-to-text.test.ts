import { describe, expect, it } from 'vitest';
import { docToText } from './doc-to-text';

describe('docToText', () => {
  it('returns empty string for nullish / non-doc input', () => {
    expect(docToText(null)).toBe('');
    expect(docToText(undefined)).toBe('');
    expect(docToText('nope')).toBe('');
    expect(docToText({})).toBe('');
  });

  it('extracts paragraph text', () => {
    const doc = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hello world' }] }],
    };
    expect(docToText(doc)).toBe('Hello world');
  });

  it('separates blocks with newlines and prefixes headings', () => {
    const doc = {
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Title' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'Body line.' }] },
      ],
    };
    expect(docToText(doc)).toBe('## Title\nBody line.');
  });

  it('joins inline marks within a paragraph', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'plain ' },
            { type: 'text', text: 'bold', marks: [{ type: 'bold' }] },
            { type: 'text', text: ' end' },
          ],
        },
      ],
    };
    expect(docToText(doc)).toBe('plain bold end');
  });

  it('surfaces atom labels (mentions, images)', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'see ' },
            { type: 'mention', attrs: { label: 'Sarah', id: 'n1' } },
          ],
        },
        { type: 'image', attrs: { alt: 'gantry diagram' } },
      ],
    };
    const out = docToText(doc);
    expect(out).toContain('see Sarah');
    expect(out).toContain('gantry diagram');
  });

  it('renders callout contents', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'callout',
          attrs: { variant: 'info' },
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Heads up' }] }],
        },
      ],
    };
    expect(docToText(doc)).toBe('Heads up');
  });

  it('collapses excessive blank lines', () => {
    const doc = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'a' }] },
        { type: 'paragraph' },
        { type: 'paragraph' },
        { type: 'paragraph', content: [{ type: 'text', text: 'b' }] },
      ],
    };
    expect(docToText(doc)).toBe('a\n\nb');
  });

  it('marks task items with their checked state', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'taskList',
          content: [
            {
              type: 'taskItem',
              attrs: { checked: true },
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'booked flights' }] }],
            },
            {
              type: 'taskItem',
              attrs: { checked: false },
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'pack bags' }] }],
            },
          ],
        },
      ],
    };
    expect(docToText(doc)).toBe('[x] booked flights\n[ ] pack bags');
  });

  it('surfaces the audio filename label', () => {
    const doc = {
      type: 'doc',
      content: [{ type: 'audio', attrs: { filename: 'sermon.mp3', src: '/x?raw=1' } }],
    };
    expect(docToText(doc)).toContain('sermon.mp3');
  });

  it('handles hard breaks', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'line1' },
            { type: 'hardBreak' },
            { type: 'text', text: 'line2' },
          ],
        },
      ],
    };
    expect(docToText(doc)).toBe('line1\nline2');
  });
});
