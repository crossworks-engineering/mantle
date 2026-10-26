/**
 * A retired route's 410 stub: it answers `{ error, code: 'gone' }`, so an
 * old UI or an old phone app can tell the person to update instead of
 * showing a vague error. The stubs of the routes removed in workspaces W5c
 * to W8d (review, team drafts, Team admin, the client portal, the personal
 * spaces, the member routes, the levels) were deleted in arch A7, once no
 * box logged a hit for a release (scripts/arch-scoreboard-box.sh); none is
 * left. This module stays for a route retired later.
 *
 * A stub still answers the guard its route had: without a session the gate
 * and the guard answer 401 as before, a login of another kind is refused as
 * before, and the role sweeps keep proving who reaches what. Only a caller
 * the old route served gets the 410.
 *
 * Since A4 hand batch A the gate answers that guard, not the stub: the
 * route manifest generator reads `export const GET = gone('owner')` as a
 * handler that reads the caller of the stub's kind (GONE_KINDS,
 * lib/gone-kinds.ts, the one table), so the stub's row is a gone row (`gone`,
 * route-policy.ts) whose caller is that kind, and the gate's answer step
 * runs the kind's guard once, before the handler, as on every row a handler
 * reads (the one answer step: no second path at the gate). The stub then
 * reads the answer (fail closed: no answer of its kind, no 410) and answers
 * the 410. One line per stub, as before; no stub calls a guard.
 */
import { NextResponse } from '@/server/http-compat';
import { getRequestContext } from '@/server/request-context';
import { anyLoginCaller, memberCaller, ownerCaller } from '@/lib/auth';
import { GONE_KINDS, type GoneGuard } from './gone-kinds';

export { GONE_KINDS, type GoneGuard } from './gone-kinds';

/** The reader of each stub's kind (GONE_KINDS): it throws where the
 *  pipeline answered no caller of that kind (outside a routed request, a
 *  row not read as a gone row), so a stub never answers 410 to a caller
 *  nobody checked. */
const READERS: Readonly<Record<(typeof GONE_KINDS)[GoneGuard]['reader'], () => unknown>> = {
  ownerCaller: () => ownerCaller(),
  memberCaller: () => memberCaller(),
  anyLoginCaller: () => anyLoginCaller(),
};

export const GONE_MESSAGE = 'This feature was removed. Update the app.';

/** The 410 body every removed route answers. Each one is logged as
 *  `[gone] 410 <path>`, so a box's hits on retired routes can be counted
 *  from its log (scripts/arch-scoreboard-box.sh) before a stub is removed. */
export function goneResponse(error: string = GONE_MESSAGE): NextResponse {
  console.warn(`[gone] 410 ${getRequestContext()?.path ?? '?'}`);
  return NextResponse.json({ error, code: 'gone' }, { status: 410 });
}

/**
 * A handler for a removed route: the gate answered the old guard (its row's
 * caller is the stub's kind), then 410. Write it as the method's export, so
 * the generator reads it:
 *
 *   export const GET = gone('member');
 *   export const POST = gone('owner', 'Review is gone. Share items with Grant Access.');
 */
export function gone(kind: GoneGuard, error?: string): () => Promise<Response> {
  const read = READERS[GONE_KINDS[kind].reader];
  return async () => {
    read();
    return goneResponse(error);
  };
}
