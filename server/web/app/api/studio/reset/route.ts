import { NextResponse } from '@/server/http-compat';

import { ownerCaller } from '@/lib/auth';
import { applyManifest, MANIFEST_AGENTS } from '@/lib/system-manifest';
import { readJson } from '@/lib/read-body';

// POST /api/studio/reset  { slug }
// Resets a manifest agent to its canonical default (overwrite mode) — system
// prompt, model, params, skills, delegation. Only manifest slugs are resettable.
export async function POST(req: Request) {
  const user = ownerCaller();
  const payload = (await readJson(req, { refuseEmpty: true })) as { slug?: string };
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
