import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { SQL_ROW_CAP_MAX } from '@mantle/tabledb';
import { fileSqlAnswer } from '@mantle/tools';
import type { FileDatabaseResponse } from '@mantle/client-types';
import { ownerCaller } from '@/lib/auth';
import { JSON_BODY_CEILING_BYTES } from '@/lib/body-limit';
import { readBody } from '@/lib/read-body';
import type { RouteParams } from '@/lib/route-params';
import { routePolicy } from '@/lib/auth/route-declaration';

/** The [id] is a uuid: any other names nothing, the one 404 before the
 *  handler (lib/route-params.ts). */
export const routeParams = { id: 'uuid' } as const satisfies RouteParams;

export const policy = routePolicy({
  POST: {
    class: 'content',
    effect: { read: "reads a file's read-only database; it writes nothing" },
    open: 'owner',
  },
});

/** The input of `file_sql`. POST, so the SQL text stays out of a URL. */
const Body = z.object({
  sql: z.string().max(20_000).optional(),
  max_rows: z.number().int().min(1).max(SQL_ROW_CAP_MAX).optional(),
});

/**
 * A file's database, for the Data view in Files: with no `sql` its tabs,
 * columns, row counts and description; with `sql` the rows of one read-only
 * SELECT. The same code and the same rights as the `file_sql` tool: the row
 * in the caller's scope, then the one refusal of every reader of a file's rows.
 * A file with no database is a 200 with `kind: 'none'` and the words why: the
 * view shows them as a state, not as a failure.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = ownerCaller();
  const { id } = await ctx.params;
  // A statement, not a document: the JSON ceiling, not the Files one.
  const body = await readBody(req, Body, { maxBytes: JSON_BODY_CEILING_BYTES });
  const got = await fileSqlAnswer(
    user.id,
    { fileId: id, sql: body.sql ?? '', cap: body.max_rows },
    // A person may use Tables, so the words may point at an old one. No key
    // reaches this route: it has no /api/v1 alias.
    { tableHint: true },
  );
  switch (got.kind) {
    case 'describe':
      return NextResponse.json({ kind: 'describe', ...got.output } satisfies FileDatabaseResponse);
    case 'rows':
      return NextResponse.json({ kind: 'rows', ...got.output } satisfies FileDatabaseResponse);
    case 'none':
      return NextResponse.json({
        kind: 'none',
        file_id: id,
        reason: got.message,
      } satisfies FileDatabaseResponse);
    case 'not-found':
      return NextResponse.json({ error: 'not found' }, { status: 404 });
    case 'refused':
      return NextResponse.json({ error: got.message }, { status: 403 });
    case 'bad-sql':
      return NextResponse.json({ error: got.message }, { status: 400 });
  }
}
