/**
 * The terminal onboarding wizard (headless onboarding Phase 3): secrets never
 * ride argv, stdin secrets parse strictly, a run resumes at the saved step,
 * and a defaults-only run with a key reaches "onboarded" through the same
 * step functions the HTTP wizard calls. The steps are stood in; their own
 * behaviour is the route's, tested there.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  users: 0,
  calls: [] as string[],
  state: {
    onboarded: false,
    step: 'profile',
    timezone: 'UTC',
    locale: 'en-GB',
    savedServices: [] as string[],
    assistantAgentId: null as string | null,
  },
  keyOk: true,
  testKeyOk: true,
}));

vi.mock('@mantle/db', () => ({
  countUsers: async () => h.users,
  db: { execute: async () => [{ id: 'owner-1', email: 'owner@example.invalid' }] },
  sql: () => ({}),
}));
vi.mock('../lib/auth/first-owner', () => ({
  createFirstOwner: async (email: string) => {
    h.calls.push(`createFirstOwner:${email}`);
    return { ok: true, id: 'owner-1', email };
  },
}));
vi.mock('../lib/onboarding-steps', () => {
  const step =
    (name: string, result: unknown = { ok: true }) =>
    async (...args: unknown[]) => {
      h.calls.push(`${name}${args[1] !== undefined ? `:${JSON.stringify(args[1])}` : ''}`);
      return typeof result === 'function' ? (result as () => unknown)() : result;
    };
  return {
    runInfraChecks: async () => [{ label: 'Database', ok: true, detail: 'answering' }],
    runSanityChecks: async () => [{ label: 'Your assistant', ok: true, detail: 'ready' }],
    onboardingState: async () => h.state,
    saveStep: async (_u: string, s: string) => {
      h.calls.push(`step:${s}`);
      return { ok: true };
    },
    saveProfile: step('profile'),
    saveKey: step('saveKey', () => ({
      saved: true,
      test: { ok: h.keyOk, message: h.keyOk ? 'key works' : 'key refused' },
    })),
    testKey: step('testKey', () => ({
      ok: h.testKeyOk,
      message: h.testKeyOk ? 'key works' : 'key refused',
    })),
    saveModels: step('models', { ok: true, assistantModel: 'a', workerModel: 'w' }),
    saveEmbedding: step('embedding', {
      configured: true,
      test: { message: 'Memory search enabled.' },
    }),
    provision: step('provision', { assistantAgentId: 'agent-1' }),
    savePurpose: step('purpose'),
    savePersona: step('persona'),
    finishOnboarding: step('finish'),
  };
});

import { parseArgs, parseSecrets, resumeIndex, run, type Options } from './onboard';

/** Every question takes its default; secrets come from the given map. */
function io(secrets: { password?: string; key?: string } = {}) {
  return {
    ask: async (_l: string, def: string) => def,
    secret: async (l: string) =>
      /password/i.test(l) ? (secrets.password ?? '') : (secrets.key ?? ''),
    confirm: async (_l: string, def: boolean) => def,
  };
}

beforeEach(() => {
  h.users = 0;
  h.calls = [];
  h.keyOk = true;
  h.testKeyOk = true;
  h.state = { ...h.state, onboarded: false, step: 'profile', savedServices: [] };
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

describe('parseArgs', () => {
  it('refuses every secret-carrying flag, with or without =', () => {
    for (const a of [
      ['--password', 'x'],
      ['--password=x'],
      ['--openrouter-key', 'k'],
      ['--key=k'],
      ['--setup-code', 'c'],
    ]) {
      expect(() => parseArgs(a)).toThrow(/never go on the command line/);
    }
  });

  it('takes the non-secret values, both spellings', () => {
    const o = parseArgs([
      '--email',
      'a@b.example',
      '--persona=concise',
      '--embedding-model',
      'small',
      '-y',
    ]);
    expect(o).toMatchObject({
      email: 'a@b.example',
      persona: 'concise',
      embeddingModel: 'small',
      yes: true,
    });
  });

  it('--secrets-stdin implies --yes (stdin cannot answer prompts too)', () => {
    expect(parseArgs(['--secrets-stdin'])).toMatchObject({ secretsStdin: true, yes: true });
  });

  it('refuses unknown flags and bad enum values', () => {
    expect(() => parseArgs(['--bogus'])).toThrow(/Unknown argument/);
    expect(() => parseArgs(['--persona', 'grumpy'])).toThrow(/--persona/);
    expect(() => parseArgs(['--gender', 'x'])).toThrow(/--gender/);
    expect(() => parseArgs(['--email'])).toThrow(/needs a value/);
  });
});

describe('parseSecrets', () => {
  it('reads password= and openrouter_key= verbatim, CRLF tolerated', () => {
    expect(parseSecrets('password=p=ss word\r\nopenrouter_key=sk-or-1\n\n')).toEqual({
      password: 'p=ss word',
      openrouterKey: 'sk-or-1',
    });
  });
  it('refuses an unknown key rather than dropping a secret', () => {
    expect(() => parseSecrets('passwrd=x')).toThrow(/Unknown secret "passwrd"/);
  });
});

describe('resumeIndex', () => {
  it('resumes at a known step, from the start otherwise', () => {
    expect(resumeIndex('embedding')).toBe(4);
    expect(resumeIndex(undefined)).toBe(0);
    expect(resumeIndex('nonsense')).toBe(0);
  });
});

describe('run', () => {
  const yes = (extra: Partial<Options> = {}): Options => ({ ...parseArgs(['--yes']), ...extra });

  it('fresh brain, defaults plus a key: owner, every step in wizard order, onboarded', async () => {
    const code = await run(
      yes({ email: 'owner@example.invalid' }),
      io({ password: 'long-enough', key: 'sk-or-x' }),
    );
    expect(code).toBe(0);
    const names = h.calls.map((c) => c.split(':')[0]);
    expect(names).toEqual([
      'createFirstOwner',
      'profile',
      'step',
      'saveKey',
      'step',
      'models',
      'step',
      'embedding',
      'step',
      'provision',
      'step',
      'step',
      'purpose',
      'step',
      'persona',
      'step',
      'step',
      'finish',
    ]);
    expect(h.calls.filter((c) => c.startsWith('step:'))).toEqual([
      'step:openrouter',
      'step:models',
      'step:embedding',
      'step:provision',
      'step:sanity',
      'step:purpose',
      'step:personality',
      'step:telegram',
      'step:done',
    ]);
    // The OpenRouter route and the default embedding model.
    expect(h.calls).toContain(
      'embedding:{"provider":"openrouter","model":"text-embedding-3-large"}',
    );
  });

  it('never creates an owner without an email or a long enough password', async () => {
    await expect(run(yes(), io({ password: 'long-enough' }))).rejects.toThrow(/--email/);
    await expect(
      run(yes({ email: 'o@example.invalid' }), io({ password: 'short' })),
    ).rejects.toThrow(/8\+/);
    expect(h.calls).toEqual([]);
  });

  it('resumes at the saved step, and keeps a saved key when none is typed', async () => {
    h.users = 1;
    h.state = { ...h.state, step: 'openrouter', savedServices: ['openrouter'] };
    expect(await run(yes(), io())).toBe(0);
    expect(h.calls[0]).toBe('testKey:"openrouter"');
    expect(h.calls.some((c) => c.startsWith('profile') || c.startsWith('createFirstOwner'))).toBe(
      false,
    );
  });

  it('an onboarded brain is left alone', async () => {
    h.users = 1;
    h.state = { ...h.state, onboarded: true };
    expect(await run(yes(), io())).toBe(0);
    expect(h.calls).toEqual([]);
  });

  it('--yes with no key fails loudly instead of stopping half way with exit 0', async () => {
    h.users = 1;
    h.state = { ...h.state, step: 'openrouter' };
    expect(await run(yes(), io())).toBe(1);
    expect(h.calls.some((c) => c.startsWith('finish'))).toBe(false);
  });

  it('a saved key that no longer works stops a --yes run too', async () => {
    h.users = 1;
    h.state = { ...h.state, step: 'openrouter', savedServices: ['openrouter'] };
    h.testKeyOk = false;
    expect(await run(yes(), io())).toBe(1);
    expect(h.calls.some((c) => c.startsWith('models'))).toBe(false);
  });

  it('a refused key under --yes stops before provisioning', async () => {
    h.users = 1;
    h.keyOk = false;
    h.state = { ...h.state, step: 'openrouter' };
    expect(await run(yes(), io({ key: 'sk-bad' }))).toBe(1);
    expect(h.calls.some((c) => c.startsWith('provision'))).toBe(false);
  });
});
