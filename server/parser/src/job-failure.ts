/**
 * A job's typed failure: what the job process writes to `error.json` before
 * it exits, and what the server answers (the wire's error envelope).
 *
 * `final`: the failure is the file's for good, the same bytes fail the same
 * way every time (a fixed cap: the body, a zip part, the cells, the pixels,
 * the answer). The client makes it terminal at once instead of after a
 * second try. A full scratch space is not final: it can be full for other
 * reasons, so it gets its one retry.
 */
import type { ParserErrorCode } from '@mantle/files/parser-wire';

export class JobFailure extends Error {
  readonly code: ParserErrorCode;
  readonly final: boolean;
  constructor(code: ParserErrorCode, message: string, opts: { final?: boolean } = {}) {
    super(message);
    this.name = 'JobFailure';
    this.code = code;
    this.final = opts.final === true;
  }
}
