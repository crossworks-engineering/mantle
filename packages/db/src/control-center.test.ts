/**
 * The Control Center's match and run plan (docs/control-center.md, plan
 * sections 3.1, 3.4, 3.5, 3.6), its input checks, and the sign-in view.
 */
import { describe, expect, it } from 'vitest';
import {
  checkBan,
  checkBoxUrl,
  checkModelChanges,
  checkSettingChanges,
  loginMatches,
  nextSsoView,
  planBox,
  type ControlBan,
} from './control-center';
import { CONTROL_MODEL_ID, CONTROL_MODEL_NOT_SHOWN, type ControlLogin } from './schema/control';

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
      { slug: 'coder', model: 'vendor/m', provider: 7, endpoint: 7 },
      { slug: 'coder', model: 'vendor/m', provider: null, endpoint: null },
    ]) {
      expect(checkModelChanges([bad]).ok, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe('a model id (CONTROL_MODEL_ID)', () => {
  it('takes real ids: an auto-updating alias (~), a variant, a dated version, a tag', () => {
    for (const id of [
      '~x-ai/grok-latest',
      '~anthropic/claude-sonnet-latest',
      'anthropic/claude-sonnet-5',
      'openai/gpt-5:free',
      'claude-opus-5@20260101',
      'qwen2.5:7b',
      'us.anthropic.claude-sonnet-5-v1:0',
      'hf.co/vendor/Model-GGUF:Q4_K_M',
      '@preset/fast',
      'inherit',
      'a'.repeat(200),
      `~${'a'.repeat(199)}`,
    ]) {
      expect(CONTROL_MODEL_ID.test(id), id).toBe(true);
    }
  });

  it('refuses what could break a log line, a shell word or HTML, and the cap', () => {
    for (const id of [
      '',
      'has space',
      ' vendor/m',
      'vendor/m\n',
      'vendor/m\u0000',
      'vendor/m\u202e',
      '"vendor/m"',
      "vendor/m'",
      '<b>vendor</b>',
      'vendor/m;drop',
      'vendor/$(id)',
      'vendor/`id`',
      'vendor/m&x',
      'vendor/m|x',
      'vendor\\m',
      'vendor/m=1',
      'vendor/m,n',
      'vendor/m!',
      'vendor/m#1',
      'vendor/m%20',
      '-vendor/m',
      '.vendor/m',
      '/vendor/m',
      // A tilde or an at sign leads only: never inside, never doubled.
      'vendor/~m',
      '~~vendor/m',
      '~/vendor',
      '~',
      '@',
      '@@x',
      'a'.repeat(201),
      `~${'a'.repeat(200)}`,
      CONTROL_MODEL_NOT_SHOWN,
    ]) {
      expect(CONTROL_MODEL_ID.test(id), JSON.stringify(id)).toBe(false);
    }
  });

  it('a tilde id passes every fleet write that takes a model', () => {
    const m = '~x-ai/grok-latest';
    expect(checkModelChanges([{ slug: 'coder', model: m }])).toEqual({
      ok: true,
      value: [{ kind: 'agentModel', slug: 'coder', model: m }],
    });
    expect(
      checkSettingChanges([
        {
          kind: 'poolEntry',
          pool: 'agents',
          name: 'Grok Latest',
          routes: [{ provider: 'openrouter', model: m }],
        },
        {
          kind: 'workerModel',
          worker: 'summarizer',
          provider: 'openrouter',
          endpoint: '',
          model: m,
        },
      ]),
    ).toMatchObject({
      ok: true,
      value: [{ routes: [{ provider: 'openrouter', model: m }] }, { model: m }],
    });
    // The matrix's marker for an id it did not keep is never a model.
    expect(checkModelChanges([{ slug: 'coder', model: CONTROL_MODEL_NOT_SHOWN }]).ok).toBe(false);
  });
});

describe('the sign-in view (0371)', () => {
  const status = {
    mode: 'setup' as const,
    tenant: null,
    issuer: '',
    issuerFrom: 'none' as const,
    clientId: '',
    clientIdFrom: 'none' as const,
    secret: 'none' as const,
    secretSetAt: null,
    redirectUri: '',
    missing: [],
    linked: null,
    active: null,
  };
  const call = (name: string, fields: string[] = []) => ({ name, by: 'it@example.com', fields });

  it('a status answer replaces the status; a failure keeps it and names its code', () => {
    const v1 = nextSsoView(null, call('sso_status'), { ok: true, reason: null, status }, 't1');
    expect(v1).toEqual({ at: 't1', reason: null, status, test: null, set: null, mode: null });
    const v2 = nextSsoView(v1, call('sso_status'), { ok: false, reason: 'bad-call' }, 't2');
    expect(v2).toMatchObject({ at: 't2', reason: 'bad-call', status });
  });

  it('a Test keeps its code; a save its fields and outcome, never a value', () => {
    const t = nextSsoView(
      null,
      call('sso_test'),
      { ok: true, reason: null, test: 'ok', status },
      't1',
    );
    expect(t.test).toEqual({ code: 'ok', at: 't1', by: 'it@example.com' });
    const s = nextSsoView(
      t,
      call('sso_set', ['secret']),
      { ok: false, reason: 'test', test: 'secret-refused', status },
      't2',
    );
    expect(s.set).toEqual({
      fields: ['secret'],
      ok: false,
      reason: 'test',
      by: 'it@example.com',
      at: 't2',
    });
    expect(s.test?.code).toBe('secret-refused');
    // A later status keeps the last save and Test.
    const after = nextSsoView(s, call('sso_status'), { ok: true, reason: null, status }, 't3');
    expect(after.set).toEqual(s.set);
    expect(after.test).toEqual(s.test);
  });

  it('a raise keeps the mode asked, the mode before and its outcome (0372)', () => {
    const up = nextSsoView(
      null,
      { ...call('sso_mode'), to: 'optional' },
      { ok: true, reason: null, from: 'setup', status: { ...status, mode: 'optional' } },
      't1',
    );
    expect(up.mode).toEqual({
      to: 'optional',
      from: 'setup',
      ok: true,
      reason: null,
      by: 'it@example.com',
      at: 't1',
    });
    const refused = nextSsoView(
      up,
      { ...call('sso_mode'), to: 'setup' },
      { ok: false, reason: 'mode', from: 'optional', status },
      't2',
    );
    expect(refused.mode).toMatchObject({
      to: 'setup',
      from: 'optional',
      ok: false,
      reason: 'mode',
    });
    // A save that went through with no Test of its own makes the last Test
    // stale: it is dropped (the page asks a new one before turning on).
    const tested = nextSsoView(
      null,
      call('sso_test'),
      { ok: true, reason: null, test: 'ok', status },
      't1',
    );
    expect(
      nextSsoView(tested, call('sso_set', ['clientId']), { ok: true, reason: null, status }, 't2')
        .test,
    ).toBeNull();
    expect(
      nextSsoView(
        tested,
        call('sso_set', ['clientId']),
        { ok: false, reason: 'mode', status },
        't2',
      ).test,
    ).toEqual(tested.test);
    // A later status keeps the last raise.
    expect(
      nextSsoView(refused, call('sso_status'), { ok: true, reason: null, status }, 't3').mode,
    ).toEqual(refused.mode);
  });
});
