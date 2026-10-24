import { NextResponse } from '@/server/http-compat';
import { ownerCaller } from '@/lib/auth';
import { createHeartbeat, listHeartbeats } from '@/lib/heartbeats';
import { toolMakerFor } from '@/lib/tools';
import { CreateHeartbeatBody, toCreateInput } from '@/lib/heartbeat-schema';
import { firstIssue } from '@/lib/zod-issue';
import { conflictOnUnique } from '@mantle/db';
import { readJson } from '@/lib/read-body';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  GET: { class: 'area', area: 'assistants' },
  POST: {
    class: 'area',
    area: 'assistants',
    item: { none: 'manages the assistants area: the Admin step checks it' },
  },
});

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
  const parsed = CreateHeartbeatBody.safeParse(await readJson(req));
  if (!parsed.success) {
    return NextResponse.json(
      { error: firstIssue(parsed.error, 'Invalid input.') },
      { status: 400 },
    );
  }
  // A slug or name taken answers 409 with this route's own text
  // (conflictOnUnique, a ConflictError); anything else answers by the one
  // table (A10 part 2): a domain error its status, a fault the opaque 500.
  return conflictOnUnique(
    `A heartbeat with slug "${parsed.data.slug}" already exists.`,
    async () => {
      const heartbeat = await createHeartbeat(user.id, toCreateInput(parsed.data), user.actor.id);
      return NextResponse.json({ heartbeat });
    },
  );
}
