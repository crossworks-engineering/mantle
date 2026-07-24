/**
 * Owner-only: close the loop on a team change-request. POST posts the owner's
 * reply into the requesting member's Team Chat thread and stamps the request
 * task (notifiedAt, optionally done). Session-gated (under /api/team-admin,
 * not in PUBLIC_PATHS).
 */
import { NextResponse } from 'next/server';
import { getOwnerOr401 } from '@/lib/auth';
import { notifyTeamRequester } from '@mantle/content';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid body' }, { status: 400 });
  }
  const { taskId, text, markDone } = (body ?? {}) as {
    taskId?: unknown;
    text?: unknown;
    markDone?: unknown;
  };
  if (typeof taskId !== 'string' || !taskId) {
    return NextResponse.json({ error: 'taskId is required' }, { status: 400 });
  }
  if (typeof text !== 'string' || !text.trim()) {
    return NextResponse.json({ error: 'a reply message is required' }, { status: 400 });
  }

  const result = await notifyTeamRequester(user.id, taskId, {
    text,
    markDone: markDone === true,
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
  return NextResponse.json({ ok: true });
}
