/**
 * Put a file on a task (files on tasks, plan page 74b70ac6): a screenshot,
 * a log, a PDF. multipart/form-data with one `file` part, streamed to disk
 * under the task file cap (10 MB), as a Files upload is. The task's files
 * are listed by `GET /api/tasks/:id` (`files`).
 *
 * The one check is edit of the task (addTaskFile's step): who may change
 * the task may put a file on it. Refused with 400: a type off the list, an
 * empty file, a sixth file. Over 10 MB: 413.
 */
import { NextResponse } from '@/server/http-compat';
import { ownerCaller } from '@/lib/auth';
import { addTaskFile, TASK_FILE_MAX_BYTES } from '@mantle/content';
import { discardSpooled, sweepSpool } from '@mantle/files';
import { readMultipartUpload } from '@/lib/upload-stream';
import type { RouteParams } from '@/lib/route-params';
import { routePolicy } from '@/lib/auth/route-declaration';

export const routeParams = { id: 'uuid' } as const satisfies RouteParams;

export const policy = routePolicy({
  POST: {
    class: 'content',
    open: 'owner',
    item: { param: 'id', need: 'edit' },
  },
});

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = ownerCaller();
  const { id } = await ctx.params;
  const contentType = req.headers.get('content-type') ?? '';
  if (!contentType.includes('multipart/form-data')) {
    return NextResponse.json({ error: 'send the file as multipart/form-data' }, { status: 400 });
  }
  void sweepSpool();
  // Over the cap: UploadTooLargeError, 413 with the cap, by the one table.
  const parsed = await readMultipartUpload(req, { maxBytes: TASK_FILE_MAX_BYTES });
  const upload = parsed.file;
  if (!upload) return NextResponse.json({ error: 'file required' }, { status: 400 });
  try {
    const file = await addTaskFile({
      ownerId: user.id,
      taskId: id,
      filename: upload.filename,
      spooled: upload.spooled,
    });
    if (!file) return NextResponse.json({ error: 'not found' }, { status: 404 });
    return NextResponse.json({ file }, { status: 201 });
  } finally {
    // addTaskFile discards it too; this covers a throw before it ran.
    await discardSpooled(upload.spooled);
  }
}
