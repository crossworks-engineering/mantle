/**
 * The one body reader of a route (A10 part 2, fold 1; docs/request-plumbing.md).
 *
 * A route reads its JSON body with `readBody(req, Schema)` (the parsed data,
 * or the one 400) or, where it checks the value itself, `readJson(req)`.
 * Before, each of 178 route files called `req.json()` with its own fallback
 * (`.catch(() => ({}))`, `null`, a try block): a body that was not JSON
 * became `{}` and failed later with some other message, or was accepted.
 *
 *  - The bytes come through the route's ceiling: the route loader hands
 *    every handler a capped request (capRequestBody, lib/body-limit.ts), so
 *    a body over it throws BodyTooLargeError (413).
 *  - An empty body (no bytes, or only white space) reads as `{}`, or as the
 *    route's own `empty` value: an action with no fields needs no body, as
 *    before.
 *  - A body that is not JSON throws BadBodyError with BAD_JSON_MESSAGE
 *    (app.onError answers 400 `{ error: 'invalid JSON' }`).
 *  - readBody: a value the schema refuses throws BadBodyError with the
 *    first problem (firstIssue): 400 `{ error }`.
 *
 * NUL characters are kept as sent (readJsonNoNul in lib/strip-nul.ts is the
 * reader that drops them); a UTF-8 byte order mark is skipped, as
 * `req.json()` skipped it.
 */
import type { z } from 'zod';
import { readBodyCapped } from './body-limit';
import { firstIssue } from './zod-issue';

/** The one answer to a body that is not JSON. */
export const BAD_JSON_MESSAGE = 'invalid JSON';

/** A request body the route cannot use: answered 400 `{ error: message }`
 *  by app.onError (answerAppError). The message is public: the reader's
 *  own text, or the first problem the route's schema found. */
export class BadBodyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BadBodyError';
  }
}

/** How a route reads its body (readJson, readBody). */
export type ReadBodyOptions = {
  /** What an empty body reads as (default `{}`). */
  empty?: unknown;
  /** An empty body is not JSON either (BadBodyError), for a route whose
   *  every call sends one. */
  refuseEmpty?: boolean;
  /** Read at most this many bytes (BodyTooLargeError past it): the JSON
   *  branch of an upload route, which the loader does not cap (no
   *  ceiling; its upload streams under its own). */
  maxBytes?: number;
};

/**
 * The request's body as JSON. An empty body reads as `{}` (or
 * `opts.empty`); a body that is not JSON throws BadBodyError; a body over
 * the route's ceiling throws BodyTooLargeError.
 */
export async function readJson(req: Request, opts: ReadBodyOptions = {}): Promise<unknown> {
  // text() reads through the loader's cap and skips a byte order mark.
  const text =
    opts.maxBytes === undefined
      ? await req.text()
      : (await readBodyCapped(req, opts.maxBytes)).replace(/^\uFEFF/, '');
  if (text.trim() === '') {
    if (opts.refuseEmpty) throw new BadBodyError(BAD_JSON_MESSAGE);
    return 'empty' in opts ? opts.empty : {};
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new BadBodyError(BAD_JSON_MESSAGE);
  }
}

/**
 * The request's body, parsed by `schema`: its data, or BadBodyError (400)
 * with the first problem. Read as readJson reads it.
 */
export async function readBody<S extends z.ZodType>(
  req: Request,
  schema: S,
  opts: ReadBodyOptions = {},
): Promise<z.output<S>> {
  const parsed = schema.safeParse(await readJson(req, opts));
  if (!parsed.success) throw new BadBodyError(firstIssue(parsed.error));
  return parsed.data;
}
