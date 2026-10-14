import { NextResponse } from '@/server/http-compat';

import { ownerCaller } from '@/lib/auth';
import { listProseVersions, saveProse, revertProse } from '@/lib/studio/prompt-versions';
import { toolMakerFor } from '@/lib/tools';
import { readJson } from '@/lib/read-body';

// GET /api/studio/prose?entityType=&entityId=&field= → { versions }
export async function GET(req: Request) {
  const user = ownerCaller();
  const { searchParams } = new URL(req.url);
  const entityType = searchParams.get('entityType') ?? '';
  const entityId = searchParams.get('entityId') ?? '';
  const field = searchParams.get('field') ?? '';
  // A field that is not versionable (InputError) answers 400 by the one table
  // (A10 part 2); a fault the opaque 500.
  const versions = await listProseVersions(user.id, entityType, entityId, field);
  return NextResponse.json({ versions });
}

// POST /api/studio/prose
//   save:   { entityType, entityId, field, body, note? }
//   revert: { entityType, entityId, field, revertTo }
export async function POST(req: Request) {
  const user = ownerCaller();
  const payload = (await readJson(req, { refuseEmpty: true })) as {
    entityType?: string;
    entityId?: string;
    field?: string;
    body?: string;
    note?: string | null;
    revertTo?: number;
  };
  const { entityType = '', entityId = '', field = '' } = payload;
  if (!entityType || !entityId || !field) {
    return NextResponse.json({ error: 'entityType, entityId, field required' }, { status: 400 });
  }
  // A field, an entity or a version not there (InputError) answers 400 by the
  // one table (A10 part 2); a fault the opaque 500.
  const versions =
    typeof payload.revertTo === 'number'
      ? await revertProse({
          ownerId: user.id,
          entityType,
          entityId,
          field,
          toVersion: payload.revertTo,
          author: user.id,
          login: toolMakerFor(user),
        })
      : await saveProse({
          ownerId: user.id,
          entityType,
          entityId,
          field,
          body: String(payload.body ?? ''),
          note: payload.note ?? null,
          author: user.id,
          login: toolMakerFor(user),
        });
  return NextResponse.json({ versions });
}
