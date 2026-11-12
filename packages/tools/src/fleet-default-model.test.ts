/** The Default Model's checks and view (fleet-default-model.ts), pure. */
import { describe, expect, it } from 'vitest';
import type { ApiKeySummary } from '@mantle/api-keys';
import { checkDefaultModel, defaultModelChoices, defaultModelView } from './fleet-default-model';

const OR = '11111111-1111-4111-8111-111111111111';
const OR2 = '22222222-2222-4222-8222-222222222222';
const ANT = '33333333-3333-4333-8333-333333333333';
const HOST = '44444444-4444-4444-8444-444444444444';

function key(id: string, service: string, label: string, extra: Partial<ApiKeySummary> = {}) {
  return {
    id,
    name: label === 'default' ? service : `${service}/${label}`,
    kind: 'token',
    service,
    label,
    masked: 'sk-1…abcd',
    target: [],
    tags: [],
    needsApproval: false,
    viaTailnet: false,
    anthropicWorkspaceId: null,
    lastUsed: null,
    useCount: 0,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...extra,
  } as ApiKeySummary;
}

const KEYS = [
  key(OR2, 'openrouter', 'work'),
  key(OR, 'openrouter', 'default'),
  key(ANT, 'anthropic', 'default'),
  key(HOST, 'openrouter', 'host', { target: ['example.com'] }),
  key('55555555-5555-4555-8555-555555555555', 'printer-07', 'default', { kind: 'password' }),
];

describe('defaultModelChoices', () => {
  it('lists chat providers with their provider keys only, names sorted', () => {
    const c = defaultModelChoices(KEYS);
    const or = c.find((x) => x.provider === 'openrouter')!;
    expect(or.keys.map((k) => k.id)).toEqual([OR, OR2]);
    expect(c.some((x) => x.provider === 'anthropic')).toBe(true);
    expect(c.some((x) => x.provider === 'printer-07')).toBe(false);
  });

  it('never carries more of a key than its masked hint', () => {
    const k = defaultModelChoices(KEYS)[0]!.keys[0]!;
    expect(Object.keys(k).sort()).toEqual(['id', 'label', 'masked', 'name']);
  });
});

describe('checkDefaultModel', () => {
  it('takes a provider and its own key, lower-cased', () => {
    expect(checkDefaultModel({ provider: ' OpenRouter ', keyId: OR.toUpperCase() }, KEYS)).toEqual({
      provider: 'openrouter',
      keyId: OR,
    });
  });

  it('refuses an unknown provider, a bad id, a missing key and a key of another service', () => {
    expect(() => checkDefaultModel({ provider: 'nope', keyId: OR }, KEYS)).toThrow(/chat model/);
    expect(() => checkDefaultModel({ provider: 'openrouter', keyId: 'x' }, KEYS)).toThrow(/keyId/);
    expect(() =>
      checkDefaultModel(
        { provider: 'openrouter', keyId: '99999999-9999-4999-8999-999999999999' },
        KEYS,
      ),
    ).toThrow(/not found/);
    expect(() => checkDefaultModel({ provider: 'openrouter', keyId: ANT }, KEYS)).toThrow(
      /for anthropic, not openrouter/,
    );
    expect(() => checkDefaultModel({ provider: 'openrouter', keyId: HOST }, KEYS)).toThrow(
      /not openrouter/,
    );
  });
});

describe('defaultModelView', () => {
  it('none set', () => {
    expect(defaultModelView(undefined, KEYS)).toMatchObject({
      provider: null,
      key: null,
      problem: null,
    });
  });

  it('set, with its key', () => {
    const v = defaultModelView({ provider: 'openrouter', keyId: OR2 }, KEYS);
    expect(v).toMatchObject({ provider: 'openrouter', key: { id: OR2 }, problem: null });
    expect(v.providerName).toBeTruthy();
  });

  it('set, but the key is gone', () => {
    const v = defaultModelView({ provider: 'openrouter', keyId: OR2 }, [KEYS[1]!]);
    expect(v).toMatchObject({ provider: 'openrouter', key: null, problem: 'key-missing' });
  });
});
