import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { ownerCaller } from '@/lib/auth';
import { createSkill, listSkills } from '@/lib/skills';
import { toolMakerFor } from '@/lib/tools';
import { firstIssue } from '@/lib/zod-issue';
import { isUniqueViolation } from '@mantle/db';
import { readJson } from '@/lib/read-body';

export async function GET() {
  const user = ownerCaller();
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
  /** Template state shape for heartbeats bound to this skill. Must
   *  be a plain object (not array, not primitive). Validated again
   *  on the client; this is the server-side guard. */
  defaultState: z.record(z.string(), z.unknown()).optional(),
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
    const row = await createSkill(user.id, parsed.data, toolMakerFor(user));
    return NextResponse.json({ skill: row });
  } catch (err) {
    // A slug taken is the fixed 409; anything else answers by the one table
    // (A10 part 2): a domain error its status, a fault the opaque 500.
    if (isUniqueViolation(err)) {
      return NextResponse.json(
        { error: `A skill with slug "${parsed.data.slug}" already exists.` },
        { status: 409 },
      );
    }
    throw err;
  }
}
