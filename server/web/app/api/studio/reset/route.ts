import { NextResponse } from '@/server/http-compat';

import { ownerCaller } from '@/lib/auth';
import { applyManifest, MANIFEST_AGENTS } from '@/lib/system-manifest';
import { readJson } from '@/lib/read-body';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  POST: {
    class: 'area',
    area: 'assistants',
    item: { none: 'manages the assistants area: the Admin step checks it' },
  },
});

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
  // A manifest refusal (InputError: no key for it) answers 400 by the one
  // table; a fault the opaque 500.
  await applyManifest(user.id, { only: [slug], mode: 'overwrite' });
  return NextResponse.json({ ok: true });
}
