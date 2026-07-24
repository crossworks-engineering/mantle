import { NextResponse } from '@/server/http-compat';
import { getOwnerOr401 } from '@/lib/auth';
import { createHeartbeat, listHeartbeats } from '@/lib/heartbeats';
import { CreateHeartbeatBody, toCreateInput } from '@/lib/heartbeat-schema';

/** List the owner's heartbeats (summaries). */
export async function GET() {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const heartbeats = await listHeartbeats(user.id);
  return NextResponse.json({ heartbeats });
}

/** Create a heartbeat. The lib computes the first next_fire_at and (when `state`
 *  is omitted) seeds from the bound skill's defaultState. */
export async function POST(req: Request) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const parsed = CreateHeartbeatBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'Invalid input.' },
      { status: 400 },
    );
  }
  try {
    const heartbeat = await createHeartbeat(user.id, toCreateInput(parsed.data));
    return NextResponse.json({ heartbeat });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('heartbeats_owner_slug') || msg.includes('duplicate key')) {
      return NextResponse.json(
        { error: `A heartbeat with slug "${parsed.data.slug}" already exists.` },
        { status: 409 },
      );
    }
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}
