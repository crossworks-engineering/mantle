import { describe, expect, it } from 'vitest';
import { richMarkdownToHtml } from './rich-markdown';

/**
 * The chat renderer's dialect parser. Kept in lockstep with
 * `@mantle/content`'s `markdownToDoc` (same dialect, different output: HTML for
 * the live TipTap editor vs ProseMirror JSON for page authoring). When you
 * change one, change both — these tests + markdown-to-doc.test.ts guard the
 * shared contract.
 */
describe('richMarkdownToHtml', () => {
  it('returns empty string for blank input', () => {
    expect(richMarkdownToHtml('')).toBe('');
    expect(richMarkdownToHtml('   \n  ')).toBe('');
  });

  it('renders standard markdown + highlight', () => {
    const html = richMarkdownToHtml('# Title\n\na **b** ==c==');
    expect(html).toContain('<h1>Title</h1>');
    expect(html).toContain('<strong>b</strong>');
    expect(html).toContain('<mark>c</mark>');
  });

  it('renders [text]{color}/{highlight} as themed data-attr marks', () => {
    const html = richMarkdownToHtml(
      'a [b]{color=chart-2} c [d]{highlight=chart-4} e [f]{color=chart-1 highlight=chart-3}',
    );
    expect(html).toContain('<span data-text-color="chart-2">b</span>');
    expect(html).toContain('<mark data-color="chart-4">d</mark>');
    expect(html).toContain('data-text-color="chart-1"');
    expect(html).toContain('data-color="chart-3"');
    // Unknown token is left as plain text — no attr injection.
    expect(richMarkdownToHtml('x [y]{color=red}')).not.toContain('data-text-color');
  });

  it('renders callouts as data-callout with the variant', () => {
    expect(richMarkdownToHtml(':::warning\nbe careful\n:::')).toContain('data-variant="warning"');
    // unknown variant degrades to info
    expect(richMarkdownToHtml(':::bogus\nx\n:::')).toContain('data-variant="info"');
  });

  it('renders asides as data-aside with the themed colour', () => {
    const html = richMarkdownToHtml(':::aside chart-3\na side note\n:::');
    expect(html).toContain('data-aside');
    expect(html).toContain('data-color="chart-3"');
    expect(html).toContain('a side note');
    // No colour given → defaults to chart-1.
    expect(richMarkdownToHtml(':::aside\nx\n:::')).toContain('data-color="chart-1"');
  });

  it('renders a columns block as data-column-list with 2+ columns', () => {
    const html = richMarkdownToHtml(':::columns\nleft\n+++\nright\n:::');
    expect(html).toContain('data-column-list');
    expect((html.match(/data-column(?!-list)/g) ?? []).length).toBe(2);
  });

  it('degrades a single-column columns block to plain content', () => {
    const html = richMarkdownToHtml(':::columns\nonly one\n:::');
    expect(html).not.toContain('data-column-list');
    expect(html).toContain('only one');
  });

  it('renders GFM task lists as taskList markup with checked state', () => {
    const html = richMarkdownToHtml('- [x] done\n- [ ] todo');
    expect(html).toContain('data-type="taskList"');
    expect(html).toContain('data-checked="true"');
    expect(html).toContain('data-checked="false"');
  });

  it('renders fenced code with a language class lowlight can read', () => {
    expect(richMarkdownToHtml('```ts\nconst x = 1;\n```')).toContain('language-ts');
  });

  it('keeps a ```mermaid fence as a plain code block — chat never renders diagrams', () => {
    // Deliberate scope rule: the diagram node is a PAGES construct. The chat
    // surface shows the source as code, exactly like any other fence.
    const html = richMarkdownToHtml('```mermaid\nflowchart LR\n  A --> B\n```');
    expect(html).toContain('language-mermaid');
    expect(html).toContain('flowchart LR');
    expect(html).not.toContain('data-diagram');
  });

  it('renders GFM tables', () => {
    const html = richMarkdownToHtml('| A | B |\n|---|---|\n| 1 | 2 |');
    expect(html).toContain('<table>');
    expect(html).toContain('<th>A</th>');
  });

  it('renders markdown images as <img> the image node can parse', () => {
    expect(richMarkdownToHtml('![alt](https://x/y.png)')).toContain('<img src="https://x/y.png"');
  });

  describe('media: images (inline placement)', () => {
    it('resolves a standalone marker to the file-bytes route + data-node-id', () => {
      const html = richMarkdownToHtml('![Step 3: Add Measurement](media:f-1)');
      // PageImage.parseHTML is `img[src]`, so a real src is what makes this
      // parse as an image at all; data-node-id is what it re-derives from.
      expect(html).toContain('src="/api/files/files/f-1?raw=1"');
      expect(html).toContain('data-node-id="f-1"');
      expect(html).toContain('alt="Step 3: Add Measurement"');
      expect(html).not.toContain('src="media:');
    });

    it('places a marker written mid-prose, matching markdownToDoc', () => {
      // markdownToDoc lifts ANY image token out of its paragraph
      // (paragraphAndImages). The block-form-only rule is for media: LINKS,
      // not images. The chat converter emits the <img> in place and the shared
      // schema's block image node closes the paragraph around it.
      const html = richMarkdownToHtml('Open the form ![the form](media:f-2) and fill it in.');
      expect(html).toContain('data-node-id="f-2"');
      expect(html).toContain('Open the form');
      expect(html).toContain('and fill it in.');
    });

    it('renders several markers in written order', () => {
      const html = richMarkdownToHtml('1. one\n\n![a](media:f-1)\n\n2. two\n\n![b](media:f-2)');
      expect(html.indexOf('data-node-id="f-1"')).toBeLessThan(html.indexOf('data-node-id="f-2"'));
    });

    it('leaves a half-typed marker as literal text (streaming degrades quietly)', () => {
      // Every prefix a stream passes through on the way to a complete marker.
      for (const partial of [
        '!',
        '![',
        '![alt',
        '![alt]',
        '![alt](',
        '![alt](media:',
        '![alt](media:f-1',
      ]) {
        const html = richMarkdownToHtml(`Step one. ${partial}`);
        expect(html).not.toContain('<img');
        expect(html).not.toContain('data-node-id');
      }
    });

    it('never claims a stored file for a malformed or empty id', () => {
      // `media:` with nothing after it is not a file reference, so no
      // data-node-id is emitted and nothing is fetched from the files route.
      // It degrades to the same broken plain image markdownToDoc produces
      // (src `media:`, nodeId null); see the drift test's 'empty id' case.
      for (const src of ['![alt](media:)', '![alt](media: )']) {
        const html = richMarkdownToHtml(src);
        expect(html).not.toContain('data-node-id');
        expect(html).not.toContain('/api/files/files/');
      }
    });

    it('escapes the alt text so it cannot break out of the attribute', () => {
      const html = richMarkdownToHtml('![a"><script>x</script>](media:f-1)');
      expect(html).not.toContain('"><script>');
      expect(html).toContain('&quot;');
    });

    it('leaves an inline media: LINK as a plain link (only images place a picture)', () => {
      const html = richMarkdownToHtml('see [spec.pdf](media:f-2) here');
      expect(html).not.toContain('<img');
    });
  });

  it('renders $…$ / $$…$$ as KaTeX math spans/divs', () => {
    const inline = richMarkdownToHtml('Inline $E=mc^2$ here');
    expect(inline).toContain('data-type="inline-math"');
    expect(inline).toContain('data-latex="E=mc^2"');
    expect(richMarkdownToHtml('$$\nx^2\n$$')).toContain('data-type="block-math"');
  });
});
