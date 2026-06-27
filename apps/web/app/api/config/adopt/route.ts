import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getOwnerOr401 } from '@/lib/auth';
import { adoptManifestItem, type AdoptKind } from '@/lib/system-manifest';

const Body = z.object({
  kind: z.enum(['persona', 'agent', 'skill', 'tool-group', 'worker']),
  slug: z.string().min(1),
});

/** Adopt one manifest item (skill / tool-group / specialist / persona / worker)
 *  into the brain — same semantics as the boot reconcile. */
export async function POST(req: Request) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'invalid input' },
      { status: 400 },
    );
  }
  try {
    await adoptManifestItem(user.id, parsed.data.kind as AdoptKind, parsed.data.slug);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Adopt failed.' },
      { status: 500 },
    );
  }
}
