import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assertEnvShape } from './index';
import {
  boxPolicy,
  denyPatternMatches,
  isAutoRouterModel,
  modelPolicyRefusal,
  modelPolicySet,
  parsePolicy,
  endpointPolicyRefusal,
  passwordHoldState,
  passwordPolicyMin,
  policyProblems,
  policySet,
  resetBoxPolicyForTests,
  telegramAllowed,
  toolPolicyAllows,
} from './policy';

const KEYS = [
  'MANTLE_POLICY_TELEGRAM',
  'MANTLE_POLICY_MODEL_DENY',
  'MANTLE_POLICY_PROVIDER_ALLOW',
  'MANTLE_POLICY_PASSWORD_MIN',
  'MANTLE_POLICY_ENDPOINT_ALLOW',
] as const;
const saved: Record<string, string | undefined> = {};

function setPolicy(values: Partial<Record<(typeof KEYS)[number], string>>): void {
  for (const k of KEYS) delete process.env[k];
  for (const [k, v] of Object.entries(values)) process.env[k] = v;
  resetBoxPolicyForTests();
}

beforeEach(() => {
  for (const k of KEYS) saved[k] = process.env[k];
  setPolicy({});
});

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  resetBoxPolicyForTests();
});

/** The hard rule (plan "Corporate sign-in", section 2.1): a box with every
 *  MANTLE_POLICY_* value empty behaves exactly as a box from before. */
describe('no policy: every rule off', () => {
  for (const values of [
    {},
    Object.fromEntries(KEYS.map((k) => [k, ''])),
    Object.fromEntries(KEYS.map((k) => [k, '  '])),
  ]) {
    it(`values ${JSON.stringify(values)}`, () => {
      setPolicy(values);
      expect(policySet()).toBe(false);
      expect(modelPolicySet()).toBe(false);
      expect(telegramAllowed()).toBe(true);
      expect(passwordPolicyMin()).toBeNull();
      expect(policyProblems()).toEqual([]);
      expect(() => assertEnvShape()).not.toThrow();
      // Every provider and model, auto routers included, stays callable.
      for (const [p, m] of [
        ['openrouter', 'openrouter/auto'],
        ['deepseek', 'deepseek-chat'],
        ['openrouter', 'qwen/qwen3-8b'],
        ['local', 'qwen2.5:7b'],
        ['anything', ''],
      ]) {
        expect(modelPolicyRefusal(p!, m)).toBeNull();
      }
      // Every Telegram tool stays on every list.
      expect(toolPolicyAllows('telegram_send')).toBe(true);
      // A stale flag never holds a login, nor a password never checked.
      expect(passwordHoldState(true, null)).toBeNull();
      expect(passwordHoldState(false, null)).toBeNull();
      // No endpoint rule either.
      expect(endpointPolicyRefusal('local', 'http://anywhere.example:1234')).toBeNull();
    });
  }
  it('`on` for Telegram is no rule', () => {
    setPolicy({ MANTLE_POLICY_TELEGRAM: 'on' });
    expect(policySet()).toBe(false);
    expect(telegramAllowed()).toBe(true);
  });
});

describe('parsePolicy', () => {
  it('reads each rule', () => {
    const { policy, problems } = parsePolicy({
      telegram: 'OFF',
      modelDeny: 'DeepSeek/*, qwen/*,,qwen/*',
      providerAllow: 'foundry, Local',
      passwordMin: '12',
    });
    expect(problems).toEqual([]);
    expect(policy).toEqual({
      telegram: 'off',
      modelDeny: ['deepseek/*', 'qwen/*'],
      providerAllow: ['foundry', 'local'],
      passwordMin: 12,
      endpointAllow: null,
    });
  });

  it('a malformed value is a problem, read at its strictest', () => {
    const { policy, problems } = parsePolicy({ telegram: 'of', passwordMin: '6' });
    expect(problems).toHaveLength(2);
    expect(policy.telegram).toBe('off');
    expect(policy.passwordMin).toBe(8);
    expect(parsePolicy({ passwordMin: 'twelve' }).policy.passwordMin).toBe(128);
    expect(parsePolicy({ passwordMin: '500' }).problems).toHaveLength(1);
    expect(parsePolicy({ providerAllow: 'open router' }).problems).toHaveLength(1);
  });

  it('a value set to nothing, or read only with another, is a problem', () => {
    expect(parsePolicy({ modelDeny: ' , ' }).problems).toHaveLength(1);
    expect(parsePolicy({ endpointAllow: 'x.example' }).problems).toHaveLength(1);
    expect(parsePolicy({ endpointAllow: 'x.example', providerAllow: 'local' }).problems).toEqual(
      [],
    );
  });

  it('assertEnvShape names a malformed policy value', () => {
    setPolicy({ MANTLE_POLICY_PASSWORD_MIN: '4' });
    expect(() => assertEnvShape()).toThrow(/MANTLE_POLICY_PASSWORD_MIN/);
  });

  it('is read once per process', () => {
    setPolicy({ MANTLE_POLICY_TELEGRAM: 'off' });
    expect(telegramAllowed()).toBe(false);
    process.env.MANTLE_POLICY_TELEGRAM = '';
    expect(telegramAllowed()).toBe(false);
    expect(boxPolicy().telegram).toBe('off');
  });
});

describe('Telegram off', () => {
  it('drops the telegram tools only', () => {
    setPolicy({ MANTLE_POLICY_TELEGRAM: 'off' });
    expect(policySet()).toBe(true);
    expect(telegramAllowed()).toBe(false);
    expect(toolPolicyAllows('telegram_send')).toBe(false);
    expect(toolPolicyAllows('telegram_pair')).toBe(false);
    expect(toolPolicyAllows('search_nodes')).toBe(true);
  });
});

describe('the model block', () => {
  it('denies by family on every provider', () => {
    setPolicy({ MANTLE_POLICY_MODEL_DENY: 'deepseek/*,qwen/*' });
    expect(modelPolicyRefusal('openrouter', 'deepseek/deepseek-chat')?.rule).toBe('model_deny');
    expect(modelPolicyRefusal('deepseek', 'deepseek-chat')?.rule).toBe('model_deny');
    expect(modelPolicyRefusal('deepseek', '')?.rule).toBe('model_deny');
    expect(modelPolicyRefusal('local', 'qwen2.5:7b')?.rule).toBe('model_deny');
    expect(modelPolicyRefusal('local', 'lmstudio-community/qwen/qwen3-8b')?.rule).toBe(
      'model_deny',
    );
    expect(modelPolicyRefusal('openrouter', '~qwen/qwen-latest')?.rule).toBe('model_deny');
    expect(modelPolicyRefusal('openrouter', 'anthropic/claude-sonnet-5')).toBeNull();
    // A family name inside a word is no match.
    expect(modelPolicyRefusal('local', 'qwenish-7b')).toBeNull();
  });

  it('a bare word is a family', () => {
    setPolicy({ MANTLE_POLICY_MODEL_DENY: 'deepseek' });
    expect(modelPolicyRefusal('deepseek', 'deepseek-chat')?.rule).toBe('model_deny');
    expect(modelPolicyRefusal('openrouter', 'deepseek/deepseek-chat')?.rule).toBe('model_deny');
    expect(modelPolicyRefusal('local', 'deepseek-r1:8b')?.rule).toBe('model_deny');
  });

  it('blocks auto routers while a deny list is set', () => {
    setPolicy({ MANTLE_POLICY_MODEL_DENY: 'minimax/*' });
    for (const m of [
      'openrouter/auto',
      'openrouter/auto-beta',
      'x/auto',
      '@preset/fast',
      'auto',
      'switchpoint/router',
    ]) {
      expect(modelPolicyRefusal('openrouter', m)?.rule, m).toBe('auto_router');
    }
    expect(isAutoRouterModel('anthropic/claude-sonnet-5')).toBe(false);
  });

  it('the provider allow-list catches aggregators and new names', () => {
    setPolicy({ MANTLE_POLICY_PROVIDER_ALLOW: 'foundry,local' });
    expect(modelPolicyRefusal('foundry', 'gpt-6-deploy')).toBeNull();
    expect(modelPolicyRefusal('local', 'llama3')).toBeNull();
    expect(modelPolicyRefusal('mammouth', 'gpt-5')?.rule).toBe('provider_allow');
    expect(modelPolicyRefusal('openrouter', 'anthropic/claude-sonnet-5')?.rule).toBe(
      'provider_allow',
    );
    // An allow-list alone does not block auto routers on an allowed provider.
    expect(modelPolicyRefusal('local', 'auto')).toBeNull();
  });

  it('an exact id and a glob', () => {
    expect(denyPatternMatches('openai/gpt-4o', 'openrouter', 'openai/gpt-4o')).toBe(true);
    expect(denyPatternMatches('openai/gpt-4o', 'openrouter', 'openai/gpt-4o-mini')).toBe(false);
    expect(denyPatternMatches('*-preview', 'openrouter', 'google/gemini-preview')).toBe(true);
  });
});

describe('passwords', () => {
  it('holds a flagged login, and one not checked under the rule', () => {
    setPolicy({ MANTLE_POLICY_PASSWORD_MIN: '12' });
    expect(passwordPolicyMin()).toBe(12);
    expect(passwordHoldState(true, 12)).toBe('change');
    expect(passwordHoldState(false, 12)).toBeNull();
    expect(passwordHoldState(false, 14)).toBeNull();
    // Never checked, or checked under a lower minimum: sign in once.
    expect(passwordHoldState(false, null)).toBe('recheck');
    expect(passwordHoldState(false, 8)).toBe('recheck');
    expect(passwordHoldState(undefined, undefined)).toBe('recheck');
  });
});

describe('the endpoint allow-list', () => {
  it('reads only with a provider allow-list', () => {
    setPolicy({ MANTLE_POLICY_ENDPOINT_ALLOW: 'llm.example.internal' });
    expect(policySet()).toBe(false);
    expect(endpointPolicyRefusal('local', 'http://evil.example/v1')).toBeNull();
  });

  it('a route base URL must name an allowed host', () => {
    setPolicy({
      MANTLE_POLICY_PROVIDER_ALLOW: 'local,foundry,openrouter',
      MANTLE_POLICY_ENDPOINT_ALLOW: 'llm.example.internal:1234,*.openai.azure.com',
    });
    expect(endpointPolicyRefusal('local', 'http://llm.example.internal:1234/v1')).toBeNull();
    expect(endpointPolicyRefusal('local', 'http://llm.example.internal:9999/v1')?.rule).toBe(
      'endpoint_allow',
    );
    expect(endpointPolicyRefusal('foundry', 'https://corp.openai.azure.com')).toBeNull();
    expect(endpointPolicyRefusal('foundry', 'https://openai.azure.com.evil.example')?.rule).toBe(
      'endpoint_allow',
    );
    expect(endpointPolicyRefusal('local', 'not a url')?.rule).toBe('endpoint_allow');
    // No base URL: the box-level endpoint, the operator's.
    expect(endpointPolicyRefusal('local', null)).toBeNull();
    expect(endpointPolicyRefusal('local', '  ')).toBeNull();
    // OpenRouter never honours a base URL.
    expect(endpointPolicyRefusal('openrouter', 'http://elsewhere.example')).toBeNull();
    // The one model check carries it.
    expect(modelPolicyRefusal('local', 'llama3', 'http://api.vendor.example/v1')?.rule).toBe(
      'endpoint_allow',
    );
  });

  it('with no endpoint list, no route may name a base URL', () => {
    setPolicy({ MANTLE_POLICY_PROVIDER_ALLOW: 'local' });
    expect(endpointPolicyRefusal('local', 'http://127.0.0.1:11434/v1')?.rule).toBe(
      'endpoint_allow',
    );
  });

  it('a host it cannot read is a boot problem', () => {
    expect(
      parsePolicy({ endpointAllow: 'http://x.example', providerAllow: 'local' }).problems,
    ).toHaveLength(1);
    expect(
      parsePolicy({ endpointAllow: 'x.example:443,*.y.example', providerAllow: 'local' }).problems,
    ).toEqual([]);
  });
});
