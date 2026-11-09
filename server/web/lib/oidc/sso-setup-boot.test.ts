/**
 * The boot lines of the setup screen (boot.ts): part of the lasting record of
 * who set a value. Setup says one warning and reads nothing. A failed read of
 * the row stops nothing. Never a value.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  lines: [] as string[],
  row: null as Record<string, unknown> | null,
  rowFails: false,
  rowReads: 0,
  applied: null as string | null,
  writes: [] as string[],
}));

vi.mock('@mantle/tracing', async (importOriginal) => {
  const say = (t: string) => void h.lines.push(t);
  return {
    ...(await importOriginal<Record<string, unknown>>()),
    log: () => ({ info: say, warn: say, error: say }),
  };
});

vi.mock('./store', () => ({
  activeLoginsWithLinks: async () => [],
  appliedMode: async () => h.applied,
  recordAppliedMode: async (mode: string) => {
    h.writes.push(mode);
    h.applied = mode;
  },
  ssoSetupRow: async () => {
    h.rowReads += 1;
    if (h.rowFails) throw new Error('the database is gone');
    return h.row;
  },
}));

const { oidcBootCheck, scimBootCheck } = await import('./boot');

const LOGIN = '00000000-0000-4000-8000-000000000001';
const AT = new Date('2026-11-06T00:00:00Z');
const SEALED = Buffer.from('sealed-bytes-must-not-print');
const HASH = 'ab'.repeat(32);

beforeEach(() => {
  // SCIM runs on a Control Center only (docs/control-center.md).
  vi.stubEnv('MANTLE_IS_CONTROL_CENTER', 'on');
  h.lines = [];
  h.row = null;
  h.rowFails = false;
  h.rowReads = 0;
  h.applied = null;
  h.writes = [];
  vi.stubEnv('MANTLE_OIDC_ISSUER', 'https://idp.example.invalid');
  vi.stubEnv('MANTLE_OIDC_CLIENT_ID', 'mantle');
  vi.stubEnv('MANTLE_OIDC_CLIENT_SECRET', '');
  vi.stubEnv('MANTLE_PUBLIC_URL', 'https://brain.example.invalid');
  vi.stubEnv('MANTLE_SCIM_TOKEN_HASH', '');
  vi.stubEnv('MANTLE_SCIM_AUTO_LINK', '');
});
afterEach(() => vi.unstubAllEnvs());

describe('oidcBootCheck', () => {
  it('setup: one warning, no read and no write', async () => {
    vi.stubEnv('MANTLE_OIDC_MODE', 'setup');
    h.applied = 'required';
    await oidcBootCheck();
    expect(h.lines).toHaveLength(1);
    expect(h.lines[0]).toContain('MANTLE_OIDC_MODE=setup');
    expect(h.rowReads).toBe(0);
    expect(h.writes).toEqual([]);
  });

  it('off: nothing', async () => {
    vi.stubEnv('MANTLE_OIDC_MODE', 'off');
    await oidcBootCheck();
    expect(h.lines).toEqual([]);
    expect(h.rowReads).toBe(0);
  });

  it.each(['optional', 'required'])(
    '%s: names who set a screen secret, and no value',
    async (m) => {
      vi.stubEnv('MANTLE_OIDC_MODE', m);
      h.row = { secretEnc: SEALED, secretSetBy: LOGIN, secretSetAt: AT };
      await oidcBootCheck();
      const line = h.lines.find((l) => l.includes('setup screen'));
      expect(line).toContain(LOGIN);
      expect(line).toContain('2026-11-06');
      expect(h.lines.join('\n')).not.toContain(SEALED.toString());
    },
  );

  it.each(['optional', 'required'])('%s: warns of a public client', async (m) => {
    vi.stubEnv('MANTLE_OIDC_MODE', m);
    await oidcBootCheck();
    expect(h.lines.some((l) => l.includes('public client'))).toBe(true);
  });

  it('a secret in the .env needs no read of the row', async () => {
    vi.stubEnv('MANTLE_OIDC_MODE', 'optional');
    vi.stubEnv('MANTLE_OIDC_CLIENT_SECRET', 'from-env');
    await oidcBootCheck();
    expect(h.rowReads).toBe(0);
    expect(h.lines.join('\n')).not.toContain('from-env');
  });

  it.each(['optional', 'required'])('%s: a failed read stops nothing', async (m) => {
    vi.stubEnv('MANTLE_OIDC_MODE', m);
    h.rowFails = true;
    await expect(oidcBootCheck()).resolves.toBeUndefined();
    expect(h.writes).toEqual([m]);
    expect(h.lines.some((l) => l.includes('could not read the setup row'))).toBe(true);
  });
});

describe('scimBootCheck', () => {
  it('off: nothing, with no read', async () => {
    vi.stubEnv('MANTLE_OIDC_MODE', 'off');
    await scimBootCheck();
    expect(h.lines).toEqual([]);
    expect(h.rowReads).toBe(0);
  });

  it('a screen token: the on line, and who made it, and no hash', async () => {
    vi.stubEnv('MANTLE_OIDC_MODE', 'setup');
    h.row = { scimTokenHash: HASH, scimSetBy: LOGIN, scimSetAt: AT };
    await scimBootCheck();
    expect(h.lines[0]).toContain('SCIM user provisioning is on');
    expect(h.lines[1]).toContain(LOGIN);
    expect(h.lines.join('\n')).not.toContain(HASH);
  });

  it('a .env token: the on line only', async () => {
    vi.stubEnv('MANTLE_OIDC_MODE', 'optional');
    vi.stubEnv('MANTLE_SCIM_TOKEN_HASH', HASH);
    await scimBootCheck();
    expect(h.lines).toHaveLength(1);
    expect(h.rowReads).toBe(0);
  });
});
