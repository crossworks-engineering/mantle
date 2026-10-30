import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assertEnvShape } from './index';
import {
  boxPolicy,
  denyPatternMatches,
  isAutoRouterModel,
  modelPolicyRefusal,
  modelPolicySet,
  parsePolicy,
  passwordChangeHolds,
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
      // A stale flag never holds a login.
      expect(passwordChangeHolds(true)).toBe(false);
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

  it('blocks auto routers while a deny list is set', () => {
    setPolicy({ MANTLE_POLICY_MODEL_DENY: 'minimax/*' });
    for (const m of ['openrouter/auto', 'openrouter/auto-beta', 'x/auto', '@preset/fast', 'auto']) {
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
  it('the rule holds a flagged login only while a rule is set', () => {
    setPolicy({ MANTLE_POLICY_PASSWORD_MIN: '12' });
    expect(passwordPolicyMin()).toBe(12);
    expect(passwordChangeHolds(true)).toBe(true);
    expect(passwordChangeHolds(false)).toBe(false);
    expect(passwordChangeHolds(undefined)).toBe(false);
  });
});
