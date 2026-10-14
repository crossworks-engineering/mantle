import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { ownerCaller } from '@/lib/auth';
import { createToolGroup, listToolGroups, listToolGroupBackrefs } from '@/lib/tool-groups';
import { firstIssue } from '@/lib/zod-issue';
import { isUniqueViolation } from '@mantle/db';
import { readJson } from '@/lib/read-body';

export async function GET() {
  const user = ownerCaller();
  const [groups, backrefs] = await Promise.all([
    listToolGroups(user.id),
    listToolGroupBackrefs(user.id),
  ]);
  // Attach the fan-out (which agents grant each group) so the UI can show
  // "granted to N agents" without a second round-trip.
  const withRefs = groups.map((g) => ({ ...g, grantedTo: backrefs.get(g.slug) ?? [] }));
  return NextResponse.json({ groups: withRefs });
}

const CreateBody = z.object({
  slug: z
    .string()
    .min(1)
    .max(120)
    .regex(/^[a-z0-9_-]+$/, 'slug must be lowercase letters/digits/dash/underscore'),
  name: z.string().min(1).max(120),
  description: z.string().max(2000).optional(),
  toolSlugs: z.array(z.string().min(1).max(120)).max(512).optional(),
  enabled: z.boolean().optional(),
});

export async function POST(req: Request) {
  const user = ownerCaller();
  const raw = await readJson(req);
  const parsed = CreateBody.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: firstIssue(parsed.error) }, { status: 400 });
  }
  try {
    const row = await createToolGroup(user.id, parsed.data);
    return NextResponse.json({ group: row });
  } catch (err) {
    // A slug taken is the fixed 409; anything else answers by the one table
    // (A10 part 2): a domain error its status, a fault the opaque 500.
    if (isUniqueViolation(err)) {
      return NextResponse.json(
        { error: `A tool group with slug "${parsed.data.slug}" already exists.` },
        { status: 409 },
      );
    }
    throw err;
  }
}
