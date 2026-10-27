/**
 * A job's typed failure: what the job process writes to `error.json` before
 * it exits, and what the server answers (the wire's error envelope).
 */
import type { ParserErrorCode } from '@mantle/files/parser-wire';

export class JobFailure extends Error {
  readonly code: ParserErrorCode;
  constructor(code: ParserErrorCode, message: string) {
    super(message);
    this.name = 'JobFailure';
    this.code = code;
  }
}
