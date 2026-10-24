import { NextResponse } from '@/server/http-compat';
import { ownerCaller } from '@/lib/auth';
import { isAnchorLogin } from '@/lib/agents';
import { listAgentActivity, listPersonaNotes } from '@/lib/debug';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  GET: { class: 'area', area: 'settings' },
});

/** GET /api/debug/agents: configured agents + the reflector's persona notes
 *  (the anchor login's only: other logins get none, W7 integration fix). */
export async function GET() {
  const user = ownerCaller();
  const [agents, personaNotes] = await Promise.all([
    listAgentActivity(user.id),
    isAnchorLogin(user) ? listPersonaNotes(user.id) : Promise.resolve([]),
  ]);
  return NextResponse.json({ agents, personaNotes });
}
