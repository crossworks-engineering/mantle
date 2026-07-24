import { NextResponse } from '@/server/http-compat';
import { getOwnerOr401 } from '@/lib/auth';
import { getReaderDoc } from '@/lib/docs-reader';

/**
 * GET /api/docs/reader/doc?collection=<key>&path=<relPath> — one doc's
 * markdown + prev/next, read off the server's disk. getReaderDoc's null (also
 * covering traversal/hidden paths) → 404.
 */
export async function GET(req: Request) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const sp = new URL(req.url).searchParams;
  const collection = sp.get('collection') ?? '';
  const relPath = sp.get('path') ?? '';
  if (!collection || !relPath) {
    return NextResponse.json({ error: 'collection and path required' }, { status: 400 });
  }
  const doc = await getReaderDoc(user.id, collection, relPath);
  if (!doc) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ doc });
}
