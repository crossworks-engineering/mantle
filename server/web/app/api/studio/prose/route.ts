import { NextResponse } from '@/server/http-compat';

import { getOwnerOr401 } from '@/lib/auth';
import { listProseVersions, saveProse, revertProse } from '@/lib/studio/prompt-versions';

// GET /api/studio/prose?entityType=&entityId=&field= → { versions }
export async function GET(req: Request) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const { searchParams } = new URL(req.url);
  const entityType = searchParams.get('entityType') ?? '';
  const entityId = searchParams.get('entityId') ?? '';
  const field = searchParams.get('field') ?? '';
  try {
    const versions = await listProseVersions(user.id, entityType, entityId, field);
    return NextResponse.json({ versions });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}

// POST /api/studio/prose
//   save:   { entityType, entityId, field, body, note? }
//   revert: { entityType, entityId, field, revertTo }
export async function POST(req: Request) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  let payload: {
    entityType?: string;
    entityId?: string;
    field?: string;
    body?: string;
    note?: string | null;
    revertTo?: number;
  };
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 });
  }
  const { entityType = '', entityId = '', field = '' } = payload;
  if (!entityType || !entityId || !field) {
    return NextResponse.json({ error: 'entityType, entityId, field required' }, { status: 400 });
  }
  try {
    const versions =
      typeof payload.revertTo === 'number'
        ? await revertProse({
            ownerId: user.id,
            entityType,
            entityId,
            field,
            toVersion: payload.revertTo,
            author: user.id,
          })
        : await saveProse({
            ownerId: user.id,
            entityType,
            entityId,
            field,
            body: String(payload.body ?? ''),
            note: payload.note ?? null,
            author: user.id,
          });
    return NextResponse.json({ versions });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}
