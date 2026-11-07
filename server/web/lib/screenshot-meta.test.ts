/**
 * The screenshot metadata a client sends (POST /api/screenshots `meta`):
 * an allowlist, unknown keys stripped, every string capped, the server's
 * time when the client sent no capturedAt, and a plain message for a 400.
 * A lone UTF-16 surrogate (half an emoji) is replaced and a NUL removed,
 * never stored.
 */
import { describe, expect, it } from 'vitest';
import {
  jsonNestsDeeperThan,
  parseScreenshotMeta,
  SCREENSHOT_META_MAX_CHARS,
  SCREENSHOT_META_MAX_DEPTH,
  wellFormedStrings,
} from './screenshot-meta';

const NOW = new Date('2026-11-06T10:15:00.000Z');
const ID = '0b7c6a1e-2f4d-4c1a-9e8b-5d3f2a1c0e9f';

const ok = (raw: unknown) => {
  const out = parseScreenshotMeta(typeof raw === 'string' ? raw : JSON.stringify(raw), NOW);
  if (!out.ok) throw new Error(out.error);
  return out.meta;
};
const bad = (raw: unknown) => {
  const out = parseScreenshotMeta(typeof raw === 'string' ? raw : JSON.stringify(raw), NOW);
  if (out.ok) throw new Error('accepted');
  return out.error;
};

describe('parseScreenshotMeta', () => {
  it('keeps every allowed key as sent', () => {
    const full = {
      route: '/files?folder=x',
      screen: 'Files',
      itemId: ID,
      itemTitle: 'Q1 report',
      workspaceId: null,
      capturedAt: '2026-11-06T10:14:59.000Z',
      viewport: { w: 1440, h: 900 },
      dpr: 2,
      rect: { x: 0, y: 12, w: 640, h: 480 },
      appVersion: '0.9.11',
      shell: 'desktop',
      note: 'the toolbar overlaps',
    };
    expect(ok(full)).toEqual(full);
  });

  it('strips unknown keys, at the top and inside', () => {
    const meta = ok({ screen: 'Home', html: '<b>', viewport: { w: 1, h: 1, z: 3 } });
    expect(meta).toEqual({
      screen: 'Home',
      viewport: { w: 1, h: 1 },
      capturedAt: NOW.toISOString(),
    });
  });

  it('no meta, or an empty one: only the server time', () => {
    for (const raw of [undefined, null, '', '  ', '{}']) {
      const out = parseScreenshotMeta(raw as string | null | undefined, NOW);
      expect(out).toEqual({ ok: true, meta: { capturedAt: NOW.toISOString() } });
    }
  });

  it('caps every string', () => {
    expect(bad({ route: 'r'.repeat(501) })).toMatch(/^invalid meta: route/);
    expect(ok({ route: 'r'.repeat(500) }).route).toHaveLength(500);
    expect(bad({ screen: 's'.repeat(201) })).toMatch(/screen/);
    expect(bad({ itemTitle: 't'.repeat(301) })).toMatch(/itemTitle/);
    expect(bad({ appVersion: 'v'.repeat(41) })).toMatch(/appVersion/);
    expect(bad({ note: 'n'.repeat(2001) })).toMatch(/note/);
  });

  it('refuses a bad id, time, shell, number or shape', () => {
    expect(bad({ itemId: 'not-a-uuid' })).toMatch(/itemId/);
    expect(bad({ workspaceId: 42 })).toMatch(/workspaceId/);
    expect(bad({ capturedAt: 'yesterday' })).toMatch(/capturedAt/);
    expect(bad({ shell: 'cli' })).toMatch(/shell/);
    expect(bad({ viewport: { w: 0, h: 10 } })).toMatch(/viewport/);
    expect(bad({ viewport: { w: 20001, h: 10 } })).toMatch(/viewport/);
    expect(bad({ viewport: { w: 1.5, h: 10 } })).toMatch(/viewport/);
    expect(bad({ dpr: 0.25 })).toMatch(/dpr/);
    expect(bad({ dpr: 9 })).toMatch(/dpr/);
    expect(bad({ rect: { x: -1, y: 0, w: 1, h: 1 } })).toMatch(/rect/);
    expect(bad({ route: 7 })).toMatch(/route/);
    expect(bad([])).toMatch(/^invalid meta/);
    expect(bad('null')).toMatch(/^invalid meta/);
  });

  it('accepts what a capture with no picked item sends: both item fields null', () => {
    expect(ok({ itemId: null, itemTitle: null })).toMatchObject({ itemId: null, itemTitle: null });
  });

  it('accepts null ids, a time with an offset', () => {
    const meta = ok({ itemId: null, workspaceId: ID, capturedAt: '2026-11-06T12:00:00+02:00' });
    expect(meta).toEqual({
      itemId: null,
      workspaceId: ID,
      capturedAt: '2026-11-06T12:00:00+02:00',
    });
  });

  it('a lone surrogate in any string is replaced by U+FFFD; a whole emoji is kept', () => {
    const cut = '\u{1F600}'.slice(0, 1); // the high half of an emoji
    const low = '\u{1F600}'.slice(1); // the low half alone
    const meta = ok({
      itemTitle: `Plan ${cut}`,
      screen: `${low}Files`,
      note: `ok \u{1F600} and ${cut}${cut}`,
      route: '/files',
      appVersion: `${low}`,
    });
    expect(meta.itemTitle).toBe('Plan \uFFFD');
    expect(meta.screen).toBe('\uFFFDFiles');
    expect(meta.note).toBe('ok \u{1F600} and \uFFFD\uFFFD');
    expect(meta.appVersion).toBe('\uFFFD');
    expect(meta.route).toBe('/files');
    // What jsonb is handed: no escaped lone surrogate left.
    expect(JSON.stringify(meta)).not.toMatch(/\\ud[89ab][0-9a-f]{2}(?!\\ud[c-f])/i);
    expect(JSON.stringify(meta)).not.toMatch(/\\ud[c-f][0-9a-f]{2}/i);
  });

  it('a NUL in any string is removed, at any depth and in keys', () => {
    const meta = ok({ itemTitle: 'Plan\u0000 A', note: '\u0000\u0000', route: '/files\u0000' });
    expect(meta.itemTitle).toBe('Plan A');
    expect(meta.note).toBe('');
    expect(meta.route).toBe('/files');
    expect(JSON.stringify(meta)).not.toContain('\\u0000');
    expect(wellFormedStrings({ ['k\u0000']: ['\u0000v', { x: 'a\u0000' }] })).toEqual({
      k: ['v', { x: 'a' }],
    });
  });

  it('the length is kept, so the caps read as sent', () => {
    const cut = '\u{1F600}'.slice(0, 1);
    const title = `${'a'.repeat(299)}${cut}`;
    expect(ok({ itemTitle: title }).itemTitle).toHaveLength(300);
    expect(bad({ itemTitle: `${title}a` })).toMatch(/^invalid meta: itemTitle/);
  });

  it('wellFormedStrings: strings at any depth and keys too; other values as they are', () => {
    const cut = '\u{1F600}'.slice(0, 1);
    expect(wellFormedStrings({ [`k${cut}`]: [`v${cut}`, 1, null, { x: cut }] })).toEqual({
      'k\uFFFD': ['v\uFFFD', 1, null, { x: '\uFFFD' }],
    });
    expect(wellFormedStrings(3)).toBe(3);
    expect(wellFormedStrings('\u{1F600}')).toBe('\u{1F600}');
  });

  it('nested deeper than 32: a plain 400 message before any parse, on Node and Bun alike', () => {
    expect(SCREENSHOT_META_MAX_DEPTH).toBe(32);
    // 8000 nested arrays fit the 16 KB cap; walking them blew the stack.
    const deep = `${'['.repeat(8000)}${']'.repeat(8000)}`;
    expect(deep.length).toBeLessThanOrEqual(SCREENSHOT_META_MAX_CHARS);
    expect(bad(deep)).toBe('meta is nested too deeply');
    const deepObj = `${'{"a":'.repeat(33)}1${'}'.repeat(33)}`;
    expect(bad(deepObj)).toBe('meta is nested too deeply');
    // In a known key, too.
    expect(bad(`{"note":${'['.repeat(40)}${']'.repeat(40)}}`)).toBe('meta is nested too deeply');
  });

  it('32 deep is read (then the allowlist answers); brackets inside strings do not count', () => {
    const at = `{"x":${'['.repeat(31)}${']'.repeat(31)}}`;
    expect(jsonNestsDeeperThan(at, 32)).toBe(false);
    expect(ok(at)).toEqual({ capturedAt: NOW.toISOString() });
    expect(jsonNestsDeeperThan(`{"note":"${'['.repeat(100)}"}`, 32)).toBe(false);
    expect(ok({ note: `${'[{'.repeat(50)}\\"` }).note).toBe(`${'[{'.repeat(50)}\\"`);
    expect(jsonNestsDeeperThan('{"a":"\\"[[[["}', 2)).toBe(false);
  });

  it('wellFormedStrings never walks past the depth cap', () => {
    let v: unknown = 'leaf';
    for (let i = 0; i < 10_000; i++) v = [v];
    expect(() => wellFormedStrings(v)).not.toThrow();
  });

  it('not JSON, or too long: a plain message', () => {
    expect(bad('{"a":')).toBe('meta is not valid JSON');
    expect(bad(`"${'x'.repeat(SCREENSHOT_META_MAX_CHARS)}"`)).toBe('meta is too long');
  });
});
