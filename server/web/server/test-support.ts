/**
 * Test support for the server tier: nothing in the server imports it (A10
 * lows, part 2 #7: it lived in app-error.ts, the production answer).
 * runRoute (run-route.ts) drives the full pipeline; this is for a test that
 * calls a handler directly.
 */
import type { Context } from 'hono';
import { answerAppError } from './app-error';

/** A route handler's answer as the app gives it: its Response, or
 *  answerAppError's answer to what it threw. For a test that calls a
 *  handler directly, with no app around it (a domain error answers by its
 *  row, as behind app.onError). */
export async function appAnswerOf(
  res: Response | Promise<Response>,
  url = 'http://localhost/api/',
  method = 'POST',
): Promise<Response> {
  try {
    return await res;
  } catch (err) {
    if (!(err instanceof Error)) throw err;
    return answerAppError(err, { req: { url, method } } as unknown as Context);
  }
}
