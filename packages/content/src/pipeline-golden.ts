/**
 * The golden files of a move (docs/pipelines.md, "The same-result proof").
 * Before a reader moves to a package, a script runs the old path on the
 * fixed set (`pkg/<id>/fixtures/`) and writes, for each file, the
 * ParsedFile it gave, with goldenOf, into `pkg/<id>/golden/<fixture>.json`.
 * After the move, the compare test runs the step in its own process
 * (inProcessStepJob, @mantle/files/pipelines/test-job), maps the result as
 * readSheets does (parsedFileOfRun, ./file-database.ts), and asks goldenOf
 * again. The two texts must be the same. A golden file is never changed to
 * make a test pass: a real difference goes to the integrator.
 *
 * The form: canonical JSON (keys sorted, two spaces, a newline at the end).
 * A ParsedFile whose JSON is over GOLDEN_INLINE_MAX_BYTES is stored as its
 * sha256 and its counts: the kind, the description, and for each tab its
 * name, columns and row count.
 */
import { createHash } from 'node:crypto';
import type { ParsedFile } from './file-database';

/** A ParsedFile larger than this as JSON is stored as its hash and counts. */
export const GOLDEN_INLINE_MAX_BYTES = 256 * 1024;

/** JSON with the keys of every object sorted, so the same value is the same
 *  text. `undefined` keys are left out, as JSON does. */
export function canonicalJson(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === 'object') {
      return Object.fromEntries(
        Object.keys(v as Record<string, unknown>)
          .sort()
          .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
          .map((k) => [k, sort((v as Record<string, unknown>)[k])]),
      );
    }
    return v;
  };
  return `${JSON.stringify(sort(value), null, 2)}\n`;
}

/** The golden text of one ParsedFile. */
export function goldenOf(parsed: ParsedFile): string {
  const whole = canonicalJson(parsed);
  if (Buffer.byteLength(whole, 'utf8') <= GOLDEN_INLINE_MAX_BYTES) return whole;
  return canonicalJson({
    sha256: createHash('sha256').update(whole).digest('hex'),
    kind: parsed.kind,
    ...(parsed.kind === 'sheets'
      ? {
          description: parsed.description,
          tabs: parsed.sheets.map((s) => ({
            name: s.name,
            columns: s.columns.map((c) => `${c.name}:${c.type}`),
            rows: s.rows.length,
          })),
        }
      : {}),
  });
}
