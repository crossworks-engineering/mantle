/**
 * POST /api/sidecar/mail/run (Sync service plan M2): the Sync sidecar
 * finished a run of a mailbox. One sync_runs row, and the mailbox's last
 * sync stamp or error, for its status in Email.
 */
import { NextResponse } from '@/server/http-compat';
import { mailboxOf, recordMailRun } from '@mantle/email';
import { readBody } from '@/lib/read-body';
import { routePolicy } from '@/lib/auth/route-declaration';
import { RunBody } from '@/lib/sidecar-schemas';
import { asSidecar, sidecarOwner, sidecarRequestRefusal } from '@/lib/sidecar';

export const policy = routePolicy({
  // No rate limit, as the gateway's routes (gateway/registry/route.ts says
  // why): the token is checked first and a refusal does no work.
  POST: { class: 'public', item: { none: "a public route: it judges its own credential (the Sync sidecar's token)" } },
});

export async function POST(req: Request) {
  const refused = sidecarRequestRefusal(req);
  if (refused) return refused;
  const { accountId, ...run } = await readBody(req, RunBody, { refuseEmpty: true });
  return asSidecar(async () => {
    const account = await mailboxOf(await sidecarOwner(), accountId);
    if (!account) return NextResponse.json({ error: 'no such mailbox' }, { status: 404 });
    await recordMailRun(account, run);
    return NextResponse.json({ ok: true });
  });
}
