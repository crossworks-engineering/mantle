import { describe, expect, it } from 'vitest';
import { markdownToDoc } from './markdown-to-doc';
import { docToMarkdown } from './doc-to-markdown';

describe('embedded drawings round-trip', () => {
  it('markdown → doc → markdown keeps the draw reference', () => {
    const src = '![Architecture sketch](draw:d-123)';
    const doc = markdownToDoc(src) as {
      content?: { type: string; attrs?: Record<string, unknown> }[];
    };
    const img = doc.content?.find((n) => n.type === 'image');
    expect(img?.attrs?.drawId).toBe('d-123');
    // An embedded drawing is NOT an uploaded file — the two ids must not mix,
    // or share scoping would serve a drawing through the file asset route.
    expect(img?.attrs?.nodeId).toBeUndefined();
    expect(docToMarkdown(doc).trim()).toBe(src);
  });

  it('leaves media: and plain URL images alone', () => {
    const doc = markdownToDoc('![a](media:f1)\n\n![b](https://example.com/x.png)') as {
      content?: { type: string; attrs?: Record<string, unknown> }[];
    };
    const imgs = (doc.content ?? []).filter((n) => n.type === 'image');
    expect(imgs[0]?.attrs?.nodeId).toBe('f1');
    expect(imgs[0]?.attrs?.drawId).toBeUndefined();
    expect(imgs[1]?.attrs?.src).toBe('https://example.com/x.png');
    expect(imgs[1]?.attrs?.drawId).toBeUndefined();
  });
});
