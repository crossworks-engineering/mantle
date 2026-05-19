import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireOwner } from '@/lib/auth';
import { createSkill, listSkills } from '@/lib/skills';

export async function GET() {
  const user = await requireOwner();
  const rows = await listSkills(user.id);
  return NextResponse.json({ skills: rows });
}

const CreateBody = z.object({
  slug: z
    .string()
    .min(1)
    .max(120)
    .regex(/^[a-z0-9_-]+$/, 'slug must be lowercase letters/digits/dash/underscore'),
  name: z.string().min(1).max(120),
  description: z.string().min(1).max(2000),
  instructions: z.string().max(40_000).optional(),
  toolSlugs: z.array(z.string().min(1).max(120)).max(64).optional(),
  /** Template state shape for heartbeats bound to this skill. Must
   *  be a plain object (not array, not primitive). Validated again
   *  on the client; this is the server-side guard. */
  defaultState: z.record(z.unknown()).optional(),
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
    const row = await createSkill(user.id, parsed.data);
    return NextResponse.json({ skill: row });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('skills_owner_slug_uq') || msg.includes('duplicate key')) {
      return NextResponse.json(
        { error: `A skill with slug "${parsed.data.slug}" already exists.` },
        { status: 409 },
      );
    }
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
