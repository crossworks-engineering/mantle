import { NextResponse } from '@/server/http-compat';
import { getOwnerOr401 } from '@/lib/auth';
import { isAnchorLogin } from '@/lib/agents';
import { listAgentActivity, listPersonaNotes } from '@/lib/debug';

/** GET /api/debug/agents: configured agents + the reflector's persona notes
 *  (the anchor login's only: other logins get none, W7 integration fix). */
export async function GET() {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const [agents, personaNotes] = await Promise.all([
    listAgentActivity(user.id),
    isAnchorLogin(user) ? listPersonaNotes(user.id) : Promise.resolve([]),
  ]);
  return NextResponse.json({ agents, personaNotes });
}
