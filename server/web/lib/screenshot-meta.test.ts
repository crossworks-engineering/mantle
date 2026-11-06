/**
 * The screenshot metadata a client sends (POST /api/screenshots `meta`):
 * an allowlist, unknown keys stripped, every string capped, the server's
 * time when the client sent no capturedAt, and a plain message for a 400.
 */
import { describe, expect, it } from 'vitest';
import { parseScreenshotMeta, SCREENSHOT_META_MAX_CHARS } from './screenshot-meta';

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

  it('accepts null ids, a time with an offset', () => {
    const meta = ok({ itemId: null, workspaceId: ID, capturedAt: '2026-11-06T12:00:00+02:00' });
    expect(meta).toEqual({
      itemId: null,
      workspaceId: ID,
      capturedAt: '2026-11-06T12:00:00+02:00',
    });
  });

  it('not JSON, or too long: a plain message', () => {
    expect(bad('{"a":')).toBe('meta is not valid JSON');
    expect(bad(`"${'x'.repeat(SCREENSHOT_META_MAX_CHARS)}"`)).toBe('meta is too long');
  });
});
