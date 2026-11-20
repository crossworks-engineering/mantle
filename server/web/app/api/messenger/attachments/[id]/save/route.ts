import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { anyLoginCaller } from '@/lib/auth';
import { readBody } from '@/lib/read-body';
import { messengerActorOf, saveMessengerAttachment } from '@/lib/messenger';
import type { RouteParams } from '@/lib/route-params';
import { routePolicy } from '@/lib/auth/route-declaration';

export const routeParams = { id: 'uuid' } as const satisfies RouteParams;

export const policy = routePolicy({
  POST: {
    class: 'self',
    scope: null,
    open: 'any',
    item: {
      none: 'copies a chat file into a folder of Files; the write runs in the login scope, where the folder decides the right',
    },
    limits: { rateLimit: ['messengerWrite'] },
  },
});

const SaveBody = z.object({ parentPath: z.string().min(1).max(500) });

/** POST /api/messenger/attachments/:id/save {parentPath}: Save to Files, a
 *  copy of a chat file I read into a folder of Files, as an upload by hand
 *  (the folder's create right is mine; a taken name is 409). Answers the
 *  new file. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const login = anyLoginCaller();
  const { id } = await ctx.params;
  const body = await readBody(req, SaveBody);
  const file = await saveMessengerAttachment(messengerActorOf(login), id, body.parentPath);
  return NextResponse.json({ file }, { status: 201 });
}
