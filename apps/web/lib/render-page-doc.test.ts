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

  it('renders highlight marks: themed colour from a token, plain otherwise', () => {
    const colored = renderPageDoc(
      doc([{ type: 'paragraph', content: [{ type: 'text', text: 'hi', marks: [{ type: 'highlight', attrs: { color: 'chart-2' } }] }] }]),
      opts,
    );
    expect(colored).toContain('<mark style="background-color:color-mix');
    expect(colored).toContain('var(--chart-2)');

    const plain = renderPageDoc(
      doc([{ type: 'paragraph', content: [{ type: 'text', text: 'hi', marks: [{ type: 'highlight' }] }] }]),
      opts,
    );
    expect(plain).toContain('<mark>hi</mark>');

    // An unknown colour token falls back to a plain mark (no style injection).
    const bad = renderPageDoc(
      doc([{ type: 'paragraph', content: [{ type: 'text', text: 'hi', marks: [{ type: 'highlight', attrs: { color: 'red; x:1' } }] }] }]),
      opts,
    );
    expect(bad).toContain('<mark>hi</mark>');
  });

  it('renders themed text colour from a token; ignores unknown', () => {
    const ok = renderPageDoc(
      doc([{ type: 'paragraph', content: [{ type: 'text', text: 'hi', marks: [{ type: 'textColor', attrs: { color: 'chart-3' } }] }] }]),
      opts,
    );
    expect(ok).toContain('<span style="color:var(--chart-3)">hi</span>');

    const bad = renderPageDoc(
      doc([{ type: 'paragraph', content: [{ type: 'text', text: 'hi', marks: [{ type: 'textColor', attrs: { color: 'red; x:1' } }] }] }]),
      opts,
    );
    expect(bad).not.toContain('color:');
    expect(bad).toContain('hi');
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

  it('renders a childPage as an inert label, not a link (sub-pages stay private)', () => {
    const html = renderPageDoc(
      doc([{ type: 'childPage', attrs: { pageId: 'p1', title: '<Plans> & ideas', icon: '📋' } }]),
      opts,
    );
    expect(html).toContain('data-child-page');
    expect(html).toContain('<span class="child-page-title">&lt;Plans&gt; &amp; ideas</span>');
    expect(html).toContain('<span class="child-page-icon">📋</span>');
    // No link into the private child.
    expect(html).not.toContain('/pages/p1');
    expect(html).not.toContain('<a');
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
