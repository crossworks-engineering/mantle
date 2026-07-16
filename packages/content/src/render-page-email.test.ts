import { describe, expect, it } from 'vitest';
import { renderPageEmail, cidForPageImage } from './render-page-email';

describe('renderPageEmail', () => {
  it('produces a standalone HTML document with the title', () => {
    const { html } = renderPageEmail(
      { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hi' }] }] },
      { title: 'My Page' },
    );
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('<h1');
    expect(html).toContain('My Page');
    expect(html).toContain('<p style="margin:0 0 16px">Hi</p>');
  });

  it('handles nullish / non-doc input without throwing', () => {
    expect(renderPageEmail(null).html).toContain('<!doctype html>');
    expect(renderPageEmail(undefined).imageFileIds).toEqual([]);
    expect(renderPageEmail('nope').imageFileIds).toEqual([]);
  });

  it('inlines styles (no var(--token) theme refs survive into email)', () => {
    const { html } = renderPageEmail({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text: 'hot',
              marks: [{ type: 'highlight', attrs: { color: 'chart-2' } }],
            },
            {
              type: 'text',
              text: 'red',
              marks: [{ type: 'textColor', attrs: { color: 'chart-1' } }],
            },
          ],
        },
      ],
    });
    expect(html).not.toContain('var(--');
    expect(html).toContain('background-color:#dcfce7'); // chart-2 highlight tint
    expect(html).toContain('color:#2563eb'); // chart-1 text colour
  });

  it('emits cid images and reports their file ids', () => {
    const { html, imageFileIds } = renderPageEmail({
      type: 'doc',
      content: [{ type: 'image', attrs: { nodeId: 'file-123', alt: 'a chart' } }],
    });
    expect(imageFileIds).toEqual(['file-123']);
    expect(html).toContain(`src="cid:${cidForPageImage('file-123')}"`);
    expect(html).toContain('alt="a chart"');
  });

  it('renders columns as a presentation table', () => {
    const { html } = renderPageEmail({
      type: 'doc',
      content: [
        {
          type: 'columnList',
          content: [
            {
              type: 'column',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'L' }] }],
            },
            {
              type: 'column',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'R' }] }],
            },
          ],
        },
      ],
    });
    expect(html).toContain('role="presentation"');
    expect(html).toContain('width="50%"');
  });

  it('degrades math to its LaTeX source (no KaTeX in email)', () => {
    const { html } = renderPageEmail({
      type: 'doc',
      content: [{ type: 'blockMath', attrs: { latex: 'E = mc^2' } }],
    });
    expect(html).toContain('E = mc^2');
    expect(html).not.toContain('katex');
  });

  it('neutralises unsafe link protocols and escapes text', () => {
    const { html } = renderPageEmail({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text: 'x',
              marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }],
            },
          ],
        },
        { type: 'paragraph', content: [{ type: 'text', text: '<script>' }] },
      ],
    });
    expect(html).not.toContain('javascript:');
    expect(html).toContain('href="#"');
    expect(html).toContain('&lt;script&gt;');
  });

  it('appends a trusted footer when provided', () => {
    const { html } = renderPageEmail(
      { type: 'doc', content: [] },
      { footerHtml: '<a href="https://example.com/s/abc">View online</a>' },
    );
    expect(html).toContain('https://example.com/s/abc');
    expect(html).toContain('View online');
  });
});
