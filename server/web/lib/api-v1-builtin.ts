/**
 * Run one builtin tool for a /api/v1 route (lib/api-v1.ts) through dispatch
 * and the one gate (workspaces arch A5 step 4), as the owner on the `api`
 * path: the tool's declared policy, its preconditions and the items its
 * write names (the gate's item pre-check), then the handler. The route has
 * already checked the caller (getOwnerOr401) and the key's scope (the HTTP
 * gate, A4), so the call names the process caller of a route
 * (apiV1Caller): no key or peer narrowing past what the request's own gate
 * judged. Errors are the tool's own teaching messages, answered as 400.
 */
import { NextResponse } from '@/server/http-compat';
import { apiV1Caller, dispatchTool, getBuiltin } from '@mantle/tools';
import type { Tool } from '@mantle/db';
import { hiddenFromKey } from './api-v1';

/** The id arguments a v1 route passes a builtin: each must be an item the
 *  caller reaches (an email attachment, or an item made from one, is not
 *  found for a key without Search: access matrix T4). */
const ID_ARGS = ['table_id', 'file_id', 'node_id', 'id'] as const;

export async function runBuiltinForApi(
  slug: string,
  input: Record<string, unknown>,
  ownerId: string,
  status = 200,
): Promise<Response> {
  const def = getBuiltin(slug);
  if (!def) return NextResponse.json({ error: 'internal error' }, { status: 500 });
  const ids = ID_ARGS.map((k) => input[k]).filter((v): v is string => typeof v === 'string');
  if ((await hiddenFromKey(ownerId, ids)).size > 0) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }
  const row = { slug: def.slug, handler: { kind: 'builtin', ref: def.slug } } as unknown as Tool;
  const result = await dispatchTool(row, input, {
    ownerId,
    surface: { kind: 'owner', via: 'api' },
    caller: apiV1Caller(),
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
  return NextResponse.json(result.output, { status });
}
