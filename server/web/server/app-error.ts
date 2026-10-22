/**
 * The app's answer to an error a route threw (server/app.ts onError). Its
 * own module so a test can put a route behind the same answer without the
 * whole app (lib/api-v1-builtin.test.ts; appAnswerOf in test-support.ts).
 *
 * It runs OUTSIDE the gate's ALS frame (Hono's compose catches thrown
 * errors after store.run unwinds): never call the ambient cookies() or
 * headers() shims here; they would throw "outside a request scope". Use
 * c.req.raw directly if request data is ever needed.
 */
import type { Context } from 'hono';
import { BUSY_MESSAGE, BusyError, busyMessage, isBusy } from '@mantle/db';
import { BodyTooLargeError, bodyTooLargeResponse } from '../lib/body-limit';
import { domainErrorAnswer } from '@mantle/std';
// Registers BadBodyError's row in the domain error table.
import '../lib/read-body';
import { RedirectError } from './http-compat/redirect-error';
import { RouteRefusal } from '../lib/auth/session';
import { scopeRefusalResponse } from './scope-refusal';

export function answerAppError(err: Error, c: Context): Response {
  if (err instanceof RedirectError) {
    return c.redirect(err.location, err.status);
  }
  // The refusal of an answer taken at the read (A4 hand batch B,
  // ownerCallerAtRead): the guard's own response, as the handler returned
  // it before.
  if (err instanceof RouteRefusal) return err.response;
  const path = new URL(c.req.url).pathname;
  // A refusal, never a crash, read by the one mapper (arch A3c): the
  // database refused a write of an item the caller may not change (W6a
  // fix round 1, A3a), a client scope met public-level work or the
  // reverse (client logins, audit A5), or the gate refused the call.
  const refusal = scopeRefusalResponse(err, path);
  if (refusal) return refusal;
  // A JSON body over its route's ceiling, found while reading (I4).
  if (err instanceof BodyTooLargeError) return bodyTooLargeResponse(err.maxBytes);
  // A domain error (A10 part 2, fold 2): the one table (@mantle/std
  // domain-errors.ts) names its status and its public text, the same a
  // tool says. A body the route cannot use (BadBodyError) is one.
  const domain = domainErrorAnswer(err);
  if (domain) return Response.json(domain.body, { status: domain.status });
  // Another write held the same rows (a deadlock broken, a lock timeout):
  // "busy, try again" for a person, never the SQL (folder audit review F7).
  // A pool's wait run out (a read as well, under drizzle's wrap too) says
  // the plain text, never the folders one (busyMessage).
  if (isBusy(err)) {
    return Response.json(
      { error: busyMessage(err, err instanceof BusyError ? err.message : BUSY_MESSAGE) },
      { status: 409 },
    );
  }
  console.error(`[server] unhandled error on ${c.req.method} ${path}:`, err);
  if (path === '/api' || path.startsWith('/api/')) {
    // Body matches Next's opaque route-handler failure: no error details leak.
    return Response.json({ error: 'internal error' }, { status: 500 });
  }
  return c.text('Internal server error', 500);
}
