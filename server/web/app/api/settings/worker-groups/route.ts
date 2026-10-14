import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { ownerCaller } from '@/lib/auth';
import {
  WORKER_GROUP_SLUG_MAX,
  createWorkerGroup,
  listEnabledWorkerAgents,
  listWorkerGroups,
} from '@/lib/worker-groups';
import { firstIssue } from '@/lib/zod-issue';
import { isUniqueViolation } from '@mantle/db';
import { readJson } from '@/lib/read-body';

/** GET /api/settings/worker-groups — the owner's worker groups + the enabled
 *  worker agents available as members (so the picker needs no second call). */
export async function GET() {
  const user = ownerCaller();
  const [groups, workers] = await Promise.all([
    listWorkerGroups(user.id),
    listEnabledWorkerAgents(user.id),
  ]);
  return NextResponse.json({ groups, workers });
}

const CreateBody = z.object({
  slug: z
    .string()
    .min(1)
    .max(WORKER_GROUP_SLUG_MAX)
    .regex(/^[a-z0-9_-]+$/, 'slug must be lowercase letters/digits/dash/underscore'),
  name: z.string().min(1).max(200),
});

/** POST — create a worker-group shell (slug + name). Members are added via
 *  PATCH from the detail form, where the 1..10 rule is enforced (mirrors
 *  worker_group_ensure, which upserts name + members together). */
export async function POST(req: Request) {
  const user = ownerCaller();
  const raw = await readJson(req);
  const parsed = CreateBody.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: firstIssue(parsed.error) }, { status: 400 });
  }
  try {
    const row = await createWorkerGroup(user.id, parsed.data);
    return NextResponse.json({ group: row });
  } catch (err) {
    // A slug taken is the fixed 409; anything else answers by the one table
    // (A10 part 2): a domain error its status, a fault the opaque 500.
    if (isUniqueViolation(err)) {
      return NextResponse.json(
        { error: `A worker group with slug "${parsed.data.slug}" already exists.` },
        { status: 409 },
      );
    }
    throw err;
  }
}
