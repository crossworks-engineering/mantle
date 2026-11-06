/**
 * How a tool step is traced when its tool says `traceCodeOnly`
 * (BuiltinToolDef): its slug and its outcome code only. Its own entry point
 * (`@mantle/tools/trace-shape`), so a test that stands the package's index
 * in still runs the tool loop with the real rule.
 */
import { peekBuiltin } from './tool-policy';

/** Whether the named builtin's tool step keeps its slug and outcome code
 *  only. False for anything else (or an unknown slug). */
export function builtinTracesCodeOnly(slug: string): boolean {
  return peekBuiltin(slug)?.traceCodeOnly === true;
}

/** A tool failure as a code-only trace keeps it: the text before the first
 *  `:` when it is a code (`[a-z][a-z0-9_]*`, at most 64 characters: the
 *  tools' errors lead with theirs), else `error`. Never free text. */
export function errorCodeOf(error: string): string {
  const head = (error.split(':', 1)[0] ?? '').trim();
  return /^[a-z][a-z0-9_]{0,63}$/.test(head) ? head : 'error';
}
