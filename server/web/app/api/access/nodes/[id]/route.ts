/**
 * GET   /api/access/nodes/:id
 * PATCH /api/access/nodes/:id
 *
 * Gone (workspaces W5b2): brain items have no sharing level any more. Who
 * reads an item is its grants, set in its Grant Access panel (/api/grants).
 * Both answer 410 `{ error, code: 'gone' }` to the owner; without a session
 * the gate answers 401 as before.
 */
import { NextResponse } from '@/server/http-compat';
import { getOwnerOr401 } from '@/lib/auth';
import { goneResponse } from '@/lib/gone';

function gone(): NextResponse {
  return goneResponse('Sharing levels are gone. Use Grant Access.');
}

export async function GET() {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  return gone();
}

export async function PATCH() {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  return gone();
}
