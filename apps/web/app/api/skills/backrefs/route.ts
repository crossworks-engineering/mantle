import { NextResponse } from 'next/server';
import { getOwnerOr401 } from '@/lib/auth';
import { listSkillBackrefs } from '@/lib/skills';

/** Heartbeats that reference each skill, keyed by skill slug — drives the
 *  "used by N heartbeats" badge + delete warning on the skills screen. */
export async function GET() {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const backrefs = await listSkillBackrefs(user.id);
  return NextResponse.json({ backrefs: Object.fromEntries(backrefs) });
}
