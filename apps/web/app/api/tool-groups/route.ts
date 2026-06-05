import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireOwner } from '@/lib/auth';
import { createToolGroup, listToolGroups, listToolGroupBackrefs } from '@/lib/tool-groups';

export async function GET() {
  const user = await requireOwner();
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
  const user = await requireOwner();
  const raw = await req.json().catch(() => ({}));
  const parsed = CreateBody.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'invalid input' },
      { status: 400 },
    );
  }
  try {
    const row = await createToolGroup(user.id, parsed.data);
    return NextResponse.json({ group: row });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('tool_groups_owner_slug_uq') || msg.includes('duplicate key')) {
      return NextResponse.json(
        { error: `A tool group with slug "${parsed.data.slug}" already exists.` },
        { status: 409 },
      );
    }
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
