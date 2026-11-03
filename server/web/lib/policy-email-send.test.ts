/**
 * MANTLE_POLICY_EMAIL_SEND=off on the brain's side (docs/policy.md, "Email
 * sending"): the send tools leave every agent's tool list (the grant
 * stays), the mail reads stay, and the Policy panel's report says so. The
 * transports' refusal is pinned in packages/email (send.policy.test.ts) and
 * packages/microsoft (outlook/send.policy.test.ts), the approval's in
 * packages/tools (pending.test.ts), the MCP list's in packages/mcp-core
 * (policy-email-send.test.ts).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { emailSendAllowed, policySet, resetBoxPolicyForTests } from '@mantle/config';
import { effectiveToolSlugs } from '@mantle/runtime';
import { policyReport } from './policy-check';
import { MANIFEST_TOOL_GROUPS } from './system-manifest/manifest';

const KEYS = [
  'MANTLE_POLICY_TELEGRAM',
  'MANTLE_POLICY_EMAIL_SEND',
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
  process.env.MANTLE_POLICY_EMAIL_SEND = 'off';
  resetBoxPolicyForTests();
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  resetBoxPolicyForTests();
});

describe('MANTLE_POLICY_EMAIL_SEND=off', () => {
  it('is a policy: the panel appears', () => {
    expect(policySet()).toBe(true);
    expect(emailSendAllowed()).toBe(false);
  });

  it("the email group's send tools leave the agent's list, the reads stay", () => {
    const email = MANIFEST_TOOL_GROUPS.find((g) => g.slug === 'email')!;
    expect(effectiveToolSlugs([...email.toolSlugs, 'contact_find'])).toEqual([
      'email_list',
      'email_get',
      'contact_find',
    ]);
  });

  it('the report says sending is off, and nothing else is', async () => {
    const report = await policyReport();
    expect(report).toEqual({
      telegram: { off: false },
      emailSend: { off: true },
      models: { deny: [], providerAllow: null },
      passwords: { set: false, min: 8, commonList: true },
      blocked: [],
      endpointAllow: null,
      heldLogins: { change: 0, recheck: 0 },
    });
  });
});
