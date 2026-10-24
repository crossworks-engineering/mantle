import { NextResponse } from '@/server/http-compat';
import { ownerCaller } from '@/lib/auth';
import { listSkillBackrefs } from '@/lib/skills';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  GET: { class: 'area', area: 'assistants' },
});

/** Heartbeats that reference each skill, keyed by skill slug — drives the
 *  "used by N heartbeats" badge + delete warning on the skills screen. */
export async function GET() {
  const user = ownerCaller();
  const backrefs = await listSkillBackrefs(user.id);
  return NextResponse.json({ backrefs: Object.fromEntries(backrefs) });
}
