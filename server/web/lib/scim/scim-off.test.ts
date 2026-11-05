/**
 * The hard rule of the corporate plan (section 2.1) for SCIM, as an
 * acceptance test: with MANTLE_SCIM_TOKEN_HASH empty, every SCIM route
 * answers the same plain 404, whatever token is sent, and nothing reads the
 * SCIM rows or changes a login (each would throw here). On, a missing or
 * wrong token is a SCIM 401 that reads nothing either.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  calls: [] as string[],
  owner: '33333333-3333-4333-8333-333333333333' as string | null,
}));

vi.mock('./store', () => {
  const trap =
    (name: string) =>
    (..._args: unknown[]): never => {
      h.calls.push(name);
      throw new Error(`SCIM store read while refused: ${name}`);
    };
  return {
    scimLoginById: trap('scimLoginById'),
    scimLoginByUserName: trap('scimLoginByUserName'),
    scimLoginByExternalId: trap('scimLoginByExternalId'),
    scimLoginPage: trap('scimLoginPage'),
    emailTaken: trap('emailTaken'),
    createScimLogin: trap('createScimLogin'),
    writeScimRow: trap('writeScimRow'),
    scimLoginFacts: trap('scimLoginFacts'),
    stillDisabledByScim: trap('stillDisabledByScim'),
    // The one read the routes make before their own work: noted, answered.
    brainOwnerId: async () => {
      h.calls.push('brainOwnerId');
      return h.owner;
    },
    scimCounts: trap('scimCounts'),
  };
});

vi.mock('@/lib/login-update', () => ({
  applyLoginChange: () => {
    h.calls.push('applyLoginChange');
    throw new Error('a login change while refused');
  },
  loadLoginTarget: () => {
    h.calls.push('loadLoginTarget');
    throw new Error('a login read while refused');
  },
}));

const users = await import('@/app/scim/v2/Users/route');
const user = await import('@/app/scim/v2/Users/[id]/route');
const spc = await import('@/app/scim/v2/ServiceProviderConfig/route');
const types = await import('@/app/scim/v2/ResourceTypes/route');
const schemas = await import('@/app/scim/v2/Schemas/route');
const { newScimToken } = await import('./settings');

const ID = '11111111-1111-4111-8111-111111111111';
const ctx = { params: Promise.resolve({ id: ID }) };
const BASE = 'https://box.example/scim/v2';

function req(path: string, method: string, token?: string, body?: unknown): Request {
  return new Request(`${BASE}${path}`, {
    method,
    headers: {
      ...(token !== undefined ? { authorization: `Bearer ${token}` } : {}),
      'content-type': 'application/scim+json',
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

/** Every SCIM route and method, once, with `token`. */
async function everyRoute(token?: string): Promise<Response[]> {
  const disable = {
    schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
    Operations: [{ op: 'Replace', path: 'active', value: 'False' }],
  };
  const create = { userName: 'ada@example.com' };
  return Promise.all([
    users.GET(req('/Users?filter=userName%20eq%20%22ada%40example.com%22', 'GET', token)),
    users.POST(req('/Users', 'POST', token, create)),
    user.GET(req(`/Users/${ID}`, 'GET', token), ctx),
    user.PATCH(req(`/Users/${ID}`, 'PATCH', token, disable), ctx),
    user.PUT(req(`/Users/${ID}`, 'PUT', token, create), ctx),
    user.DELETE(req(`/Users/${ID}`, 'DELETE', token), ctx),
    spc.GET(req('/ServiceProviderConfig', 'GET', token)),
    types.GET(req('/ResourceTypes', 'GET', token)),
    schemas.GET(req('/Schemas', 'GET', token)),
  ]);
}

beforeEach(() => {
  h.calls.length = 0;
  h.owner = '33333333-3333-4333-8333-333333333333';
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('SCIM off (no token hash set)', () => {
  it('answers every route the same plain 404 and reads nothing', async () => {
    vi.stubEnv('MANTLE_SCIM_TOKEN_HASH', '');
    const { token } = newScimToken();
    for (const t of [undefined, '', token, 'anything']) {
      const answers = await everyRoute(t);
      for (const res of answers) {
        expect(res.status).toBe(404);
        expect(res.headers.get('content-type')).toContain('application/json');
        expect(await res.json()).toEqual({ error: 'not found' });
      }
    }
    expect(h.calls).toEqual([]);
  });

  it('a value that is no sha256 is off too', async () => {
    vi.stubEnv('MANTLE_SCIM_TOKEN_HASH', 'secret-in-the-wrong-place');
    const answers = await everyRoute('secret-in-the-wrong-place');
    for (const res of answers) expect(res.status).toBe(404);
    expect(h.calls).toEqual([]);
  });
});

describe('SCIM on', () => {
  it('a missing or wrong token is a SCIM 401 and reads nothing', async () => {
    const { token, hash } = newScimToken();
    vi.stubEnv('MANTLE_SCIM_TOKEN_HASH', hash);
    for (const t of [undefined, '', `${token}x`, hash, 'Basic x']) {
      for (const res of await everyRoute(t)) {
        expect(res.status).toBe(401);
        expect(res.headers.get('content-type')).toContain('application/scim+json');
        expect(res.headers.get('www-authenticate')).toBe('Bearer');
        const body = (await res.json()) as { schemas: string[]; status: string };
        expect(body.schemas).toEqual(['urn:ietf:params:scim:api:messages:2.0:Error']);
        expect(body.status).toBe('401');
      }
    }
    expect(h.calls).toEqual([]);
  });

  it('serves the discovery documents with the token', async () => {
    const { token, hash } = newScimToken();
    vi.stubEnv('MANTLE_SCIM_TOKEN_HASH', hash);
    const res = await spc.GET(req('/ServiceProviderConfig', 'GET', token));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/scim+json');
    const body = (await res.json()) as {
      patch: { supported: boolean };
      bulk: { supported: boolean };
    };
    expect(body.patch.supported).toBe(true);
    expect(body.bulk.supported).toBe(false);
    const rt = (await (await types.GET(req('/ResourceTypes', 'GET', token))).json()) as {
      Resources: Array<{ id: string; endpoint: string }>;
    };
    expect(rt.Resources.map((r) => r.endpoint)).toEqual(['/Users']);
    expect((await schemas.GET(req('/Schemas', 'GET', token))).status).toBe(200);
    expect(h.calls).toEqual([]);
  });

  it('refuses a filter it does not read with a SCIM 400, reading nothing', async () => {
    const { token, hash } = newScimToken();
    vi.stubEnv('MANTLE_SCIM_TOKEN_HASH', hash);
    const res = await users.GET(req('/Users?filter=displayName%20sw%20%22a%22', 'GET', token));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { scimType: string }).scimType).toBe('invalidFilter');
    expect(h.calls).toEqual(['brainOwnerId']);
  });

  it('a box with no original account yet answers 503 on every Users route, writing nothing', async () => {
    const { token, hash } = newScimToken();
    vi.stubEnv('MANTLE_SCIM_TOKEN_HASH', hash);
    h.owner = null;
    const answers = await everyRoute(token);
    // The six Users routes wait for the box; the discovery documents do not.
    expect(answers.map((r) => r.status)).toEqual([503, 503, 503, 503, 503, 503, 200, 200, 200]);
    expect(new Set(h.calls)).toEqual(new Set(['brainOwnerId']));
  });
});
