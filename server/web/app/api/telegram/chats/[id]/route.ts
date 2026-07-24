import { and, eq } from 'drizzle-orm';
import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { db, agents, telegramChats } from '@mantle/db';
import { getOwnerOr401 } from '@/lib/auth';

const IdParams = z.object({ id: z.string().uuid() });

const PatchBody = z
  .object({
    responderAgentId: z.string().uuid().nullable(),
  })
  .partial();

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const idParsed = IdParams.safeParse(await ctx.params);
  if (!idParsed.success) {
    return NextResponse.json({ error: 'Invalid id.' }, { status: 400 });
  }

  const raw = await req.json().catch(() => ({}));
  const parsed = PatchBody.safeParse(raw);
  if (!parsed.success) {
    const message = parsed.error.issues[0]?.message ?? 'Invalid input.';
    return NextResponse.json({ error: message }, { status: 400 });
  }

  // Verify the chat belongs to this owner.
  const [chat] = await db
    .select({ id: telegramChats.id })
    .from(telegramChats)
    .where(and(eq(telegramChats.id, idParsed.data.id), eq(telegramChats.userId, user.id)))
    .limit(1);
  if (!chat) return NextResponse.json({ error: 'Not found.' }, { status: 404 });

  // If setting an override, verify the agent belongs to this owner.
  if (parsed.data.responderAgentId) {
    const [agent] = await db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.id, parsed.data.responderAgentId), eq(agents.ownerId, user.id)))
      .limit(1);
    if (!agent) return NextResponse.json({ error: 'Agent not found.' }, { status: 404 });
  }

  await db
    .update(telegramChats)
    .set({
      ...(parsed.data.responderAgentId !== undefined
        ? { responderAgentId: parsed.data.responderAgentId }
        : {}),
      updatedAt: new Date(),
    })
    .where(eq(telegramChats.id, idParsed.data.id));

  return NextResponse.json({ ok: true });
}
