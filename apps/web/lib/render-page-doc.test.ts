import { describe, expect, it } from 'vitest';
import { renderPageDoc } from './render-page-doc';

const opts = { assetUrl: (id: string) => `/s/T/a/${id}` };
const doc = (content: unknown[]) => ({ type: 'doc', content });

describe('renderPageDoc', () => {
  it('escapes text and applies marks', () => {
    const html = renderPageDoc(
      doc([{ type: 'paragraph', content: [{ type: 'text', text: '<x> & y', marks: [{ type: 'bold' }] }] }]),
      opts,
    );
    expect(html).toBe('<p><strong>&lt;x&gt; &amp; y</strong></p>');
  });

  it('renders callouts, images (asset-rewritten), and task lists', () => {
    const html = renderPageDoc(
      doc([
        { type: 'callout', attrs: { variant: 'warning' }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hi' }] }] },
        { type: 'image', attrs: { nodeId: 'f1', alt: 'pic' } },
        { type: 'taskList', content: [{ type: 'taskItem', attrs: { checked: true }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'done' }] }] }] },
      ]),
      opts,
    );
    expect(html).toContain('data-callout data-variant="warning"');
    expect(html).toContain('src="/s/T/a/f1"');
    expect(html).toContain('data-checked="true"');
  });

  it('pre-renders math (KaTeX) and code (lowlight)', () => {
    const html = renderPageDoc(
      doc([
        { type: 'blockMath', attrs: { latex: 'x^2' } },
        { type: 'codeBlock', attrs: { language: 'ts' }, content: [{ type: 'text', text: 'const x = 1' }] },
      ]),
      opts,
    );
    expect(html).toContain('katex'); // KaTeX wraps output in .katex
    expect(html).toContain('<pre><code class="language-ts">');
    expect(html).toContain('const'); // code text survives highlighting
  });

  it('neutralizes dangerous link protocols', () => {
    const html = renderPageDoc(
      doc([{ type: 'paragraph', content: [{ type: 'text', text: 'x', marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }] }] }]),
      opts,
    );
    expect(html).not.toContain('javascript:');
    expect(html).toContain('href="#"');
  });
});
