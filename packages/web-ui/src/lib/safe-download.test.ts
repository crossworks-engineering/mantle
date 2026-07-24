import { describe, expect, it } from 'vitest';
import { safeDownloadHeaders } from './safe-download';

describe('safeDownloadHeaders', () => {
  it('serves SVG inline as image/svg+xml so <img> embeds render', () => {
    const h = safeDownloadHeaders('image/svg+xml', 'logo.svg');
    expect(h['content-type']).toBe('image/svg+xml');
    expect(h['content-disposition']).toMatch(/^inline;/);
    expect(h['x-content-type-options']).toBe('nosniff');
  });

  it('sandboxes SVG with a scriptless CSP (no script execution on direct nav)', () => {
    const h = safeDownloadHeaders('image/svg+xml', 'logo.svg');
    const csp = h['content-security-policy'] ?? '';
    expect(csp).toContain('sandbox');
    expect(csp).not.toContain('allow-scripts');
    expect(csp).toContain("default-src 'none'");
  });

  it('handles SVG mime parameters and casing', () => {
    const h = safeDownloadHeaders('IMAGE/SVG+XML; charset=utf-8', 'logo.svg');
    expect(h['content-type']).toBe('image/svg+xml');
    expect(h['content-disposition']).toMatch(/^inline;/);
    expect(h['content-security-policy']).toContain('sandbox');
  });

  it('forces HTML to an attachment', () => {
    const h = safeDownloadHeaders('text/html', 'page.html');
    expect(h['content-type']).toBe('application/octet-stream');
    expect(h['content-disposition']).toMatch(/^attachment;/);
  });

  it('renders a PNG inline with its real type', () => {
    const h = safeDownloadHeaders('image/png', 'pic.png');
    expect(h['content-type']).toBe('image/png');
    expect(h['content-disposition']).toMatch(/^inline;/);
    expect(h['x-content-type-options']).toBe('nosniff');
  });

  it('ignores parameters on the mime type and is case-insensitive', () => {
    expect(safeDownloadHeaders('IMAGE/PNG; charset=binary', 'p.png')['content-type']).toBe(
      'image/png',
    );
  });

  it('percent-encodes the filename so it cannot inject header content', () => {
    const h = safeDownloadHeaders('application/pdf', 'a"; evil\r\nx: y.pdf');
    expect(h['content-disposition']).not.toContain('"');
    expect(h['content-disposition']).not.toContain('\r');
    expect(h['content-disposition']).not.toContain('\n');
    expect(h['content-disposition']).toContain("filename*=UTF-8''");
  });

  it('treats empty/unknown types as non-inline downloads', () => {
    expect(safeDownloadHeaders('', 'x')['content-disposition']).toMatch(/^attachment;/);
    expect(safeDownloadHeaders(null, 'x')['content-type']).toBe('application/octet-stream');
  });
});
