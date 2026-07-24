import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { getOwnerOr401 } from '@/lib/auth';
import {
  WORKER_GROUP_SLUG_MAX,
  createWorkerGroup,
  listEnabledWorkerAgents,
  listWorkerGroups,
} from '@/lib/worker-groups';

/** GET /api/settings/worker-groups — the owner's worker groups + the enabled
 *  worker agents available as members (so the picker needs no second call). */
export async function GET() {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
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
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const raw = await req.json().catch(() => ({}));
  const parsed = CreateBody.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'invalid input' },
      { status: 400 },
    );
  }
  try {
    const row = await createWorkerGroup(user.id, parsed.data);
    return NextResponse.json({ group: row });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('agent_groups_owner_slug_uq') || msg.includes('duplicate key')) {
      return NextResponse.json(
        { error: `A worker group with slug "${parsed.data.slug}" already exists.` },
        { status: 409 },
      );
    }
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
