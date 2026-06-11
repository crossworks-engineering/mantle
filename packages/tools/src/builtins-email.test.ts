/**
 * Unit tests for the email builtins' pure helpers.
 *
 * Motivating incident (2026-06-11): `email_get` returned the full emails row —
 * a newsletter whose body_html was 56,570 chars wrapping 397 chars of
 * body_text. The 57 KB result spilled, the model paged through HTML soup
 * until max_iters, and the turn 500'd on an empty reply. The handler now
 * returns body_text (canonical) and only falls back to converted HTML; this
 * suite pins the converter so the fallback path stays text, not markup.
 */

import { describe, expect, it } from 'vitest';
import { htmlToPlainText } from './builtins-email';

describe('htmlToPlainText', () => {
  it('strips tags and keeps the text', () => {
    expect(htmlToPlainText('<p>Hello <b>world</b></p>')).toBe('Hello world');
  });

  it('drops style/script/head subtrees entirely', () => {
    const html =
      '<head><title>x</title></head><style>.a{color:red}</style>' +
      '<script>alert(1)</script><p>visible</p>';
    expect(htmlToPlainText(html)).toBe('visible');
  });

  it('turns breaks and block closers into newlines', () => {
    const html = '<div>line one</div><p>line two<br>line three</p>';
    expect(htmlToPlainText(html)).toBe('line one\nline two\nline three');
  });

  it('decodes the common entities', () => {
    expect(htmlToPlainText('Tom &amp; Jerry &lt;3 &quot;cheese&quot;&nbsp;&#39;ok&#39;')).toBe(
      'Tom & Jerry <3 "cheese" \'ok\'',
    );
  });

  it('drops HTML comments (Outlook conditional soup)', () => {
    expect(htmlToPlainText('a<!--[if mso]>junk<![endif]-->b')).toBe('a b');
  });

  it('collapses a marketing-mail skeleton to a fraction of its size', () => {
    // Representative of the incident shape: a little real text inside a lot
    // of table/style scaffolding. The converted text must be drastically
    // smaller and contain the message.
    const filler = '<table style="width:100%"><tr><td style="padding:0">&nbsp;</td></tr></table>';
    const html =
      `<style>${'.x{margin:0} '.repeat(200)}</style>` +
      filler.repeat(50) +
      '<p>Please send your May bank statement.</p>' +
      filler.repeat(50);
    const text = htmlToPlainText(html);
    expect(text).toContain('Please send your May bank statement.');
    expect(text.length).toBeLessThan(html.length / 10);
  });
});
