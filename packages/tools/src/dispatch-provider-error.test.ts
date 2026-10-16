/**
 * A10 #10 fix round 2: a builtin that throws a model provider's failure (a
 * query embed's ProviderHttpError, OpenRouter's SDK error) answers the fixed
 * sentence as its tool text, never the provider's body (an account id, an
 * organisation name, part of a key). The detail is logged server side. Our
 * own errors keep their text, as on main: the model needs a validation
 * message or a domain refusal to correct its call.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Tool } from '@mantle/db';
import { InputError, ProviderHttpError, errorMessage } from '@mantle/std';
import { dispatchTool } from './dispatch';
import { appBrokerCaller, ownerWebCaller } from './gate-callers';
import { ensureGateReady } from './gate-narrowers';
import { registerBuiltin } from './registry';
import type { BuiltinToolDef, ToolHandlerContext } from './types';

const SECRET = 'sk-or-v1-0123456789abcdef org=acme-private';

function probe(slug: string, throws: () => Error): BuiltinToolDef {
  return {
    slug,
    name: slug,
    description: 'probe',
    inputSchema: { type: 'object', properties: {} },
    policy: { effect: 'read', spends: 'none', scope: 'any' },
    readOnly: true,
    handler: async () => {
      throw throws();
    },
  };
}

const row = (slug: string) =>
  ({ slug, handler: { kind: 'builtin', ref: slug } }) as unknown as Tool;
const allowed = (slug: string) => ({ ok: true as const, tool: row(slug) });

beforeAll(() => {
  ensureGateReady();
  registerBuiltin(
    probe(
      'provider_probe_embed',
      () =>
        new ProviderHttpError({
          provider: 'openai',
          status: 401,
          body: SECRET,
          what: 'embeddings',
        }),
    ),
  );
  registerBuiltin(
    probe('provider_probe_sdk', () => {
      const inner = Object.assign(new Error('Provider returned error'), {
        statusCode: 400,
        body: JSON.stringify({ error: { message: 'bad', metadata: { raw: SECRET } } }),
      });
      return new Error(`openrouter-chat 400 on some/model: bad metadata=${SECRET}`, {
        cause: inner,
      });
    }),
  );
  registerBuiltin(
    probe('provider_probe_input', () => new InputError('entry_date must be a valid date')),
  );
  registerBuiltin(probe('provider_probe_plain', () => new Error('fetch failed: 404 Not Found')));
  // A tool that catches a provider failure and replies errorMessage(err).
  registerBuiltin({
    ...probe('provider_probe_reply', () => new Error('unused')),
    handler: async () => ({
      ok: false,
      error: errorMessage(new ProviderHttpError({ provider: 'openai', status: 500, body: SECRET })),
    }),
  });
});

let logged: string[] = [];
beforeEach(() => {
  logged = [];
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
    logged.push(a.map((x) => (x instanceof Error ? x.message : String(x))).join(' '));
  });
});
afterEach(() => vi.restoreAllMocks());

const SURFACES: Array<[string, () => Parameters<typeof dispatchTool>[2]]> = [
  ["the owner's web", () => ({ ownerId: 'o', caller: ownerWebCaller() })],
  [
    'a member app broker (team)',
    () => {
      const surface: NonNullable<ToolHandlerContext['surface']> = {
        kind: 'team',
        loginId: 'l1',
        privateReads: false,
      };
      return { ownerId: 'o', surface, caller: appBrokerCaller(surface, allowed(SLUG)) };
    },
  ],
];
let SLUG = '';

async function call(slug: string, ctx: () => Parameters<typeof dispatchTool>[2]) {
  SLUG = slug;
  const res = await dispatchTool(row(slug), {}, ctx());
  expect(res.ok).toBe(false);
  return (res as { error: string }).error;
}

describe("dispatch: a builtin's provider failure is the fixed sentence (A10 #10 fix round 2)", () => {
  for (const [name, ctx] of SURFACES) {
    it(`${name}: a ProviderHttpError (a query embed) never passes its body`, async () => {
      const error = await call('provider_probe_embed', ctx);
      expect(error).toBe('The provider refused the API key. (openai, HTTP 401)');
      expect(error).not.toContain('sk-or-v1');
      // A refused key is logged by provider and status only (model picker
      // fix round 1, L2): its body can echo the key.
      expect(logged.join('\n')).toContain('openai refused the key (HTTP 401)');
      expect(logged.join('\n')).not.toContain('acme-private');
    });

    it(`${name}: an SDK's own error the classifier does not name never passes its body`, async () => {
      const error = await call('provider_probe_sdk', ctx);
      // A10 lows fix round 1, L1: a 400 whose body points at no argument
      // says the neutral sentence, still no body.
      expect(error).toBe('The model provider refused the request. (HTTP 400)');
      expect(error).not.toContain('acme-private');
    });

    it(`${name}: our own errors keep their text, as on main`, async () => {
      expect(await call('provider_probe_input', ctx)).toBe('entry_date must be a valid date');
      expect(await call('provider_probe_plain', ctx)).toBe('fetch failed: 404 Not Found');
    });
  }
});

describe("dispatch's masking keeps the detail on the owner's trace (A10 lows fix round 1, L2)", () => {
  it('a masked call that replied a provider failure: the sentence out, error_detail on the step', async () => {
    SLUG = 'provider_probe_reply';
    const meta: Record<string, unknown>[] = [];
    const surface: NonNullable<ToolHandlerContext['surface']> = {
      kind: 'team',
      loginId: 'l1',
      privateReads: false,
    };
    const res = await dispatchTool(
      row(SLUG),
      {},
      {
        ownerId: 'o',
        surface,
        caller: appBrokerCaller(surface, allowed(SLUG)),
        step: { setMeta: (m) => meta.push(m), setOutput: () => {} },
      },
    );
    expect(res).toMatchObject({
      ok: false,
      error: 'The provider has a server problem. (openai, HTTP 500)',
    });
    expect(meta).toEqual([{ error_detail: 'openai call 500: sk-[masked] org=acme-private' }]);
  });
});
