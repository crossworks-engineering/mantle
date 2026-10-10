import { describe, expect, it } from 'vitest';
import { docToText } from './doc-to-text';
import { drawSceneText } from './draw-scene-text';
import { foldNoteEmbeds } from './embed-fold';
import { pageDocText } from './pages/level-text';

/**
 * Always fold (workspaces plan 5.3, W2): the indexed text of a page, note or
 * drawing holds its own words and a plain marker per embed, never the
 * embed's caption, name or text.
 */
const ID = '0b7c6a1e-2f4d-4c1a-9e8b-5d3f2a1c0e9f';
const doc = {
  type: 'doc',
  content: [
    { type: 'paragraph', content: [{ type: 'text', text: 'Pump overhaul notes.' }] },
    { type: 'image', attrs: { nodeId: ID, alt: 'zanzibar-gauge.png', src: null } },
    { type: 'image', attrs: { drawId: ID, alt: 'quokka layout' } },
    { type: 'fileEmbed', attrs: { nodeId: ID, filename: 'marmalade-quote.pdf' } },
    { type: 'childPage', attrs: { pageId: ID, title: 'Okapi checklist' } },
    { type: 'image', attrs: { src: 'https://example.invalid/x.png', alt: 'a web picture' } },
  ],
};

describe('always fold', () => {
  it('a page doc indexes markers for its embeds, and keeps a plain URL image', () => {
    const t = docToText(doc, { embedMarkers: true });
    expect(t).toContain('Pump overhaul notes.');
    expect(t).toContain('[embedded file]');
    expect(t).toContain('[embedded drawing]');
    expect(t).toContain('[embedded page]');
    expect(t).toContain('a web picture');
    for (const w of ['zanzibar', 'quokka', 'marmalade', 'Okapi']) expect(t).not.toContain(w);
    // Without the option (display, diffs) nothing changes.
    expect(docToText(doc)).toContain('marmalade-quote.pdf');
  });

  it('pageDocText at an unfiltered level is the marker text, with no database read', async () => {
    const t = await pageDocText('owner', 'admin', doc);
    expect(t).toBe(docToText(doc, { embedMarkers: true }));
  });

  it("a note's media and draw embeds become markers; other links stay", () => {
    const md = [
      'Before ![zanzibar gauge](media:abc) after.',
      '[marmalade quote](media:def)',
      '![quokka](draw:ghi)',
      'See [the wiki](https://example.invalid/w) and [Okapi](page:jkl).',
    ].join('\n');
    const f = foldNoteEmbeds(md);
    expect(f).toBe(
      [
        'Before [embedded file] after.',
        '[embedded file]',
        '[embedded drawing]',
        'See [the wiki](https://example.invalid/w) and [Okapi](page:jkl).',
      ].join('\n'),
    );
  });

  it("a drawing's text is its own labels plus one marker per placed image", () => {
    const scene = {
      elements: [
        { type: 'text', id: 't', text: 'Valve train' },
        { type: 'image', id: 'i1', fileId: 'f1' },
        { type: 'image', id: 'i2', fileId: 'f2', isDeleted: true },
      ],
    };
    const t = drawSceneText(scene, { f1: ID, f2: '1b7c6a1e-2f4d-4c1a-9e8b-5d3f2a1c0e9f' });
    expect(t).toContain('Valve train');
    expect(t.match(/\[embedded file\]/g)).toHaveLength(1);
  });
});
