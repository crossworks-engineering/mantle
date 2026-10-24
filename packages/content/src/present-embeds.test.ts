/**
 * A Present canvas embedded in a page or a note (`![Title](present:<id>)`, an
 * image node with `presentId`): the share surface finds it, the indexed text
 * carries a marker and none of its words, a member's save reads its id, and a
 * client's read leaves out a canvas the client cannot read, title included.
 * Pure.
 */
import { describe, expect, it } from 'vitest';
import { markdownToDoc } from '@mantle/content-core/markdown';
import { referencedEmbedIds, referencedPresentIds } from './doc-assets';
import { docToText } from './doc-to-text';
import { EMBED_MARKER_CANVAS, foldNoteEmbeds } from './embed-fold';
import { noteRefs, pageRefs } from './embed-refs';
import { redactClientDoc } from './client-redact';

const CANVAS = '55555555-5555-4555-8555-555555555555';
const OTHER = '66666666-6666-4666-8666-666666666666';
const md = `Intro\n\n![Pump deck](present:${CANVAS})\n\nOutro`;

describe('a canvas embedded in a page', () => {
  it('the share surface finds it; the embed edges leave it out (its own grants decide)', () => {
    const doc = markdownToDoc(md);
    expect(referencedPresentIds(doc)).toEqual([CANVAS]);
    expect(referencedEmbedIds(doc)).toEqual([]);
  });

  it('indexes as a marker, never its title', () => {
    const text = docToText(markdownToDoc(md), { embedMarkers: true });
    expect(text).toContain(EMBED_MARKER_CANVAS);
    expect(text).not.toContain('Pump deck');
    expect(foldNoteEmbeds(md)).toBe(`Intro\n\n${EMBED_MARKER_CANVAS}\n\nOutro`);
  });

  it("a member's save reads its id, as an embed", () => {
    expect(pageRefs(markdownToDoc(md)).embeds).toContain(CANVAS);
    expect(noteRefs(md).embeds).toContain(CANVAS);
  });

  it('a client read leaves out a canvas the client cannot read, its title too', () => {
    const doc = markdownToDoc(
      `![Secret deck](present:${OTHER})\n\n![Pump deck](present:${CANVAS})`,
    );
    const out = redactClientDoc(doc, new Set([CANVAS]));
    const json = JSON.stringify(out);
    expect(json).not.toContain('Secret deck');
    expect(json).not.toContain(OTHER);
    expect(json).toContain(CANVAS);
  });
});
