/**
 * The drift guard between the dialect's TWO converters.
 *
 *   packages/content/src/markdown-to-doc.ts   markdown → ProseMirror JSON (Pages)
 *   client/web/lib/rich-markdown.ts           markdown → HTML (the chat RichText)
 *
 * They target different things, so their OUTPUT can never be compared byte for
 * byte. What must not differ is the ANSWER: given the same source, do both
 * decide the same picture goes in the same place?
 *
 * They diverged on exactly that once. `markdownToDoc` resolved
 * `![alt](media:<id>)` into a real image node while the chat converter let it
 * fall through to `<img src="media:…">`, so a reply could not place a picture
 * mid-sentence: every image ended up in a gallery below the whole answer. Both
 * now read the scheme from `@mantle/content/markdown-refs`; this file makes the
 * next divergence a failing test instead of a shipped bug.
 *
 * Scope: `media:` IMAGES. The other reference schemes (`[label](media:…)` →
 * fileEmbed, `[Title](page:...)` → childPage, mentions) are still server-only:
 * the chat converter leaves them as ordinary links. That asymmetry is asserted
 * below so it is a recorded decision rather than an unnoticed gap.
 */
import { describe, expect, it } from 'vitest';
import { markdownToDoc } from '@mantle/content-core/markdown';
import { richMarkdownToHtml } from './rich-markdown';

type PMNode = { type: string; attrs?: Record<string, unknown>; content?: PMNode[] };

/** Every image node in a ProseMirror doc, in document order. */
function docImages(markdown: string): Array<{ nodeId: string | null; alt: string | null }> {
  const out: Array<{ nodeId: string | null; alt: string | null }> = [];
  const walk = (n: PMNode) => {
    if (n.type === 'image') {
      out.push({
        nodeId: (n.attrs?.nodeId as string) ?? null,
        alt: (n.attrs?.alt as string) ?? null,
      });
    }
    for (const c of n.content ?? []) walk(c);
  };
  walk(markdownToDoc(markdown) as unknown as PMNode);
  return out;
}

/** Every image the chat converter emitted, in document order. */
function htmlImages(markdown: string): Array<{ nodeId: string | null; alt: string | null }> {
  const html = richMarkdownToHtml(markdown);
  return [...html.matchAll(/<img\b[^>]*>/g)].map(([tag]) => ({
    nodeId: /data-node-id="([^"]*)"/.exec(tag)?.[1] ?? null,
    alt: /\balt="([^"]*)"/.exec(tag)?.[1] ?? null,
  }));
}

describe('rich-markdown ↔ markdownToDoc: media: image parity', () => {
  const CASES: Array<[name: string, markdown: string]> = [
    ['standalone marker', '![gantry](media:f-1)'],
    ['marker mid-prose', 'Open the form ![the form](media:f-2) and fill it in.'],
    ['several markers in order', '1. one\n\n![a](media:f-1)\n\n2. two\n\n![b](media:f-2)'],
    ['marker with empty alt', '![](media:f-3)'],
    ['plain URL image (not a media: ref)', '![arch](https://x/y.png)'],
    ['half-typed marker', 'Step one. ![alt](media:'],
    ['unclosed paren', '![alt](media:f-1'],
    ['empty id', '![alt](media:)'],
    ['media: LINK, not an image', 'see [spec.pdf](media:f-2) here'],
    ['no images at all', '# Title\n\nJust prose.'],
  ];

  for (const [name, markdown] of CASES) {
    it(`agrees on ${name}`, () => {
      const fromDoc = docImages(markdown);
      const fromHtml = htmlImages(markdown);
      // Same count, same order, same file ids, same alt text.
      expect(fromHtml.map((i) => i.nodeId)).toEqual(fromDoc.map((i) => i.nodeId));
      expect(fromHtml.map((i) => i.alt ?? '')).toEqual(fromDoc.map((i) => i.alt ?? ''));
    });
  }

  it('does not wrap a standalone marker in a paragraph', () => {
    // markdownToDoc emits the bare image node. If the chat converter left the
    // `<p>` marked produces around it, ProseMirror would close that paragraph
    // EMPTY before opening the block image, leaving a blank line above every picture.
    // Verified against the real schema in a browser; pinned here.
    const doc = markdownToDoc('![gantry](media:f-1)') as unknown as PMNode;
    expect((doc.content ?? []).map((n) => n.type)).toEqual(['image']);
    expect(richMarkdownToHtml('![gantry](media:f-1)').trim()).toBe(
      '<img src="/api/files/files/f-1?raw=1" data-node-id="f-1" alt="gantry">',
    );
  });

  it('records the schemes that are still server-only', () => {
    // fileEmbed + childPage are Pages block nodes with no chat equivalent; the
    // chat converter renders them as the plain links they look like. If chat
    // ever grows those nodes, this expectation is the thing to update.
    const doc = markdownToDoc('[spec.pdf](media:f-2)\n\n[Sub plan](page:p-9)') as unknown as PMNode;
    expect((doc.content ?? []).map((n) => n.type)).toEqual(['fileEmbed', 'childPage']);
    const html = richMarkdownToHtml('[spec.pdf](media:f-2)\n\n[Sub plan](page:p-9)');
    expect(html).toContain('href="media:f-2"');
    expect(html).toContain('href="page:p-9"');
  });
});
