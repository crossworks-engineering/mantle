import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { emailAttachmentIds } from '@mantle/files';
import { archiveExtractAnswer, extractArchive } from '@mantle/tools';
import type { ArchiveExtractAnswer } from '@mantle/client-types';
import { ownerCaller } from '@/lib/auth';
import { callerMayReadEmail } from '@/lib/api-v1';
import { JSON_BODY_CEILING_BYTES } from '@/lib/body-limit';
import { readBody } from '@/lib/read-body';
import type { RouteParams } from '@/lib/route-params';
import { routePolicy } from '@/lib/auth/route-declaration';

/** The [id] is a uuid: any other names nothing, the one 404 before the
 *  handler (lib/route-params.ts). */
export const routeParams = { id: 'uuid' } as const satisfies RouteParams;

/** Open to member logins, as the file's PATCH. The read is the file's own
 *  (a file the caller does not read is a 404); the POST's `item` names
 *  what the write needs, and the one rights check is extractArchive's own
 *  edit of the archive, before anything, as for the tool. */
export const policy = routePolicy({
  GET: { class: 'content', open: 'owner' },
  POST: {
    class: 'content',
    open: 'owner',
    item: { param: 'id', need: 'edit' },
  },
});

/** The ask takes no fields: an empty object (or no body). A field is a
 *  400, so a client that thinks it picks the folder hears it does not. */
const Body = z.object({}).strict();

/** An API key without the Search area does not reach an email attachment
 *  (access matrix M4), as on the file's GET. */
async function hiddenAttachment(ownerId: string, id: string): Promise<boolean> {
  return !callerMayReadEmail() && (await emailAttachmentIds(ownerId, [id])).has(id);
}

/**
 * GET /api/files/files/:id/extract: whether "Extract contents" applies to
 * the file (a ZIP, TAR or gzip by its name and its first bytes; `why` when
 * not) and the state of its last extraction: queued, running (with the
 * files so far), done or failed, the folder, the counts and the entries
 * not written with their reasons (docs/files.md, "Archives"). An
 * ArchiveExtractAnswer. The same answer as `file_extract_archive` with
 * `check: true`.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = ownerCaller();
  const { id } = await ctx.params;
  if (await hiddenAttachment(user.id, id)) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }
  const res = await archiveExtractAnswer(user.id, id);
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: res.status });
  return NextResponse.json(res.answer satisfies ArchiveExtractAnswer);
}

/**
 * POST /api/files/files/:id/extract: extract the archive's contents into a
 * new folder beside it, named after it, in the background (docs/files.md,
 * "Archives"). Never done by itself: this route and the tool
 * `file_extract_archive` are the only ways in. The body is empty (`{}` or
 * none). The answer is the
 * ArchiveExtractAnswer with the `queued` state and the folder; a refusal
 * is its status with its sentence: 404 not found, 403 not the caller's to
 * change (or no folder may be added beside it), 400 not an archive this box
 * extracts (7z and RAR are not) or no room for a folder beside it, 409 an
 * extraction of it under way.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = ownerCaller();
  const { id } = await ctx.params;
  // No fields, not a document: the JSON ceiling.
  await readBody(req, Body, { maxBytes: JSON_BODY_CEILING_BYTES });
  if (await hiddenAttachment(user.id, id)) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }
  const res = await extractArchive(user.id, id);
  if (!res.ok) {
    return NextResponse.json({ error: res.error, reason: res.reason }, { status: res.status });
  }
  return NextResponse.json(res.answer satisfies ArchiveExtractAnswer);
}
