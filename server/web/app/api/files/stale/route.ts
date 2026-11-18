import { NextResponse } from '@/server/http-compat';
import { fileStaleList } from '@mantle/tools';
import type { FileStaleAnswer } from '@mantle/client-types';
import { ownerCaller } from '@/lib/auth';
import { callerMayReadEmail } from '@/lib/api-v1';
import { emailAttachmentIds } from '@mantle/files';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  GET: { class: 'content', open: 'owner' },
});

/**
 * GET /api/files/stale?state=stale|failed|partial&cursor=&limit=: one page
 * of the files that need attention, newest first, each with its status
 * (docs/files.md, "Reindex and stale indexes"). Read in the caller's scope.
 * The answer is a FileStaleAnswer; a bad query is a 400 with its sentence.
 * The MCP tool `file_stale_list` does the same, through the same function.
 * An API key without the Search area does not get email attachment rows, as
 * on the other file lists.
 */
export async function GET(req: Request) {
  const user = ownerCaller();
  const q = Object.fromEntries(new URL(req.url).searchParams);
  const res = await fileStaleList(user.id, q);
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: 400 });
  let files = res.answer.files;
  if (!callerMayReadEmail() && files.length > 0) {
    const mail = await emailAttachmentIds(
      user.id,
      files.map((f) => f.id),
    );
    files = files.filter((f) => !mail.has(f.id));
  }
  return NextResponse.json({ ...res.answer, files } satisfies FileStaleAnswer);
}
