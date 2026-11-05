/**
 * The SCIM shapes as Entra ID and Okta send them (lib/scim/shapes.ts), and
 * the token gate (settings.ts): pure, no database.
 */
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  parseFilter,
  parsePage,
  parsePatch,
  parseUserBody,
  scimBool,
  toScimUser,
  SCIM_PATCH,
  SCIM_USER,
} from './shapes';
import {
  issuerTenant,
  newScimToken,
  scimAutoLinkOn,
  scimOn,
  scimTokenHash,
  scimTokenMatches,
} from './settings';

afterEach(() => {
  vi.unstubAllEnvs();
});

const patch = (...Operations: unknown[]) => ({ schemas: [SCIM_PATCH], Operations });

describe('scimBool', () => {
  it('reads booleans and the strings Entra sends', () => {
    expect(scimBool(true)).toBe(true);
    expect(scimBool(false)).toBe(false);
    expect(scimBool('False')).toBe(false);
    expect(scimBool('TRUE')).toBe(true);
    expect(scimBool(' false ')).toBe(false);
    expect(scimBool('no')).toBeUndefined();
    expect(scimBool(0)).toBeUndefined();
    expect(scimBool(null)).toBeUndefined();
  });
});

describe('parsePatch', () => {
  it('reads Entra\'s disable: Replace with a path and "False"', () => {
    const r = parsePatch(patch({ op: 'Replace', path: 'active', value: 'False' }));
    expect(r).toEqual({ ok: true, value: { active: false } });
  });

  it('reads lower-case replace and a real boolean', () => {
    expect(parsePatch(patch({ op: 'replace', path: 'active', value: false }))).toEqual({
      ok: true,
      value: { active: false },
    });
  });

  it('reads an operation with no path whose value is an object', () => {
    const r = parsePatch(
      patch({ op: 'replace', value: { active: false, displayName: 'Ada L', externalId: 'e-1' } }),
    );
    expect(r).toEqual({
      ok: true,
      value: { active: false, displayName: 'Ada L', externalId: 'e-1' },
    });
  });

  it("strips the core schema's URN from a path", () => {
    const r = parsePatch(patch({ op: 'Replace', path: `${SCIM_USER}:active`, value: 'True' }));
    expect(r).toEqual({ ok: true, value: { active: true } });
  });

  it('leaves attributes Mantle does not keep alone, so a disable still applies', () => {
    const r = parsePatch(
      patch(
        { op: 'Add', path: 'emails[type eq "work"].value', value: 'x@example.com' },
        { op: 'Replace', path: 'name.givenName', value: 'Ada' },
        {
          op: 'Add',
          path: 'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User:department',
          value: 'Ops',
        },
        { op: 'Replace', path: 'active', value: 'False' },
      ),
    );
    expect(r).toEqual({ ok: true, value: { active: false } });
  });

  it('reads a userName change (kept by the service) and an externalId removal', () => {
    const r = parsePatch(
      patch(
        { op: 'Replace', path: 'userName', value: 'New.Name@Example.com' },
        { op: 'Remove', path: 'externalId' },
      ),
    );
    expect(r).toEqual({ ok: true, value: { userName: 'new.name@example.com', externalId: null } });
  });

  it('takes the last operation on one attribute', () => {
    const r = parsePatch(
      patch(
        { op: 'replace', path: 'active', value: false },
        { op: 'replace', path: 'active', value: true },
      ),
    );
    expect(r).toEqual({ ok: true, value: { active: true } });
  });

  it('trims a display name to one line and the longest a login keeps', () => {
    const r = parsePatch(
      patch({ op: 'replace', path: 'displayName', value: `A\nB${'x'.repeat(200)}` }),
    );
    expect(r.ok && r.value.displayName?.length).toBe(120);
    expect(r.ok && r.value.displayName?.startsWith('A B')).toBe(true);
  });

  it('refuses only a body that is no PatchOp', () => {
    expect(parsePatch({}).ok).toBe(false);
    expect(parsePatch(null).ok).toBe(false);
    expect(parsePatch(patch()).ok).toBe(false);
  });

  it('leaves out an operation it cannot read and names it, keeping the rest', () => {
    for (const bad of [
      { op: 'move', path: 'active', value: true },
      { op: 'replace', path: 'active', value: 'maybe' },
      { op: 'remove' },
      { op: 'replace', value: 'x' },
      { op: 'replace', path: 'externalId', value: 'x'.repeat(256) },
      { op: 'replace', path: 'displayName', value: 7 },
      { op: 'replace', path: 7, value: 'x' },
      'not an operation',
    ]) {
      const r = parsePatch(patch(bad, { op: 'Replace', path: 'active', value: 'False' }));
      expect(r.ok, JSON.stringify(bad)).toBe(true);
      expect(r.ok && r.value.active, JSON.stringify(bad)).toBe(false);
      expect(r.ok && r.problem?.detail, JSON.stringify(bad)).toBeTruthy();
    }
  });

  it('never checks a userName (the service keeps the email)', () => {
    const r = parsePatch(
      patch(
        { op: 'replace', path: 'userName', value: 'x@corp.local' },
        { op: 'replace', path: 'active', value: false },
      ),
    );
    expect(r).toEqual({ ok: true, value: { userName: 'x@corp.local', active: false } });
  });

  it('drops control and format characters from a display name (no bidi tricks)', () => {
    const r = parsePatch(
      patch({ op: 'replace', path: 'displayName', value: 'Ada\u202E nimda\u200B\u0007 L' }),
    );
    expect(r.ok && r.value.displayName).toBe('Ada nimda L');
  });
});

describe('parseUserBody', () => {
  it('reads an Entra create', () => {
    const r = parseUserBody(
      {
        schemas: [SCIM_USER],
        externalId: 'abc-123',
        userName: 'Ada@Example.com',
        active: true,
        displayName: 'Ada Lovelace',
        emails: [{ primary: true, type: 'work', value: 'ada@example.com' }],
        name: { formatted: 'Ada Lovelace', familyName: 'Lovelace', givenName: 'Ada' },
      },
      'create',
    );
    expect(r).toEqual({
      ok: true,
      value: {
        userName: 'ada@example.com',
        active: true,
        displayName: 'Ada Lovelace',
        externalId: 'abc-123',
      },
    });
  });

  it('defaults to active and takes the name from name parts when no displayName', () => {
    const r = parseUserBody(
      { userName: 'b@example.com', name: { givenName: 'Bo', familyName: 'Ek' } },
      'create',
    );
    expect(r).toEqual({
      ok: true,
      value: { userName: 'b@example.com', active: true, displayName: 'Bo Ek' },
    });
  });

  it('reads active "False" (an Okta or Entra create of a blocked person)', () => {
    const r = parseUserBody({ userName: 'c@example.com', active: 'False' }, 'create');
    expect(r.ok && r.value.active).toBe(false);
  });

  it('a create refuses a userName that is no email, and names a bad active', () => {
    expect(parseUserBody({ userName: 'ada' }, 'create').ok).toBe(false);
    expect(parseUserBody({}, 'create').ok).toBe(false);
    expect(parseUserBody(null, 'create').ok).toBe(false);
    const r = parseUserBody({ userName: 'a@example.com', active: 'yes' }, 'create');
    expect(r.ok && r.problem?.detail).toBe('active must be true or false.');
  });

  it('a replace (PUT) leaves active as it is when absent, and never checks userName', () => {
    expect(parseUserBody({ userName: 'x@corp.local', displayName: 'X' }, 'replace')).toEqual({
      ok: true,
      value: { userName: 'x@corp.local', displayName: 'X' },
    });
    const off = parseUserBody(
      { userName: 'x', active: 'False', externalId: 'y'.repeat(300) },
      'replace',
    );
    expect(off.ok && off.value.active).toBe(false);
    expect(off.ok && off.problem?.detail).toMatch(/externalId/);
  });
});

describe('parseFilter', () => {
  it('reads the filters Entra and Okta send', () => {
    expect(parseFilter('userName eq "ada@example.com"')).toEqual({
      attr: 'userName',
      value: 'ada@example.com',
    });
    expect(parseFilter('USERNAME EQ "x"')).toEqual({ attr: 'userName', value: 'x' });
    expect(parseFilter('externalId eq "a\\"b"')).toEqual({ attr: 'externalId', value: 'a"b' });
    expect(parseFilter('id eq "00000000-0000-0000-0000-000000000000"')).toEqual({
      attr: 'id',
      value: '00000000-0000-0000-0000-000000000000',
    });
    expect(parseFilter(null)).toBeNull();
    expect(parseFilter('  ')).toBeNull();
  });

  it('refuses any other filter (never a list of everyone in its place)', () => {
    expect(parseFilter('userName sw "a"')).toBe('bad');
    expect(parseFilter('userName eq "a" or userName eq "b"')).toBe('bad');
    expect(parseFilter('displayName eq "a"')).toBe('bad');
    expect(parseFilter('userName eq a')).toBe('bad');
  });
});

describe('parsePage', () => {
  it('bounds startIndex and count', () => {
    expect(parsePage(new URLSearchParams(''))).toEqual({ startIndex: 1, count: 100 });
    expect(parsePage(new URLSearchParams('startIndex=0&count=9999'))).toEqual({
      startIndex: 1,
      count: 200,
    });
    expect(parsePage(new URLSearchParams('startIndex=99999999999999999999'))).toEqual({
      startIndex: 1_000_000_000,
      count: 100,
    });
    expect(parsePage(new URLSearchParams('startIndex=x&count=-3'))).toEqual({
      startIndex: 1,
      count: 0,
    });
  });
});

describe('toScimUser', () => {
  it('answers a login as a User', () => {
    const u = toScimUser(
      {
        id: 'id-1',
        email: 'ada@example.com',
        displayName: 'Ada',
        disabled: true,
        externalId: 'e-1',
        createdAt: new Date('2026-11-05T00:00:00Z'),
      },
      'https://box.example/scim/v2',
    );
    expect(u).toMatchObject({
      schemas: [SCIM_USER],
      id: 'id-1',
      externalId: 'e-1',
      userName: 'ada@example.com',
      displayName: 'Ada',
      active: false,
      meta: { resourceType: 'User', location: 'https://box.example/scim/v2/Users/id-1' },
    });
  });
});

describe('the token', () => {
  it('is off with no hash, and with a value that is no sha256', () => {
    vi.stubEnv('MANTLE_SCIM_TOKEN_HASH', '');
    expect(scimOn()).toBe(false);
    vi.stubEnv('MANTLE_SCIM_TOKEN_HASH', 'not-a-hash');
    expect(scimOn()).toBe(false);
    vi.stubEnv('MANTLE_SCIM_TOKEN_HASH', 'ab'.repeat(31));
    expect(scimOn()).toBe(false);
  });

  it('matches only the token whose hash the .env names', () => {
    const { token, hash } = newScimToken();
    expect(hash).toBe(createHash('sha256').update(token).digest('hex'));
    expect(token.length).toBeGreaterThanOrEqual(43);
    vi.stubEnv('MANTLE_SCIM_TOKEN_HASH', hash.toUpperCase());
    const h = scimTokenHash()!;
    expect(scimOn()).toBe(true);
    expect(scimTokenMatches(token, h)).toBe(true);
    expect(scimTokenMatches(`${token}x`, h)).toBe(false);
    expect(scimTokenMatches('', h)).toBe(false);
    expect(scimTokenMatches(hash, h)).toBe(false);
  });

  it('makes a new token each time', () => {
    expect(newScimToken().token).not.toBe(newScimToken().token);
  });
});

describe('the auto-link settings', () => {
  it('names a tenant only for an Entra issuer with a tenant id in its path', () => {
    const t = '7d8b2c4e-1a2b-4c3d-8e9f-0a1b2c3d4e5f';
    expect(issuerTenant(`https://login.microsoftonline.com/${t}/v2.0`)).toBe(t);
    expect(issuerTenant(`https://login.microsoftonline.com/${t.toUpperCase()}/v2.0/`)).toBe(t);
    expect(issuerTenant(`https://login.microsoftonline.us/${t}/v2.0`)).toBe(t);
    expect(issuerTenant('https://login.microsoftonline.com/common/v2.0')).toBeNull();
    expect(issuerTenant('https://login.microsoftonline.com/organizations/v2.0')).toBeNull();
    // A GUID in another provider's issuer is no Entra tenant.
    expect(issuerTenant(`https://idp.example.com/realms/${t}`)).toBeNull();
    expect(issuerTenant(`http://login.microsoftonline.com/${t}/v2.0`)).toBeNull();
    expect(issuerTenant('not a url')).toBeNull();
  });

  it('is off unless set to on, and only while SCIM is on', () => {
    const { hash } = newScimToken();
    vi.stubEnv('MANTLE_SCIM_TOKEN_HASH', hash);
    for (const v of ['', 'off', 'false', 'maybe']) {
      vi.stubEnv('MANTLE_SCIM_AUTO_LINK', v);
      expect(scimAutoLinkOn(), v).toBe(false);
    }
    vi.stubEnv('MANTLE_SCIM_AUTO_LINK', 'on');
    expect(scimAutoLinkOn()).toBe(true);
    vi.stubEnv('MANTLE_SCIM_TOKEN_HASH', '');
    expect(scimAutoLinkOn()).toBe(false);
  });
});
