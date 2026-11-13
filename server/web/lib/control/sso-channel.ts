/**
 * The subject box's company sign-in cases (docs/control-center.md, "The
 * admin channel"; plan "SSO setup from the Control Center", option B, and its
 * follow-up B+): four more fixed cases on the signed route (box.ts), so the route's own checks
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
 *  - `sso_mode { nonce, by, mode }`: raises the mode one step (off, setup,
 *    optional, required), never down, and only while the box .env has no
 *    MANTLE_OIDC_MODE line (sso-setup.ts ssoModeFromCenter: the two checks).
 *    The .env line is the only way down. The answer names the mode before
 *    (`from`), and the audit row `by`, the mode asked and the one before.
 *
 * The box's scope line rules all four: MANTLE_CONTROL_CENTER_SCOPE=none
 * refuses them (`scope`), with no read. A Control Center's own box runs the
 * same cases from its Fleet sign-in page (runSsoCase, `self`): the scope
 * line is about calls that come in from a CC, so it does not apply there.
 */
import { z } from 'zod';
import { oidcModeWord } from '@mantle/config';
import { UUID_RE } from '@mantle/std';
import type { SsoSetupTestOutcome } from '@mantle/client-types';
import type { ControlSsoStatus } from '@mantle/db';
import { notifySsoSetupChange } from '@/lib/oidc/notify';
import {
  ssoCenterStatus,
  ssoModeFromCenter,
  ssoSetFromCenter,
  ssoSetupTest,
  type SsoModeStep,
  type SsoSetAnswer,
  type SsoStaged,
} from '@/lib/oidc/sso-setup';
import { controlScope, takeNonce } from './tool-channel';

/** The longest client secret (the setup screen's own cap). */
export const SSO_SECRET_MAX = 1024;

/** The four cases, as box.ts's switch takes them. */
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
  z
    .object({
      op: z.literal('sso_mode'),
      args: z
        .object({
          nonce: z.string().uuid(),
          by: z.string().max(200),
          mode: z.enum(['setup', 'optional', 'required']),
        })
        .strict(),
    })
    .strict(),
] as const;

export type SsoCall = z.infer<(typeof SSO_CALLS)[number]>;

/** What a sign-in case answers: ok or one reason, the Test's code when one
 *  ran, and the status after it (none on a refusal by scope or nonce).
 *  Never a value of the secret. */
export type SsoAnswer = {
  ok: boolean;
  reason?: 'scope' | 'replay' | 'busy' | 'mode' | 'env-wins' | 'test';
  test?: SsoSetupTestOutcome;
  /** sso_mode: the mode word before the raise. */
  from?: string;
  secretCleared?: true;
  status?: ControlSsoStatus;
};

/** One sign-in case, as the signed route takes it: the box's scope line
 *  and the nonce first, then the case (runSsoCase). */
export async function runSsoCall(call: SsoCall): Promise<SsoAnswer> {
  if (!controlScope()) return { ok: false, reason: 'scope' };
  if (call.op === 'sso_set' || call.op === 'sso_mode') {
    const nonce = takeNonce(call.args.nonce);
    if (nonce !== 'ok') return { ok: false, reason: nonce };
  }
  if (call.op === 'sso_set') {
    const { tenant, clientId, secret } = call.args;
    return runSsoCase(
      {
        op: 'sso_set',
        staged: {
          ...(tenant !== undefined ? { tenant } : {}),
          ...(clientId !== undefined ? { clientId } : {}),
          ...(secret !== undefined ? { secret } : {}),
        },
      },
      'center',
    );
  }
  if (call.op === 'sso_mode') return runSsoCase({ op: 'sso_mode', mode: call.args.mode }, 'center');
  return runSsoCase({ op: call.op }, 'center');
}

/** One sign-in case with its values, past the channel's own checks. */
export type SsoCase =
  | { op: 'sso_status' }
  | { op: 'sso_test' }
  | { op: 'sso_set'; staged: SsoStaged }
  | { op: 'sso_mode'; mode: SsoModeStep };

/**
 * The one code of the four cases: the signed route runs it for a CC's call
 * (runSsoCall, after the scope line and the nonce), and a Control Center
 * runs it for its own box (POST /api/fleet/sso, `boxId: 'self'`: a person
 * at this box, so no scope line and no nonce). Every rule is in the
 * functions it calls (lib/oidc/sso-setup.ts). `via` picks only the notice
 * to the original account: `self` names the .env mode line, since the
 * scope line does not stop a person at the box.
 */
export async function runSsoCase(c: SsoCase, via: 'center' | 'self'): Promise<SsoAnswer> {
  if (c.op === 'sso_status') return { ok: true, status: await ssoCenterStatus() };
  if (c.op === 'sso_test') {
    if (oidcModeWord() === 'off') {
      return { ok: false, reason: 'mode', status: await ssoCenterStatus() };
    }
    return { ok: true, test: await ssoSetupTest(), status: await ssoCenterStatus() };
  }
  if (c.op === 'sso_mode') {
    const r = await ssoModeFromCenter(c.mode);
    if (r.ok) void notifySsoSetupChange(via === 'self' ? 'self-mode' : 'center-mode');
    return { ...r, status: await ssoCenterStatus() };
  }
  const r: SsoSetAnswer = await ssoSetFromCenter(c.staged);
  // Not awaited: a slow push must not hold the answer.
  if (r.ok) void notifySsoSetupChange(via === 'self' ? 'self' : 'center');
  return { ...r, status: await ssoCenterStatus() };
}

/** What a sign-in case's audit row names beyond the answer: who at the CC,
 *  and which fields a save carried. Never a value of the secret. */
export function ssoAuditMore(call: SsoCall): Record<string, unknown> {
  // The mode before is the answer's `from`, in the row's result.
  if (call.op === 'sso_mode') return { by: call.args.by, mode: call.args.mode };
  if (call.op !== 'sso_set') return {};
  return {
    by: call.args.by,
    fields: (['tenant', 'clientId', 'secret'] as const).filter((f) => call.args[f] !== undefined),
  };
}
