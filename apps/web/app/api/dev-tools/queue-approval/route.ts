/**
 * DEV-ONLY: manufacture a pending approval to exercise the approval
 * notification round-trip end to end — the live sidebar/list badge AND the
 * interactive Telegram card (sendApprovalCard → tap → approve/reject →
 * card edit). It inserts a real `pending_tool_calls` row for a harmless,
 * read-only tool (default `todo_list`) and fires the same notifyPendingCreated
 * hook the agent tool-loop uses, so the path under test is the real one.
 *
 * Gated to non-production: in prod this would let any authenticated request
 * queue an arbitrary tool approval, so it 404s there. The genuine prod check
 * is a real chat turn / heartbeat fire against the live bot.
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db, pendingToolCalls } from '@mantle/db';
import { notifyPendingCreated } from '@mantle/tools';
import { getOwnerOr401 } from '@/lib/auth';

export const dynamic = 'force-dynamic';

const Body = z.object({
  // A real, enabled tool so the approve path can actually dispatch it.
  // Defaults to a harmless read-only builtin.
  slug: z
    .string()
    .min(1)
    .max(120)
    .regex(/^[a-z0-9_-]+$/)
    .default('todo_list'),
  input: z.record(z.string(), z.unknown()).default({}),
});

export async function POST(req: Request) {
  if (process.env.NODE_ENV === 'production') {
    return NextResponse.json({ error: 'not available in production' }, { status: 404 });
  }
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const raw = await req.json().catch(() => ({}));
  const parsed = Body.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'invalid input' },
      { status: 400 },
    );
  }

  const [pending] = await db
    .insert(pendingToolCalls)
    .values({
      ownerId: user.id,
      toolSlug: parsed.data.slug,
      args: parsed.data.input,
    })
    .returning({ id: pendingToolCalls.id });
  if (!pending) {
    return NextResponse.json({ error: 'failed to queue' }, { status: 500 });
  }

  // The real fan-out: pg_notify('pending_changed') for the live badge +
  // a Telegram approval card to the paired chat (if one is paired).
  await notifyPendingCreated({
    ownerId: user.id,
    pendingId: pending.id,
    toolSlug: parsed.data.slug,
    args: parsed.data.input,
    via: 'dev test',
  });

  return NextResponse.json({ ok: true, pendingId: pending.id });
}
