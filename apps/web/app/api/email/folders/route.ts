import { NextResponse } from 'next/server';
import { z } from 'zod';
import { folderFacets } from '@mantle/email';
import { getOwnerOr401 } from '@/lib/auth';

const Query = z.object({ account: z.string().uuid() });

/** Per-folder counts (ingested mail) for one owned account — drives the nav. */
export async function GET(req: Request) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const parsed = Query.safeParse({
    account: new URL(req.url).searchParams.get('account') ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json({ error: 'account is required' }, { status: 400 });
  }
  const folders = await folderFacets(user.id, parsed.data.account);
  return NextResponse.json({ folders });
}
