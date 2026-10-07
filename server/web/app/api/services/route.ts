import { NextResponse } from '@/server/http-compat';
import { getOwnerOr401 } from '@/lib/auth';
import { getServicesView } from '@/lib/services';

/** GET /api/services: the optional services (sandboxes, media, the local
 *  embedder, and the doc helpers on a core box): state,
 *  plain-language description, whether this box can switch them, the box's
 *  memory and disk for the small-box warning, and the current switch run. */
export async function GET() {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  return NextResponse.json(await getServicesView(user.id));
}
