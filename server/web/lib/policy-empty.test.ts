/**
 * The open source guarantee (plan "Corporate sign-in", section 2.1; docs/policy.md):
 * a box with every MANTLE_POLICY_* value empty behaves exactly as a box
 * from before the policy. This is the phase's acceptance test, beside the
 * pins that hold the rest unchanged:
 *
 *  - the MCP tool list: packages/mcp-core/src/mcp-surface-snapshot.test.ts
 *    (its snapshots are not touched by this feature);
 *  - the seeded agents, workers and default models:
 *    server/web/lib/system-manifest/manifest.test.ts (the manifest is not
 *    touched);
 *  - sign-in and the password rule: lib/auth/password-policy.test.ts ("no
 *    policy") and the login routes' own tests;
 *  - the model calls: packages/voice/src/adapters/model-policy.test.ts ("no
 *    model rule").
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  modelPolicyRefusal,
  policySet,
  resetBoxPolicyForTests,
  telegramAllowed,
  toolPolicyAllows,
} from '@mantle/config';
import { effectiveToolSlugs } from '@mantle/runtime';
import { routeSwitchedOff } from './auth/route-policy';
import { passwordHoldAnswer } from './auth/password-hold';
import { passwordProblem, passwordRule, signInNeedsPasswordChange } from './auth/password-rule';
import { policyReport } from './policy-check';
import type { RequestLogins } from './auth/session';
import { MANIFEST_AGENTS, MANIFEST_WORKERS } from './system-manifest/manifest';

const KEYS = [
  'MANTLE_POLICY_TELEGRAM',
  'MANTLE_POLICY_MODEL_DENY',
  'MANTLE_POLICY_PROVIDER_ALLOW',
  'MANTLE_POLICY_PASSWORD_MIN',
  'MANTLE_POLICY_ENDPOINT_ALLOW',
] as const;
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  resetBoxPolicyForTests();
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  resetBoxPolicyForTests();
});

describe('every MANTLE_POLICY_* empty: the box as before', () => {
  it('no rule, no Policy panel, no boot check', async () => {
    expect(policySet()).toBe(false);
    // GET /api/policy answers 404 on null: the panel does not appear. The
    // boot check runs only when policySet() (server/main.ts).
    expect(await policyReport()).toBeNull();
  });

  it('passwords: 8 characters, no list, no forced change', async () => {
    expect(passwordRule()).toEqual({ min: 8, commonList: false });
    expect(passwordProblem('12345678')).toBeNull();
    expect(passwordProblem('1234567')?.code).toBe('password_too_short');
    expect(signInNeedsPasswordChange('password')).toBe(false);
    // The hold reads nothing on any route, even for a stale flag.
    const login = vi.fn(async () => ({ resolved: { mustChangePassword: true } }));
    const logins = { login, keepFailure: vi.fn() } as unknown as RequestLogins;
    expect(
      await passwordHoldAnswer({ public: false, caller: 'owner', passwordHold: null }, logins),
    ).toBeNull();
    expect(login).not.toHaveBeenCalled();
  });

  it('Telegram: works as today, every route and tool', () => {
    expect(telegramAllowed()).toBe(true);
    expect(routeSwitchedOff({ switch: 'telegram-policy' })).toBeNull();
    const slugs = ['telegram_send', 'telegram_pending', 'search_nodes'];
    expect(effectiveToolSlugs(slugs)).toEqual(slugs);
    expect(slugs.every(toolPolicyAllows)).toBe(true);
  });

  it('models: every shipped default stays callable, auto routers too', () => {
    const defaults = [...MANIFEST_AGENTS, ...MANIFEST_WORKERS]
      .map((d) => d as { provider?: string; model?: string })
      .filter((d) => typeof d.model === 'string' && d.model !== 'inherit');
    expect(defaults.length).toBeGreaterThan(0);
    for (const r of defaults) {
      expect(modelPolicyRefusal(r.provider ?? 'openrouter', r.model)).toBeNull();
    }
    // The loop asks the real check: the same defaults under a deny-all rule
    // are refused (audit round 8).
    process.env.MANTLE_POLICY_MODEL_DENY = '*';
    resetBoxPolicyForTests();
    for (const r of defaults) {
      expect(modelPolicyRefusal(r.provider ?? 'openrouter', r.model)).not.toBeNull();
    }
    delete process.env.MANTLE_POLICY_MODEL_DENY;
    resetBoxPolicyForTests();
    expect(modelPolicyRefusal('openrouter', 'openrouter/auto')).toBeNull();
    // A route's own base URL anywhere: no endpoint rule.
    expect(modelPolicyRefusal('local', 'llama3', 'http://any.example:1234/v1')).toBeNull();
  });

  it('the policy code calls no outside service (no Microsoft service, no URL)', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const root = join(here, '../../..');
    for (const f of [
      'packages/config/src/policy.ts',
      'packages/voice/src/adapters/model-policy.ts',
      'server/web/lib/auth/password-rule.ts',
      'server/web/lib/auth/password-hold.ts',
      'server/web/lib/auth/common-passwords.ts',
      'server/web/lib/policy-check.ts',
      'server/web/lib/model-policy-save.ts',
    ]) {
      const src = readFileSync(join(root, f), 'utf8');
      expect(src, f).not.toMatch(/https?:\/\//);
      expect(src, f).not.toMatch(/\bfetch\(/);
    }
  });
});
