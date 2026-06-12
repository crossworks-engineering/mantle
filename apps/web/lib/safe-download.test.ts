import { describe, expect, it } from 'vitest';
import { safeDownloadHeaders } from './safe-download';

describe('safeDownloadHeaders', () => {
  it('forces SVG to an attachment octet-stream (no inline script execution)', () => {
    const h = safeDownloadHeaders('image/svg+xml', 'logo.svg');
    expect(h['content-type']).toBe('application/octet-stream');
    expect(h['content-disposition']).toMatch(/^attachment;/);
    expect(h['x-content-type-options']).toBe('nosniff');
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
