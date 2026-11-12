/**
 * The subject box's company sign-in cases (docs/control-center.md, "The
 * admin channel"; plan "SSO setup from the Control Center", option B): three
 * more fixed cases on the signed route (box.ts), so the route's own checks
 * hold them first and no agent, MCP client or API key on the box reaches
 * them. They are not tools: the "never a person-only tool on the channel"
 * rule stays true.
 *
 *  - `sso_status`: where each value comes from (the box .env, or the setup
 *    row), never a value of the secret, and two numbers (linked and active
 *    logins).
 *  - `sso_set { nonce, by, tenant?, clientId?, secret? }`: stages the Entra
 *    tenant and the client id while the mode word is setup, and the client
 *    secret in any mode but off (in an on mode only when the Test with it
 *    answers ok). The nonce is the call's id, taken once (tool-channel.ts
 *    takeNonce). `by` is the CC person, for the audit row.
 *  - `sso_test`: one Test with the saved values (lib/oidc/sso-setup.ts).
 *
 * The box's scope line rules all three: MANTLE_CONTROL_CENTER_SCOPE=none
 * refuses them (`scope`), with no read. Going live stays a .env step by a
 * person (MANTLE_OIDC_MODE): no case here changes the mode.
 */
import { z } from 'zod';
import { oidcModeWord } from '@mantle/config';
import { UUID_RE } from '@mantle/std';
import type { SsoSetupTestOutcome } from '@mantle/client-types';
import type { ControlSsoStatus } from '@mantle/db';
import { notifySsoSetupChange } from '@/lib/oidc/notify';
import {
  ssoCenterStatus,
  ssoSetFromCenter,
  ssoSetupTest,
  type SsoSetAnswer,
} from '@/lib/oidc/sso-setup';
import { controlScope, takeNonce } from './tool-channel';

/** The longest client secret (the setup screen's own cap). */
export const SSO_SECRET_MAX = 1024;

/** The three cases, as box.ts's switch takes them. */
export const SSO_CALLS = [
  z.object({ op: z.literal('sso_status'), args: z.object({}).strict().optional() }).strict(),
  z
    .object({
      op: z.literal('sso_set'),
      args: z
        .object({
          nonce: z.string().uuid(),
          by: z.string().max(200),
          tenant: z.string().regex(UUID_RE).optional(),
          clientId: z.string().regex(UUID_RE).optional(),
          secret: z.string().trim().min(1).max(SSO_SECRET_MAX).optional(),
        })
        .strict()
        .refine(
          (a) => a.tenant !== undefined || a.clientId !== undefined || a.secret !== undefined,
        ),
    })
    .strict(),
  z.object({ op: z.literal('sso_test'), args: z.object({}).strict().optional() }).strict(),
] as const;

export type SsoCall =
  z.infer<(typeof SSO_CALLS)[0]> | z.infer<(typeof SSO_CALLS)[1]> | z.infer<(typeof SSO_CALLS)[2]>;

/** What a sign-in case answers: ok or one reason, the Test's code when one
 *  ran, and the status after it (none on a refusal by scope or nonce).
 *  Never a value of the secret. */
export type SsoAnswer = {
  ok: boolean;
  reason?: 'scope' | 'replay' | 'busy' | 'mode' | 'env-wins' | 'test';
  test?: SsoSetupTestOutcome;
  secretCleared?: true;
  status?: ControlSsoStatus;
};

/** One sign-in case. */
export async function runSsoCall(call: SsoCall): Promise<SsoAnswer> {
  if (!controlScope()) return { ok: false, reason: 'scope' };
  if (call.op === 'sso_status') return { ok: true, status: await ssoCenterStatus() };
  if (call.op === 'sso_test') {
    if (oidcModeWord() === 'off') {
      return { ok: false, reason: 'mode', status: await ssoCenterStatus() };
    }
    return { ok: true, test: await ssoSetupTest(), status: await ssoCenterStatus() };
  }
  const nonce = takeNonce(call.args.nonce);
  if (nonce !== 'ok') return { ok: false, reason: nonce };
  const { tenant, clientId, secret } = call.args;
  const r: SsoSetAnswer = await ssoSetFromCenter({
    ...(tenant !== undefined ? { tenant } : {}),
    ...(clientId !== undefined ? { clientId } : {}),
    ...(secret !== undefined ? { secret } : {}),
  });
  // Not awaited: a slow push must not hold the answer.
  if (r.ok) void notifySsoSetupChange('center');
  return { ...r, status: await ssoCenterStatus() };
}

/** What a sign-in case's audit row names beyond the answer: who at the CC,
 *  and which fields a save carried. Never a value of the secret. */
export function ssoAuditMore(call: SsoCall): Record<string, unknown> {
  if (call.op !== 'sso_set') return {};
  return {
    by: call.args.by,
    fields: (['tenant', 'clientId', 'secret'] as const).filter((f) => call.args[f] !== undefined),
  };
}
