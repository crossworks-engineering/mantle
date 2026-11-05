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
import { newScimToken, scimOn, scimTokenHash, scimTokenMatches } from './settings';

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

  it('refuses what it cannot read', () => {
    expect(parsePatch({}).ok).toBe(false);
    expect(parsePatch(patch()).ok).toBe(false);
    expect(parsePatch(patch({ op: 'move', path: 'active', value: false })).ok).toBe(false);
    expect(parsePatch(patch({ op: 'replace', path: 'active', value: 'maybe' })).ok).toBe(false);
    expect(parsePatch(patch({ op: 'remove' })).ok).toBe(false);
    expect(parsePatch(patch({ op: 'replace', value: 'x' })).ok).toBe(false);
    expect(parsePatch(patch({ op: 'replace', path: 'userName', value: 'not an email' })).ok).toBe(
      false,
    );
    expect(
      parsePatch(patch({ op: 'replace', path: 'externalId', value: 'x'.repeat(256) })).ok,
    ).toBe(false);
  });
});

describe('parseUserBody', () => {
  it('reads an Entra create', () => {
    const r = parseUserBody({
      schemas: [SCIM_USER],
      externalId: 'abc-123',
      userName: 'Ada@Example.com',
      active: true,
      displayName: 'Ada Lovelace',
      emails: [{ primary: true, type: 'work', value: 'ada@example.com' }],
      name: { formatted: 'Ada Lovelace', familyName: 'Lovelace', givenName: 'Ada' },
    });
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
    const r = parseUserBody({
      userName: 'b@example.com',
      name: { givenName: 'Bo', familyName: 'Ek' },
    });
    expect(r).toEqual({
      ok: true,
      value: { userName: 'b@example.com', active: true, displayName: 'Bo Ek' },
    });
  });

  it('reads active "False" (an Okta or Entra create of a blocked person)', () => {
    const r = parseUserBody({ userName: 'c@example.com', active: 'False' });
    expect(r.ok && r.value.active).toBe(false);
  });

  it('refuses a userName that is no email, and a bad active', () => {
    expect(parseUserBody({ userName: 'ada' }).ok).toBe(false);
    expect(parseUserBody({}).ok).toBe(false);
    expect(parseUserBody(null).ok).toBe(false);
    expect(parseUserBody({ userName: 'a@example.com', active: 'yes' }).ok).toBe(false);
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
