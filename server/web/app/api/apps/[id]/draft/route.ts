/**
 * /api/apps/[id]/draft — autosave the working source tree (PUT) or discard it
 * (DELETE). Mirrors the pages draft autosave: writes draft_source only; the
 * published app + its build are untouched until app_publish.
 *
 * PUT takes `baseDraftUpdatedAt`, the draft stamp the editor last read (null
 * for "no draft"). When the draft changed since (the assistant wrote a file,
 * another window saved) it answers 409 `reason: 'conflict'` and writes
 * nothing, instead of overwriting that work (apps audit U1). It answers the
 * new stamp. Without the field the save goes through, as for an older editor.
 */
import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { getOwnerOr401 } from '@/lib/auth';
import {
  saveDraftSource,
  discardAppDraft,
  AppDraftConflictError,
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
  baseDraftUpdatedAt: z.string().max(64).nullable().optional(),
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
  const { baseDraftUpdatedAt, ...source } = parsed.data;
  try {
    const saved = await saveDraftSource(
      user.id,
      id,
      source,
      baseDraftUpdatedAt !== undefined ? { baseDraftUpdatedAt } : {},
    );
    if (!saved) return NextResponse.json({ error: 'app not found' }, { status: 404 });
    return NextResponse.json({ ok: true, draftUpdatedAt: saved.draftUpdatedAt });
  } catch (err) {
    if (err instanceof AppSourceLimitError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    if (err instanceof AppDraftConflictError) {
      return NextResponse.json({ error: err.message, reason: 'conflict' }, { status: 409 });
    }
    throw err;
  }
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const { id } = await ctx.params;
  const ok = await discardAppDraft(user.id, id);
  if (!ok) return NextResponse.json({ error: 'app not found' }, { status: 404 });
  return NextResponse.json({ ok: true });
}
