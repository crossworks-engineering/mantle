import { describe, expect, it } from 'vitest';
import { sanitizeEmailHtml } from './render';

describe('sanitizeEmailHtml', () => {
  // ── XSS vectors ──────────────────────────────────────────────────────
  it('strips <script> blocks', () => {
    const out = sanitizeEmailHtml('<p>hi</p><script>alert(1)</script>');
    expect(out).not.toContain('<script');
    expect(out).not.toContain('alert');
  });

  it('strips inline event handlers', () => {
    const out = sanitizeEmailHtml('<a href="https://example.com" onclick="alert(1)">click</a>');
    expect(out).not.toContain('onclick');
    expect(out).toContain('href="https://example.com"');
  });

  it('strips <iframe> tags', () => {
    const out = sanitizeEmailHtml('<p>before</p><iframe src="evil"></iframe><p>after</p>');
    expect(out).not.toContain('<iframe');
    expect(out).toContain('<p>before</p>');
    expect(out).toContain('<p>after</p>');
  });

  it('strips javascript: links', () => {
    const out = sanitizeEmailHtml('<a href="javascript:alert(1)">x</a>');
    expect(out).not.toContain('javascript:');
  });

  it('strips javascript: in <img src>', () => {
    const out = sanitizeEmailHtml('<img src="javascript:alert(1)" alt="x">');
    expect(out).not.toContain('javascript:');
  });

  it('strips <style> tags', () => {
    const out = sanitizeEmailHtml('<style>body{display:none}</style><p>hi</p>');
    expect(out).not.toContain('<style');
    expect(out).not.toContain('display:none');
  });

  it('strips <form>, <input>, <button>', () => {
    const out = sanitizeEmailHtml(
      '<form action="x"><input name="u"><button>go</button></form>',
    );
    expect(out).not.toContain('<form');
    expect(out).not.toContain('<input');
    expect(out).not.toContain('<button');
  });

  it('removes url() values from inline styles (no remote-resource side-channel)', () => {
    const out = sanitizeEmailHtml(
      '<div style="background-image: url(https://tracker.example.com/pixel)">x</div>',
    );
    expect(out).not.toContain('tracker.example.com');
    expect(out).not.toContain('url(');
  });

  // ── Image handling ───────────────────────────────────────────────────
  it('keeps normal HTTPS images with no-referrer + lazy loading', () => {
    const out = sanitizeEmailHtml('<img src="https://cdn.example.com/logo.png" alt="logo">');
    expect(out).toContain('src="https://cdn.example.com/logo.png"');
    expect(out).toContain('referrerpolicy="no-referrer"');
    expect(out).toContain('loading="lazy"');
  });

  it('hides 1x1 tracking pixels with display:none', () => {
    const out = sanitizeEmailHtml('<img src="https://tracker.example.com/p" width="1" height="1">');
    expect(out).toContain('style="display:none"');
  });

  // ── Legitimate HTML passes through ───────────────────────────────────
  it('preserves links and rewrites them to open in a new tab', () => {
    const out = sanitizeEmailHtml('<a href="https://example.com">click</a>');
    expect(out).toContain('target="_blank"');
    expect(out).toContain('rel="noopener noreferrer nofollow"');
    expect(out).toContain('href="https://example.com"');
  });

  it('preserves typography and tables', () => {
    const html =
      '<table><tr><td><strong>Bold</strong> and <em>italic</em></td></tr></table>';
    const out = sanitizeEmailHtml(html);
    expect(out).toContain('<strong>Bold</strong>');
    expect(out).toContain('<em>italic</em>');
    expect(out).toContain('<table>');
    expect(out).toContain('<td>');
  });

  it('keeps safe inline styles', () => {
    const out = sanitizeEmailHtml('<p style="color: red; font-size: 14px;">hi</p>');
    expect(out).toContain('color:red');
    expect(out).toContain('font-size:14px');
  });

  it('returns empty string for empty input', () => {
    expect(sanitizeEmailHtml('')).toBe('');
  });
});
