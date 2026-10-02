/**
 * GET /api/apps/deleted — the owner's recently deleted apps (apps first-class
 * plan, Phase 3), newest first: name, look, when, until when it can come
 * back, and whether its data was kept. See packages/content/src/app-trash.ts.
 */
import { NextResponse } from '@/server/http-compat';
import { getOwnerOr401 } from '@/lib/auth';
import { listDeletedApps } from '@mantle/content/app-trash';

export async function GET() {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  return NextResponse.json({ apps: await listDeletedApps(user.id) });
}
