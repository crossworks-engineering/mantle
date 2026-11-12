/**
 * The Control Center's match and run plan (docs/control-center.md, plan
 * sections 3.1, 3.4, 3.5, 3.6), and its input checks.
 */
import { describe, expect, it } from 'vitest';
import {
  checkBan,
  checkBoxUrl,
  checkModelChanges,
  checkSettingChanges,
  loginMatches,
  planBox,
  type ControlBan,
} from './control-center';
import type { ControlLogin } from './schema/control';

const login = (id: string, over: Partial<ControlLogin> = {}): ControlLogin => ({
  id,
  email: `${id}@example.com`,
  owner: false,
  disabled: false,
  archived: false,
  marked: false,
  links: [],
  ...over,
});
const ban = (id: string, over: Partial<ControlBan> = {}): ControlBan => ({
  id,
  kind: 'disable',
  emails: [],
  issuer: null,
  oid: null,
  reason: null,
  madeBy: 'test',
  madeAt: new Date(),
  liftedBy: null,
  liftedAt: null,
  ...over,
});

describe('the match', () => {
  it('matches email lowercase and exact, or issuer plus object id', () => {
    const l = login('a', {
      email: 'Ann@Example.com',
      links: [{ issuer: 'https://idp.example/t1/v2.0', oid: 'ABC' }],
    });
    expect(loginMatches(l, { emails: ['ann@example.com'], issuer: null, oid: null })).toBe(true);
    expect(loginMatches(l, { emails: ['ann+x@example.com'], issuer: null, oid: null })).toBe(false);
    expect(loginMatches(l, { emails: [], issuer: 'https://idp.example/t1/v2.0', oid: 'abc' })).toBe(
      true,
    );
    expect(loginMatches(l, { emails: [], issuer: 'https://idp.example/t2/v2.0', oid: 'abc' })).toBe(
      false,
    );
  });
});

describe('the run plan', () => {
  it('disables matched enabled logins, never the owner, which is reported', () => {
    const p = planBox(
      [login('a'), login('b', { disabled: true }), login('o', { owner: true }), login('z')],
      [ban('b1', { emails: ['a@example.com', 'b@example.com', 'o@example.com'] })],
    );
    expect(p.disable).toEqual(['a']);
    expect(p.owners).toEqual(['o']);
    expect(p.perBan.get('b1')).toEqual({ matched: 3, ownerIds: ['o'] });
    expect(p.enable).toEqual([]);
  });

  it('archives for an archive ban, and leaves an archived login alone', () => {
    const p = planBox(
      [
        login('a', { disabled: true, marked: true }),
        login('b', { archived: true, disabled: true }),
      ],
      [
        ban('d', { emails: ['a@example.com'] }),
        ban('x', { kind: 'archive', emails: ['a@example.com', 'b@example.com'] }),
      ],
    );
    expect(p.archive).toEqual(['a']);
    expect(p.disable).toEqual([]);
  });

  it('enables only a marked login of a lifted disable ban that no active ban matches', () => {
    const lifted = new Date();
    const logins = [
      login('m', { disabled: true, marked: true }),
      login('h', { disabled: true, marked: false }), // a box Admin's disable
      login('s', { disabled: true, marked: true }), // still banned by another
      login('r', { disabled: true, archived: true }), // archived
    ];
    const bans = [
      ban('l', {
        emails: ['m@example.com', 'h@example.com', 's@example.com', 'r@example.com'],
        liftedAt: lifted,
      }),
      ban('a', { emails: ['s@example.com'] }),
      ban('retired', { kind: 'archive', emails: ['m@example.com'], liftedAt: lifted }),
    ];
    const p = planBox(logins, bans);
    expect(p.enable).toEqual(['m']);
    expect(p.disable).toEqual([]);
  });

  it('a retired archive ban never enables', () => {
    const p = planBox(
      [login('m', { disabled: true, marked: true })],
      [ban('x', { kind: 'archive', emails: ['m@example.com'], liftedAt: new Date() })],
    );
    expect(p.enable).toEqual([]);
  });
});

describe('the input checks', () => {
  it('a box URL is an https origin only', () => {
    expect(checkBoxUrl('https://box.example.com/')).toEqual({
      ok: true,
      value: 'https://box.example.com',
    });
    expect(checkBoxUrl('https://box.example.com:8443')).toEqual({
      ok: true,
      value: 'https://box.example.com:8443',
    });
    for (const bad of [
      'http://box.example.com',
      'https://box.example.com/path',
      'https://u:p@box.example.com',
      'https://box.example.com?x=1',
      'box.example.com',
    ]) {
      expect(checkBoxUrl(bad).ok, bad).toBe(false);
    }
  });

  it('a ban needs a key; emails lowercased; issuer and oid together', () => {
    const ok = checkBan({ emails: [' Ann@Example.COM ', 'ann@example.com'] });
    expect(ok).toMatchObject({ ok: true, value: { kind: 'disable', emails: ['ann@example.com'] } });
    expect(checkBan({}).ok).toBe(false);
    expect(checkBan({ emails: ['not-an-email'] }).ok).toBe(false);
    expect(checkBan({ emails: ['a@example.com'], issuer: 'https://idp.example' }).ok).toBe(false);
    expect(checkBan({ issuer: 'http://idp.example', oid: 'x' }).ok).toBe(false);
    expect(checkBan({ issuer: 'https://idp.example/t/v2.0', oid: 'ABC-1' })).toMatchObject({
      ok: true,
      value: { emails: [], oid: 'abc-1' },
    });
  });

  it("a worker's model: a worker kind and a model id, each kind once, nothing else kept", () => {
    expect(
      checkSettingChanges([
        {
          kind: 'workerModel',
          worker: ' Summarizer ',
          provider: ' OpenRouter ',
          endpoint: '',
          model: ' vendor/m-1 ',
        },
      ]),
    ).toEqual({
      ok: true,
      value: [
        {
          kind: 'workerModel',
          worker: 'summarizer',
          provider: 'openrouter',
          endpoint: '',
          model: 'vendor/m-1',
        },
      ],
    });
    // Fields the change does not take are dropped, never sent to a box.
    expect(
      checkSettingChanges([
        {
          kind: 'workerModel',
          worker: 'summarizer',
          model: 'vendor/m',
          provider: 'x',
          endpoint: '',
          baseUrl: 'y',
        },
      ]),
    ).toEqual({
      ok: true,
      value: [
        {
          kind: 'workerModel',
          worker: 'summarizer',
          provider: 'x',
          endpoint: '',
          model: 'vendor/m',
        },
      ],
    });
    const p = 'openrouter';
    for (const bad of [
      { kind: 'workerModel', provider: p, endpoint: '', model: 'vendor/m' },
      { kind: 'workerModel', worker: 'summarizer', provider: p },
      { kind: 'workerModel', worker: 'summarizer', model: 'vendor/m' },
      {
        kind: 'workerModel',
        worker: 'summarizer',
        provider: 'open router',
        endpoint: '',
        model: 'vendor/m',
      },
      { kind: 'workerModel', worker: 'a kind', provider: p, endpoint: '', model: 'vendor/m' },
      { kind: 'workerModel', worker: 'summarizer', provider: p, endpoint: '', model: 'has space' },
      {
        kind: 'workerModel',
        worker: 'summarizer',
        provider: p,
        endpoint: '',
        model: 'a'.repeat(201),
      },
      { kind: 'workerModel', worker: 7, provider: p, endpoint: '', model: 'vendor/m' },
    ]) {
      expect(checkSettingChanges([bad]).ok, JSON.stringify(bad)).toBe(false);
    }
    expect(
      checkSettingChanges([
        { kind: 'workerModel', worker: 'summarizer', provider: p, endpoint: '', model: 'vendor/a' },
        { kind: 'workerModel', worker: 'summarizer', provider: p, endpoint: '', model: 'vendor/b' },
      ]).ok,
    ).toBe(false);
    // Two kinds, and a worker model beside another kind of change: fine.
    expect(
      checkSettingChanges([
        { kind: 'workerModel', worker: 'summarizer', provider: p, endpoint: '', model: 'vendor/a' },
        { kind: 'workerModel', worker: 'reflector', provider: p, endpoint: '', model: 'vendor/a' },
        { kind: 'updateNotice', on: false },
      ]).ok,
    ).toBe(true);
    const many = Array.from({ length: 21 }, (_, i) => ({
      kind: 'workerModel',
      worker: `k${i}`,
      provider: p,
      endpoint: '',
      model: 'vendor/a',
    }));
    expect(checkSettingChanges(many).ok).toBe(false);
    // The endpoint: a 12-hex print or empty, never a URL, and always sent.
    const e = 'a1b2c3d4e5f6';
    expect(
      checkSettingChanges([
        { kind: 'workerModel', worker: 'summarizer', provider: p, endpoint: e, model: 'm' },
      ]),
    ).toMatchObject({ ok: true, value: [{ endpoint: e }] });
    for (const endpoint of ['https://llm.example', 'a1b2c3', 'A1B2C3D4E5F6X', 7]) {
      expect(
        checkSettingChanges([
          { kind: 'workerModel', worker: 'summarizer', provider: p, endpoint, model: 'm' },
        ]).ok,
        String(endpoint),
      ).toBe(false);
    }
  });

  it("an agent's model: the source route is both provider and endpoint, or neither", () => {
    expect(checkModelChanges([{ slug: ' Coder ', model: ' vendor/m ' }])).toEqual({
      ok: true,
      value: [{ kind: 'agentModel', slug: 'coder', model: 'vendor/m' }],
    });
    expect(
      checkModelChanges([
        { slug: 'coder', model: 'vendor/m', provider: 'OpenRouter', endpoint: '', extra: 1 },
      ]),
    ).toEqual({
      ok: true,
      value: [
        {
          kind: 'agentModel',
          slug: 'coder',
          model: 'vendor/m',
          provider: 'openrouter',
          endpoint: '',
        },
      ],
    });
    for (const bad of [
      { slug: 'coder', model: 'vendor/m', provider: 'openrouter' },
      { slug: 'coder', model: 'vendor/m', endpoint: '' },
      { slug: 'coder', model: 'vendor/m', provider: 'open router', endpoint: '' },
      { slug: 'coder', model: 'vendor/m', provider: 'openrouter', endpoint: 'https://x' },
    ]) {
      expect(checkModelChanges([bad]).ok, JSON.stringify(bad)).toBe(false);
    }
  });
});
