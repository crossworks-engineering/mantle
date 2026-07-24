import { NextResponse } from '@/server/http-compat';

import { getOwnerOr401 } from '@/lib/auth';
import { applyManifest, MANIFEST_AGENTS } from '@/lib/system-manifest';


// POST /api/studio/reset  { slug }
// Resets a manifest agent to its canonical default (overwrite mode) — system
// prompt, model, params, skills, delegation. Only manifest slugs are resettable.
export async function POST(req: Request) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  let payload: { slug?: string };
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 });
  }
  const slug = payload.slug ?? '';
  if (!MANIFEST_AGENTS.some((a) => a.slug === slug)) {
    return NextResponse.json(
      { error: `'${slug}' is not a manifest agent — nothing to reset to` },
      { status: 400 },
    );
  }
  try {
    await applyManifest(user.id, { only: [slug], mode: 'overwrite' });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}
