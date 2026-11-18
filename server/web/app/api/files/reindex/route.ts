import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { emailAttachmentIds } from '@mantle/files';
import { reindexFiles, reindexIdsOf } from '@mantle/tools';
import { FILE_REINDEX_MAX, type FileReindexAnswer } from '@mantle/client-types';
import { ownerCaller } from '@/lib/auth';
import { callerMayReadEmail } from '@/lib/api-v1';
import { JSON_BODY_CEILING_BYTES } from '@/lib/body-limit';
import { readBody } from '@/lib/read-body';
import { routePolicy } from '@/lib/auth/route-declaration';

/** Open to member logins, as a file's PATCH. The files are named in the
 *  body; the one rights check is reindexFiles' own edit of each file
 *  (itemWriteVerdicts), before anything, as for the tool. */
export const policy = routePolicy({
  POST: {
    class: 'content',
    open: 'owner',
    item: {
      none: 'the files it reads again: named in the body, not the path; the handler asks the edit of each',
    },
  },
});

/** A FileReindexBody. The ids are checked by reindexIdsOf, the same check
 *  as `file_reindex`. */
const Body = z.object({ ids: z.array(z.string().max(40)).max(FILE_REINDEX_MAX * 2) }).strict();

/**
 * POST /api/files/reindex: read files again through the whole pipeline
 * (docs/files.md, "Reindex and stale indexes"): one file or up to
 * FILE_REINDEX_MAX. The answer is a FileReindexAnswer: every id is queued or
 * named in `skipped` with its reason. A bad body (no ids, not ids, too many)
 * is a 400 with its sentence, and nothing is queued. The MCP tool
 * `file_reindex` does the same, through the same function. An API key
 * without the Search area does not reach an email attachment (access
 * matrix M4): it is `not-found`, as on the file's GET.
 */
export async function POST(req: Request) {
  const user = ownerCaller();
  const body = await readBody(req, Body, { maxBytes: JSON_BODY_CEILING_BYTES });
  const checked = reindexIdsOf(body.ids);
  if ('error' in checked) return NextResponse.json({ error: checked.error }, { status: 400 });
  const hidden = callerMayReadEmail()
    ? new Set<string>()
    : await emailAttachmentIds(user.id, checked.ids);
  const answer = await reindexFiles(
    user.id,
    checked.ids.filter((id) => !hidden.has(id)),
  );
  for (const id of hidden) answer.skipped.push({ id, reason: 'not-found' });
  return NextResponse.json(answer satisfies FileReindexAnswer);
}
