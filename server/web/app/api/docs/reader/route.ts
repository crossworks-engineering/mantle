import { NextResponse } from '@/server/http-compat';
import { getOwnerOr401 } from '@/lib/auth';
import { getReaderNav } from '@/lib/docs-reader';

/**
 * GET /api/docs/reader — the docs reader's navigation tree (collections +
 * files, read off the server's disk). Client-fetch counterpart of the /docs
 * SSR reader, for the split client. The doc BODY comes from
 * /api/docs/reader/doc?collection=…&path=….
 */
export async function GET() {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  return NextResponse.json({ nav: await getReaderNav(user.id) });
}
