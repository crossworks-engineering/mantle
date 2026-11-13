/**
 * POST /api/fleet/sso: the Control Center's Company sign-in page
 * (docs/control-center.md, "The admin channel"; docs/oidc-sign-in.md). A
 * person only: no MCP tool, no agent, no API key (an agent that sets a
 * secret or an issuer decides who signs in). Body, one of:
 *  - `{ do: 'list' }`: every linked box with its last sign-in view;
 *  - `{ do: 'status' | 'test', boxIds }`: ask 1 to 50 boxes;
 *  - `{ do: 'set', boxId, tenant?, clientId?, secret?, password }`: stage
 *    one box's values; the person types their own password (the setup
 *    screen's fresh check, ssoSetupPasswordRefusal);
 *  - `{ do: 'mode', boxId, mode, password }`: raise one box's sign-in mode
 *    one step (setup, optional, required; never down, the box holds the
 *    rule); the person types their own password, as for a save;
 *  - `{ do: 'answers', callIds }`: the answers of earlier asks still on
 *    their way.
 * Each ask is queued as a call of the control service (sso_set's args
 * sealed with the CC's master key until the service takes them), sent in
 * the box's own fixed case, and answered within 25 seconds or handed back
 * as pending ids. The audit row of a save names the box, the fields and a
 * hash of the tenant and client id, never the secret; a raise's names the
 * box and the mode asked. Not a CC: 404, with no CC code loaded.
 *
 * "This box" (the Control Center itself): `boxIds: ['self']` for status and
 * test, `boxId: 'self'` for set and mode. The route runs the box's own case
 * code in process (control/sso-channel.ts runSsoCase), with no channel and
 * no queue: the same rules, the same person and the same password step. The
 * scope line (MANTLE_CONTROL_CENTER_SCOPE) is about calls that come in from
 * a CC, so it does not apply: the person is at this box. The answer has a
 * fleet answer's shape, one answer with `boxId: 'self'`, so the page reads
 * both alike. Its status is read live; the CC keeps no view of it. The audit
 * row of a save or a raise is written after the run, with its result.
 */
import { createHash, randomUUID } from 'node:crypto';
import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { InputError } from '@mantle/std';
import { ownerCaller } from '@/lib/auth';
import { auditFireAndForget, requestMetaFrom } from '@/lib/audit';
import { ccOff } from '@/lib/control/env';
import { ssoSetupPasswordRefusal } from '@/lib/oidc/flow';
import { readBody } from '@/lib/read-body';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  POST: {
    class: 'area',
    area: 'settings',
    item: {
      none: "stages company sign-in on the Control Center's boxes: the Admin step checks it",
    },
    limits: { rateLimit: ['fleetSso'] },
    audit: 'own',
  },
});

const Ids = z.array(z.string().uuid()).min(1).max(50);
/** The Control Center's own box: alone, never mixed with box ids. */
const SELF = 'self';
const Self = z.literal(SELF);
const BoxId = z.union([Self, z.string().uuid()]);
const Body = z.discriminatedUnion('do', [
  z.object({ do: z.literal('list') }).strict(),
  z.object({ do: z.enum(['status', 'test']), boxIds: z.union([z.tuple([Self]), Ids]) }).strict(),
  z
    .object({
      do: z.literal('set'),
      boxId: BoxId,
      tenant: z.string().max(64).optional(),
      clientId: z.string().max(64).optional(),
      secret: z.string().max(1024).optional(),
      password: z.string().min(1).max(1024),
    })
    .strict(),
  z
    .object({
      do: z.literal('mode'),
      boxId: BoxId,
      mode: z.enum(['setup', 'optional', 'required']),
      password: z.string().min(1).max(1024),
    })
    .strict(),
  z
    .object({ do: z.literal('answers'), callIds: z.array(z.string().uuid()).min(1).max(100) })
    .strict(),
]);

export async function POST(req: Request) {
  const user = ownerCaller();
  const off = ccOff();
  if (off) return off;
  const [{ askControlSso, checkSsoSet, listControlSso }, { seal }] = await Promise.all([
    import('@mantle/db/control-center'),
    import('@mantle/crypto'),
  ]);
  const body = await readBody(req, Body);
  if (body.do === 'list') return NextResponse.json({ boxes: await listControlSso() });
  if (body.do === 'set' || body.do === 'mode') {
    const refused = await ssoSetupPasswordRefusal(req, user.actor, body.password);
    if (refused) return refused;
  }
  const ask =
    body.do === 'set'
      ? {
          do: 'set' as const,
          boxId: body.boxId,
          ...(body.tenant?.trim() ? { tenant: body.tenant } : {}),
          ...(body.clientId?.trim() ? { clientId: body.clientId } : {}),
          ...(body.secret?.trim() ? { secret: body.secret } : {}),
        }
      : body.do === 'mode'
        ? { do: 'mode' as const, boxId: body.boxId, mode: body.mode }
        : body;
  const audit = (action: 'fleet.sso_set' | 'fleet.sso_mode', detail: Record<string, unknown>) =>
    auditFireAndForget({
      actorId: user.actor.id,
      actorEmail: user.actor.email,
      action,
      method: 'POST',
      path: '/api/fleet/sso',
      detail,
      ...requestMetaFrom(req),
    });
  // What a save's audit row names: the box, the fields and a hash of the
  // tenant and client id. The hash leaves the secret out (a hash of it would
  // confirm a guess).
  let setDetail: Record<string, unknown> | null = null;
  let staged: { tenant?: string; clientId?: string; secret?: string } | null = null;
  if (ask.do === 'set') {
    const checked = checkSsoSet(ask);
    if (!checked.ok) throw new InputError(checked.error);
    staged = checked.value;
    const { secret, ...names } = checked.value;
    setDetail = {
      boxId: ask.boxId,
      fields: [...Object.keys(names), ...(secret !== undefined ? ['secret'] : [])],
      namesSha256: createHash('sha256').update(JSON.stringify(names)).digest('hex'),
    };
  }
  if (ask.do !== 'answers' && isSelf(ask)) {
    return NextResponse.json(
      await runSelf(ask, staged, user.actor.email, (result) => {
        if (ask.do === 'set') audit('fleet.sso_set', { ...setDetail, result });
        if (ask.do === 'mode') audit('fleet.sso_mode', { boxId: SELF, mode: ask.mode, result });
      }),
    );
  }
  // Before the ask: a save or a raise that goes out always has its row, and
  // a refused one none.
  if (ask.do === 'mode') audit('fleet.sso_mode', { boxId: ask.boxId, mode: ask.mode });
  if (ask.do === 'set') audit('fleet.sso_set', setDetail!);
  const r = await askControlSso(ask, user.actor.email, (plain, aad) =>
    seal(plain, aad).ciphertext.toString('base64'),
  );
  if (!r.ok) throw new InputError(r.error);
  return NextResponse.json(r.value);
}

type SelfAsk =
  | { do: 'status' | 'test'; boxIds: readonly string[] }
  | { do: 'set'; boxId: string }
  | { do: 'mode'; boxId: string; mode: 'setup' | 'optional' | 'required' };

/** Whether the ask is for this box: the body's shape keeps 'self' alone. */
function isSelf(ask: SelfAsk): boolean {
  return 'boxIds' in ask ? ask.boxIds[0] === SELF : ask.boxId === SELF;
}

/**
 * One case for this box, in process: the box's own case code (runSsoCase),
 * so every rule is the one the signed route runs. Answered in a fleet
 * answer's shape. `audited` gets the result of a save or a raise (never a
 * value of the secret), also when the run throws.
 */
async function runSelf(
  ask: SelfAsk,
  staged: { tenant?: string; clientId?: string; secret?: string } | null,
  by: string,
  audited: (result: Record<string, unknown>) => void,
) {
  const { runSsoCase } = await import('@/lib/control/sso-channel');
  const name =
    ask.do === 'status'
      ? 'sso_status'
      : ask.do === 'test'
        ? 'sso_test'
        : ask.do === 'set'
          ? 'sso_set'
          : 'sso_mode';
  let answer: Awaited<ReturnType<typeof runSsoCase>>;
  try {
    answer =
      ask.do === 'set'
        ? await runSsoCase({ op: 'sso_set', staged: staged ?? {} }, 'self')
        : ask.do === 'mode'
          ? await runSsoCase({ op: 'sso_mode', mode: ask.mode }, 'self')
          : await runSsoCase({ op: ask.do === 'status' ? 'sso_status' : 'sso_test' }, 'self');
  } catch (err) {
    audited({ ok: false, reason: 'error' });
    throw err;
  }
  audited({
    ok: answer.ok,
    reason: answer.reason ?? null,
    ...(answer.test ? { test: answer.test } : {}),
    ...(answer.from ? { from: answer.from } : {}),
    ...(answer.secretCleared ? { secretCleared: true } : {}),
  });
  const at = new Date().toISOString();
  return {
    answers: [
      {
        id: randomUUID(),
        boxId: SELF,
        kind: 'sso' as const,
        name,
        by,
        at,
        done: at,
        ok: answer.ok,
        reason: answer.ok ? null : (answer.reason ?? 'refused'),
        output: answer,
      },
    ],
    pending: [] as string[],
    gone: [] as string[],
  };
}
