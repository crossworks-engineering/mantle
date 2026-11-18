/**
 * DELETE /api/sidecar/mail/accounts/:id?provider=imap|microsoft (Sync
 * service plan M2; lib/sidecar.ts): the Sync sidecar removed a mailbox, or
 * switched an Outlook inbox off. Its row is switched off; its stored mail
 * stays, readable and searchable. Only a row still of that provider (M3): a
 * row the other kind took over since answers 404, as one that is gone.
 */
import { NextResponse } from '@/server/http-compat';
import { isUuid } from '@mantle/std';
import { disableMailbox } from '@mantle/email';
import { routePolicy } from '@/lib/auth/route-declaration';
import { asSidecar, sidecarOwner, sidecarRequestRefusal } from '@/lib/sidecar';

export const policy = routePolicy({
  // No rate limit, as the gateway's routes (gateway/registry/route.ts says
  // why): the token is checked first and a refusal does no work.
  DELETE: {
    class: 'public',
    item: { none: "a public route: it judges its own credential (the Sync sidecar's token)" },
  },
});

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const refused = sidecarRequestRefusal(req);
  if (refused) return refused;
  const { id } = await ctx.params;
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 });
  const provider = new URL(req.url).searchParams.get('provider');
  if (provider !== 'imap' && provider !== 'microsoft') {
    return NextResponse.json({ error: 'name the provider' }, { status: 400 });
  }
  const done = await asSidecar(async () => disableMailbox(await sidecarOwner(), id, provider));
  if (!done) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ ok: true });
}
