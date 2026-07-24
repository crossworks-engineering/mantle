/**
 * /api/apps/[id]/draft — autosave the working source tree (PUT) or discard it
 * (DELETE). Mirrors the pages draft autosave: writes draft_source only; the
 * published app + its build are untouched until app_publish.
 */
import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { getOwnerOr401 } from '@/lib/auth';
import {
  saveDraftSource,
  discardAppDraft,
  AppSourceLimitError,
  MAX_APP_FILES,
  MAX_APP_FILE_BYTES,
  MAX_APP_PATH_LEN,
} from '@mantle/content';


// Shares the content layer's source-tree limits (single source of truth); the
// content layer re-checks and is the real authority (covers the agent path too).
const Body = z.object({
  entry: z.string().min(1).max(MAX_APP_PATH_LEN),
  files: z.record(z.string().max(MAX_APP_PATH_LEN), z.string().max(MAX_APP_FILE_BYTES)),
});

export async function PUT(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const { id } = await ctx.params;
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: 'invalid input' }, { status: 400 });
  if (Object.keys(parsed.data.files).length > MAX_APP_FILES) {
    return NextResponse.json({ error: `too many files (max ${MAX_APP_FILES})` }, { status: 400 });
  }
  try {
    const ok = await saveDraftSource(user.id, id, parsed.data);
    if (!ok) return NextResponse.json({ error: 'app not found' }, { status: 404 });
  } catch (err) {
    if (err instanceof AppSourceLimitError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    throw err;
  }
  return NextResponse.json({ ok: true });
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const { id } = await ctx.params;
  const ok = await discardAppDraft(user.id, id);
  if (!ok) return NextResponse.json({ error: 'app not found' }, { status: 404 });
  return NextResponse.json({ ok: true });
}
