/**
 * The pure half of inbound API keys: the key shape, the v1 path rule and
 * the expiry rule. No database: a malformed key is refused before any read.
 */
import { describe, expect, it } from 'vitest';
import {
  ACCESS_KEY_PREFIX,
  DEFAULT_ACCESS_KEY_EXPIRY_DAYS,
  expiryFromDays,
  isAccessKey,
  isApiV1Path,
  verifyAccessKey,
} from './access-keys';

describe('inbound API keys: pure rules', () => {
  it('knows a key by its prefix only', () => {
    expect(isAccessKey(`${ACCESS_KEY_PREFIX}abc`)).toBe(true);
    expect(isAccessKey('mtlmcpk_abc')).toBe(false);
    expect(isAccessKey('mtlpeer_abc')).toBe(false);
    expect(isAccessKey('')).toBe(false);
    expect(isAccessKey(null)).toBe(false);
  });

  it('accepts /api/v1 and below, nothing that only starts like it', () => {
    expect(isApiV1Path('/api/v1')).toBe(true);
    expect(isApiV1Path('/api/v1/whoami')).toBe(true);
    expect(isApiV1Path('/api/v10/whoami')).toBe(false);
    expect(isApiV1Path('/api/v1x')).toBe(false);
    expect(isApiV1Path('/api/pages')).toBe(false);
    expect(isApiV1Path('/api/mcp')).toBe(false);
  });

  it('refuses a malformed key before it reads anything', async () => {
    for (const bad of [
      'mtlk_',
      'mtlk_short_x',
      `mtlk_abcdefgh_${'a'.repeat(42)}`,
      `mtlk_abcdefgh_${'a'.repeat(44)}`,
      `mtlk_abcd-fgh_${'a'.repeat(43)}`,
      `mtlk_abcdefgh_${'a'.repeat(43)} `,
      `Bearer mtlk_abcdefgh_${'a'.repeat(43)}`,
    ]) {
      expect(await verifyAccessKey(bad)).toEqual({ ok: false, reason: 'malformed' });
    }
  });

  it('defaults the expiry, allows never, and counts days from now', () => {
    const now = Date.UTC(2026, 9, 7);
    const day = 24 * 60 * 60 * 1000;
    expect(expiryFromDays(undefined, now)?.getTime()).toBe(
      now + DEFAULT_ACCESS_KEY_EXPIRY_DAYS * day,
    );
    expect(expiryFromDays(null, now)).toBeNull();
    expect(expiryFromDays(30, now)?.getTime()).toBe(now + 30 * day);
  });
});
