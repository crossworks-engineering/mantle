/**
 * Run one builtin tool for a /api/v1 route (lib/api-v1.ts), the way MCP
 * runs it: the declared preconditions first, then the handler, as the
 * owner on the `api` path. The route has already checked the caller
 * (getOwnerOr401) and the key's scope (the gate). Errors are the tool's own
 * teaching messages, answered as 400.
 */
import { NextResponse } from '@/server/http-compat';
import { checkToolPreconditions, getBuiltin } from '@mantle/tools';

export async function runBuiltinForApi(
  slug: string,
  input: Record<string, unknown>,
  ownerId: string,
  status = 200,
): Promise<Response> {
  const def = getBuiltin(slug);
  if (!def) return NextResponse.json({ error: 'internal error' }, { status: 500 });
  if (def.preconditions?.length) {
    const failure = await checkToolPreconditions(def.preconditions, input, ownerId);
    if (failure && !failure.ok) {
      return NextResponse.json({ error: failure.error }, { status: 400 });
    }
  }
  const result = await def.handler(input, { ownerId, surface: { kind: 'owner', via: 'api' } });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
  return NextResponse.json(result.output, { status });
}
