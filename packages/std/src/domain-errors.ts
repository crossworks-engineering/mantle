/**
 * The domain errors (A10 part 2, fold 2: one error answer;
 * docs/request-plumbing.md): THE table of the errors a caller may hear,
 * by class, each with its HTTP status, its public text and why it is
 * public. Read by the HTTP tier's one error answer (answerAppError,
 * server/web/server/app-error.ts) and by the tool surface's public text
 * (publicErrorMessage), so a route and a tool say the same thing.
 *
 * Anything a row does not name is no domain error: a refusal goes to THE
 * one mapper (mapAccessError, access-error.ts), and the rest is a fault,
 * answered with the one opaque 500 and logged. A route never puts a caught
 * error's text in its reply by hand.
 *
 * Each class registers its row where it is defined (defineDomainError), so
 * this file needs no package above it; an error is matched by its class or
 * a parent class, on itself or up to three causes below it.
 */

/** What a surface says for a domain error. */
export type DomainAnswer = {
  status: number;
  body: Record<string, unknown>;
  toolText: string;
};

/** A row of the table. */
export type DomainErrorRow<E extends Error = Error> = {
  /** Why the error is the caller's to hear (what the caller did). */
  reason: string;
  /** The HTTP status, or the status by the error. */
  status: number | ((err: E) => number);
  /** The HTTP body (default `{ error: message }`). */
  body?: (err: E) => Record<string, unknown>;
  /** What a tool says (default the message). */
  toolText?: (err: E) => string;
};

type Ctor = abstract new (...args: never[]) => Error;

const TABLE = new Map<Ctor, DomainErrorRow<never>>();

/** THE table, by class (read only): what each names and why. */
export const DOMAIN_ERRORS: ReadonlyMap<Ctor, DomainErrorRow<never>> = TABLE;

/** Name `cls` (and its subclasses) a domain error, with its row. */
export function defineDomainError<E extends Error>(
  cls: abstract new (...args: never[]) => E,
  row: DomainErrorRow<E>,
): void {
  TABLE.set(cls, row as DomainErrorRow<never>);
}

function rowOf(err: object): DomainErrorRow<Error> | null {
  for (let p: object | null = Object.getPrototypeOf(err); p; p = Object.getPrototypeOf(p)) {
    const row = TABLE.get((p as { constructor: Ctor }).constructor);
    if (row) return row as DomainErrorRow<Error>;
  }
  return null;
}

/** What a surface says for `err` when the table names it (on the error or
 *  up to three causes below it), else null. */
export function domainErrorAnswer(err: unknown): DomainAnswer | null {
  let e: unknown = err;
  for (let depth = 0; depth < 4 && e && typeof e === 'object'; depth += 1) {
    const row = rowOf(e);
    if (row && e instanceof Error) {
      return {
        status: typeof row.status === 'function' ? row.status(e) : row.status,
        body: row.body ? row.body(e) : { error: e.message },
        toolText: row.toolText ? row.toolText(e) : e.message,
      };
    }
    e = (e as { cause?: unknown }).cause;
  }
  return null;
}

/**
 * A value the caller sent that the domain refuses, with a message that
 * says which (a date that is not a date, a contact with no name). Thrown
 * by a domain function where its own check runs; the caller hears 400 and
 * the message. A plain Error is a fault: the caller hears the opaque 500.
 */
export class InputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InputError';
  }
}

defineDomainError(InputError, {
  reason: 'the caller sent a value the domain refuses; the message says which',
  status: 400,
});

/**
 * A write the caller asked for that meets something already there (a file
 * or a folder of that name). Thrown by a domain function; the caller hears
 * 409 and the message, which says what to do.
 */
export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConflictError';
  }
}

defineDomainError(ConflictError, {
  reason: 'the write meets something already there (a name taken); the message says which',
  status: 409,
});
