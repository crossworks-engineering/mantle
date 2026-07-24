import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getOwnerOr401 } from '@/lib/auth';
import { movePage, PageCycleError, ParentPageNotFoundError } from '@/lib/pages';

// `parentId: null` moves the page to the top level; a uuid nests it under that
// page. Structural-only — body/tags/sharing/index untouched (see movePage).
const Body = z.object({ parentId: z.string().uuid().nullable() });

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const { id } = await ctx.params;
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'invalid input' },
      { status: 400 },
    );
  }
  try {
    const row = await movePage(user.id, id, parsed.data.parentId);
    if (!row) return NextResponse.json({ error: 'not found' }, { status: 404 });
    return NextResponse.json({ page: row });
  } catch (err) {
    // Bad destination → 400 with a human message (the client surfaces it as a
    // toast); both guards are user-correctable, not server faults.
    if (err instanceof PageCycleError) {
      return NextResponse.json(
        { error: "Can't nest a page inside itself or one of its own sub-pages." },
        { status: 400 },
      );
    }
    if (err instanceof ParentPageNotFoundError) {
      return NextResponse.json(
        { error: 'That destination page no longer exists.' },
        { status: 400 },
      );
    }
    throw err;
  }
}
