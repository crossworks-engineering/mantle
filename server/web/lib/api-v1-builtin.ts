/**
 * Run one builtin tool for a /api/v1 route (lib/api-v1.ts) through dispatch
 * and the one gate, as the owner on the `api` path: the tool's declared
 * policy and its preconditions, then the handler. The HTTP gate has
 * already answered the caller and the key's scope, so the call names the process caller of a route (apiV1Caller): no key or
 * peer narrowing past what the request's own gate judged. A refusal (the
 * tool's, or a gate step's) is the tool's own teaching message, answered
 * as 400; but an item the edit check refuses (the library's
 * assertItemRight, or the database) goes on to app.onError as the edit
 * check's refusal, its 403 item-workspace or 404. No HTTP item gate
 * answers such a write first: the route, or the tool, asks the item's
 * right itself. An error the handler or a check throws is thrown on, to
 * app.onError: an edit check refusal its 403 or 404, a
 * database or any other error the opaque 500, never its text
 * (api-v1-builtin.test.ts).
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
