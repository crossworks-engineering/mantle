import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { ownerCaller } from '@/lib/auth';
import { adoptManifestItem, type AdoptKind } from '@/lib/system-manifest';
import { readBody } from '@/lib/read-body';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  POST: {
    class: 'area',
    area: 'settings',
    item: { none: 'manages the settings area: the Admin step checks it' },
  },
});

const Body = z.object({
  kind: z.enum(['persona', 'agent', 'skill', 'tool-group', 'worker']),
  slug: z.string().min(1),
});

/** Adopt one manifest item (skill / tool-group / specialist / persona / worker)
 *  into the brain — same semantics as the boot reconcile. */
export async function POST(req: Request) {
  const user = ownerCaller();
  const body = await readBody(req, Body);
  // An unknown slug or a missing key (InputError) answers 400 by the one
  // table; a fault the opaque 500.
  await adoptManifestItem(user.id, body.kind as AdoptKind, body.slug);
  return NextResponse.json({ ok: true });
}
