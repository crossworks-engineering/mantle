import { describe, expect, it } from 'vitest';
import { jsonForScript } from './json-script';

describe('jsonForScript', () => {
  it('round-trips through JSON.parse', () => {
    const value = { elements: [{ id: 'a', text: 'hello' }], appState: { zoom: 1 } };
    expect(JSON.parse(jsonForScript(value))).toEqual(value);
    expect(JSON.parse(jsonForScript(null))).toBeNull();
    expect(JSON.parse(jsonForScript(undefined))).toBeNull();
  });

  it('cannot break out of a script element', () => {
    // The tokenizer scans for `</script`, so an unescaped one in a string
    // value ends the element and everything after it becomes markup.
    const out = jsonForScript({ text: '</script><img src=x onerror=alert(1)>' });
    expect(out).not.toContain('</script');
    expect(out).not.toContain('<img');
    expect(out).not.toContain('<');
    expect(JSON.parse(out)).toEqual({ text: '</script><img src=x onerror=alert(1)>' });
  });

  it('cannot open a comment-like state', () => {
    const out = jsonForScript({ text: '<!--<script>' });
    expect(out).not.toContain('<!--');
    expect(JSON.parse(out)).toEqual({ text: '<!--<script>' });
  });

  it('escapes the line separators JSON.stringify leaves raw', () => {
    // Valid in a JSON string, a literal line terminator to a JS parser.
    const sep = '\u2028\u2029';
    const out = jsonForScript({ text: sep });
    expect(out).not.toContain('\u2028');
    expect(out).not.toContain('\u2029');
    expect(out).toContain('\\u2028');
    expect(JSON.parse(out)).toEqual({ text: sep });
  });

  it('leaves an ampersand-heavy payload parseable', () => {
    const out = jsonForScript({ text: 'a & b &amp; c' });
    expect(out).not.toContain('&');
    expect(JSON.parse(out)).toEqual({ text: 'a & b &amp; c' });
  });
});
