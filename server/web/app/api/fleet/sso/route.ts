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
 *  - `{ do: 'answers', callIds }`: the answers of earlier asks still on
 *    their way.
 * Each ask is queued as a call of the control service (sso_set's args
 * sealed with the CC's master key until the service takes them), sent in
 * the box's own fixed case, and answered within 25 seconds or handed back
 * as pending ids. The audit row names the box, the fields and a hash of the
 * tenant and client id, never the secret. Not a CC: 404, with no CC code
 * loaded.
 */
import { createHash } from 'node:crypto';
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
const Body = z.discriminatedUnion('do', [
  z.object({ do: z.literal('list') }).strict(),
  z.object({ do: z.enum(['status', 'test']), boxIds: Ids }).strict(),
  z
    .object({
      do: z.literal('set'),
      boxId: z.string().uuid(),
      tenant: z.string().max(64).optional(),
      clientId: z.string().max(64).optional(),
      secret: z.string().max(1024).optional(),
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
  if (body.do === 'set') {
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
      : body;
  if (ask.do === 'set') {
    // Before the ask: a save that goes out always has its row, and a refused
    // one none. The hash leaves the secret out (a hash of it would confirm a
    // guess).
    const checked = checkSsoSet(ask);
    if (!checked.ok) throw new InputError(checked.error);
    const { secret, ...names } = checked.value;
    const boxId = ask.boxId;
    auditFireAndForget({
      actorId: user.actor.id,
      actorEmail: user.actor.email,
      action: 'fleet.sso_set',
      method: 'POST',
      path: '/api/fleet/sso',
      detail: {
        boxId,
        fields: [...Object.keys(names), ...(secret !== undefined ? ['secret'] : [])],
        namesSha256: createHash('sha256').update(JSON.stringify(names)).digest('hex'),
      },
      ...requestMetaFrom(req),
    });
  }
  const r = await askControlSso(ask, user.actor.email, (plain, aad) =>
    seal(plain, aad).ciphertext.toString('base64'),
  );
  if (!r.ok) throw new InputError(r.error);
  return NextResponse.json(r.value);
}
