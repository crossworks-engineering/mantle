import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { ownerCaller } from '@/lib/auth';
import { hiddenFromKey } from '@/lib/api-v1';
import { commitTable, tableToText } from '@/lib/tables';
import type { TableDoc } from '@mantle/content-core/table-model';
import { recordIngest } from '@mantle/tracing';
import { readJson } from '@/lib/read-body';
import type { RouteParams } from '@/lib/route-params';

/** The [id] is a uuid: any other names nothing, the one 404 before the
 *  handler (lib/route-params.ts). */
export const routeParams = { id: 'uuid' } as const satisfies RouteParams;

// `data` is the LEGACY whole-doc shape (pre-P3 clients / small tables). The
// op-based client posts an empty body and the SERVER draft is promoted — the
// only commit shape that works past the materialize window, and the §4
// truncation-guard fix (a windowed doc committed whole would BE published
// truncation).
const Body = z.object({
  data: z.record(z.string(), z.unknown()).optional(),
  /** Kept on the history entry of the version this commit replaces. */
  note: z.string().max(500).optional(),
});

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = ownerCaller();
  const { id } = await ctx.params;
  // An email attachment's table is not found for a key without Search (T4).
  if ((await hiddenFromKey(user.id, [id])).size > 0) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }
  const parsed = Body.safeParse(await readJson(req));
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid input' }, { status: 400 });
  }
  const table = await commitTable(user.id, id, parsed.data.data as TableDoc | undefined, {
    actor: 'owner',
    note: parsed.data.note ?? null,
  });
  if (!table) return NextResponse.json({ error: 'not found' }, { status: 404 });

  const snippet = tableToText(table.data, { title: table.title });
  void recordIngest({
    source: 'table_commit',
    ownerId: user.id,
    nodeId: table.id,
    summary: `Table committed: ${table.title.slice(0, 80)}`,
    payload: { title: table.title, tags: table.tags, via: 'web_api' },
    snippet,
  });
  return NextResponse.json({ table });
}
