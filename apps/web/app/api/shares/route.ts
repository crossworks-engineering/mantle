import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getOwnerOr401 } from '@/lib/auth';
import { createShare, getActiveShareForNode } from '@/lib/shares';

/** GET /api/shares?nodeId=… → the node's active link (or null). */
export async function GET(req: Request) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const nodeId = new URL(req.url).searchParams.get('nodeId');
  if (!nodeId) return NextResponse.json({ error: 'nodeId required' }, { status: 400 });
  const share = await getActiveShareForNode(user.id, nodeId);
  return NextResponse.json({
    share: share ? { id: share.id, token: share.token, path: `/s/${share.token}` } : null,
  });
}

const CreateBody = z.object({ nodeId: z.string().uuid() });

/** POST /api/shares { nodeId } → create (or return existing) active link. */
export async function POST(req: Request) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const parsed = CreateBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: 'valid nodeId required' }, { status: 400 });
  try {
    const share = await createShare(user.id, parsed.data.nodeId);
    return NextResponse.json({
      share: { id: share.id, token: share.token, path: `/s/${share.token}` },
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'failed to create share' },
      { status: 400 },
    );
  }
}
