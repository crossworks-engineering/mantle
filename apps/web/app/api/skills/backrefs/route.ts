import { NextResponse } from 'next/server';
import { requireOwner } from '@/lib/auth';
import { listSkillBackrefs } from '@/lib/skills';

/** Heartbeats that reference each skill, keyed by skill slug — drives the
 *  "used by N heartbeats" badge + delete warning on the skills screen. */
export async function GET() {
  const user = await requireOwner();
  const backrefs = await listSkillBackrefs(user.id);
  return NextResponse.json({ backrefs: Object.fromEntries(backrefs) });
}
