import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { folderFacets } from '@mantle/email';
import { ownerCaller } from '@/lib/auth';

const Query = z.object({ account: z.string().uuid() });

/** Per-folder counts (ingested mail) for one owned account — drives the nav. */
export async function GET(req: Request) {
  const user = ownerCaller();
  const parsed = Query.safeParse({
    account: new URL(req.url).searchParams.get('account') ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json({ error: 'account is required' }, { status: 400 });
  }
  const folders = await folderFacets(user.id, parsed.data.account);
  return NextResponse.json({ folders });
}
