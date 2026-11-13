/**
 * POST /api/fleet/invite: the Control Center's Fleet users invite
 * (docs/control-center.md, "Add a person from the CC"). A person only: no
 * MCP tool, no agent, no API key (an invite is a way into a box). Body, one
 * of:
 *  - `{ do: 'invite', boxId, email, password }`: the box makes a member
 *    invite for `email` with its own invite code; the person types their
 *    own password (the fresh check of the other Fleet writes with weight,
 *    ssoSetupPasswordRefusal). An email an active fleet ban names is
 *    refused here (`banned`): the bans never leave the CC.
 *  - `{ do: 'answers', callIds }`: the answers of earlier invites still on
 *    their way (only calls this process holds a key for).
 *
 * The code: this process makes a one-time key pair per invite
 * (lib/control/invite-keys.ts) and sends the public key with the ask; the
 * box locks the code to it. The call queue, its answer and the logs only
 * ever hold the code locked. Here it is opened once, put in the box's
 * invite link, and handed to the person in this answer (never stored; the
 * gate's default no-store). The CC's audit row (`fleet.user_invite`,
 * written before the ask is queued) names the box and the email, never the
 * code. Not a CC: 404, with no CC code loaded.
 */
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
      none: "asks the Control Center's boxes for member invites: the Admin step checks it",
    },
    limits: { rateLimit: ['fleetInvite'] },
    audit: 'own',
  },
});

const Body = z.discriminatedUnion('do', [
  z
    .object({
      do: z.literal('invite'),
      boxId: z.string().uuid(),
      // The box's own invite route's check (POST /api/team-admin/invites).
      email: z.string().trim().email().max(320),
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
  const [cc, keys, { seal }] = await Promise.all([
    import('@mantle/db/control-center'),
    import('@/lib/control/invite-keys'),
    import('@mantle/crypto'),
  ]);
  const sealer = (plain: string, aad: string) => seal(plain, aad).ciphertext.toString('base64');
  const body = await readBody(req, Body);

  /** The answers that came, opened; the rest pending or gone (their keys
   *  dropped, so nothing opens them later). */
  const opened = (v: { answers: { id: string }[]; pending: string[]; gone: string[] }) => {
    const invites = v.answers.flatMap((a) => keys.openInviteAnswer(a.id, a) ?? []);
    for (const id of v.gone) keys.dropInviteKey(id);
    return NextResponse.json({ invites, pending: v.pending, gone: v.gone });
  };

  if (body.do === 'answers') {
    // Only this route's own calls: an answer is opened only with its key.
    const mine = body.callIds.filter((id) => keys.holdsInviteKey(id));
    const others = body.callIds.filter((id) => !keys.holdsInviteKey(id));
    if (mine.length === 0) return NextResponse.json({ invites: [], pending: [], gone: others });
    const r = await cc.askControlInvite({ do: 'answers', callIds: mine }, user.actor.email, sealer);
    if (!r.ok) throw new InputError(r.error);
    return opened({ ...r.value, gone: [...r.value.gone, ...others] });
  }

  const refused = await ssoSetupPasswordRefusal(req, user.actor, body.password);
  if (refused) return refused;
  const email = body.email.toLowerCase();
  const box = (await cc.listControlSso()).find((b) => b.id === body.boxId.toLowerCase());
  if (!box) throw new InputError('No linked box has that id.');
  if (await cc.controlBanNamesEmail(email)) {
    return NextResponse.json(
      { error: 'A fleet ban names that email. Lift the ban first.', code: 'banned' },
      { status: 409 },
    );
  }
  const pair = keys.newInviteKey();
  if (!pair) {
    return NextResponse.json(
      { error: 'Too many invites are waiting. Try again in a few minutes.', code: 'busy' },
      { status: 503 },
    );
  }
  // Before the ask: an invite that goes out always has its row.
  auditFireAndForget({
    actorId: user.actor.id,
    actorEmail: user.actor.email,
    action: 'fleet.user_invite',
    method: 'POST',
    path: '/api/fleet/invite',
    detail: { boxId: box.id, email },
    ...requestMetaFrom(req),
  });
  const r = await cc.askControlInvite(
    { do: 'invite', boxId: box.id, email, key: pair.publicKey },
    user.actor.email,
    sealer,
  );
  if (!r.ok) throw new InputError(r.error);
  // One call: its key held under its id, opened now or by a later read.
  const callId = r.value.answers[0]?.id ?? r.value.pending[0] ?? r.value.gone[0];
  if (callId) {
    keys.holdInviteKey(callId, { key: pair.key, boxId: box.id, boxUrl: box.url, email });
  }
  return opened(r.value);
}
