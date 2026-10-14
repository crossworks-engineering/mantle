import { NextResponse } from '@/server/http-compat';
import { ownerCaller } from '@/lib/auth';
import { createHeartbeat, listHeartbeats } from '@/lib/heartbeats';
import { toolMakerFor } from '@/lib/tools';
import { CreateHeartbeatBody, toCreateInput } from '@/lib/heartbeat-schema';
import { errorMessage } from '@mantle/std';
import { firstIssue } from '@/lib/zod-issue';
import { isUniqueViolation } from '@mantle/db';

/** List the owner's heartbeats (summaries). A heartbeat's state shows only
 *  to its maker (W7 integration fix 2). */
export async function GET() {
  const user = ownerCaller();
  const heartbeats = await listHeartbeats(user.id, toolMakerFor(user));
  return NextResponse.json({ heartbeats });
}

/** Create a heartbeat. The lib computes the first next_fire_at and (when `state`
 *  is omitted) seeds from the bound skill's defaultState. */
export async function POST(req: Request) {
  const user = ownerCaller();
  const parsed = CreateHeartbeatBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: firstIssue(parsed.error, 'Invalid input.') },
      { status: 400 },
    );
  }
  try {
    const heartbeat = await createHeartbeat(user.id, toCreateInput(parsed.data), user.actor.id);
    return NextResponse.json({ heartbeat });
  } catch (err) {
    const msg = errorMessage(err);
    if (isUniqueViolation(err)) {
      return NextResponse.json(
        { error: `A heartbeat with slug "${parsed.data.slug}" already exists.` },
        { status: 409 },
      );
    }
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}
