/**
 * The one memo of a Reader's run (docs/pipelines.md, "Text and pictures"):
 * one run of a Reader serves the three passes of an extract (the database,
 * the text, the pictures), so a file costs one parser job however many
 * passes ask. The CAD reader (./dwg.ts) and every own Reader
 * (packages/content pipeline-runner.ts `readerRun`) keep their runs here.
 * Here and not in @mantle/content because the text pass (./parse.ts) and
 * the picture pass (./embedded-images.ts) of a drawing sit in this package.
 *
 * Keyed by the pipeline's id and version (and a test's draft word), the
 * sha256 of the bytes and the extension, plus what else changes the run
 * (`more`: the options' hash, CAD's Table run): never Buffer identity, as
 * the extract's byte cache can read a file again between passes. A tiny LRU
 * (a file's passes run back to back). The PROMISE is kept, so passes that
 * ask at the same time share the job in flight.
 *
 * A failed run is kept for the rest of the run of the extract it failed in
 * (the parser scope it ran under: ./parser-client.ts `withParserScope`), so
 * the later passes neither ask the parser again nor count the same failure
 * twice. A later run (the extract's retry) asks afresh; outside any scope a
 * failure is forgotten at once. Its message is kept (by key) so a later pass
 * can explain what is missing. The error is given back as it was thrown.
 */
import { errorMessage } from '@mantle/std';
import { currentParserScope, isParserError } from './parser-client';

/** The most runs kept: two for the CAD runs, as CAD's own memo had, and two for own Readers. */
export const READER_MEMO_MAX = 4;

type Entry = { promise: Promise<unknown>; scope: object | undefined; failed: boolean };
const memo = new Map<string, Entry>();
const failures = new Map<string, string>();

/** The key of one run: `<id>@<version>[#<draft>]:<sha256>:<ext>[:<more>]`. */
export function readerRunKey(
  pipeline: { id: string; version: string; draft?: string },
  sha256: string,
  ext: string,
  more = '',
): string {
  const draft = pipeline.draft !== undefined ? `#${pipeline.draft}` : '';
  return `${pipeline.id}@${pipeline.version}${draft}:${sha256}:${ext}${more ? `:${more}` : ''}`;
}

/** The words of a failure, as the parser client's result gives them
 *  (asResult): `<code>: <message>`, `failed` for an error of no code. */
function failureText(err: unknown): string {
  return isParserError(err) ? `${err.code}: ${err.message}` : `failed: ${errorMessage(err)}`;
}

function trim(map: Map<string, unknown>): void {
  if (map.size <= READER_MEMO_MAX) return;
  const oldest = map.keys().next().value;
  if (oldest !== undefined) map.delete(oldest);
}

/** The run of this key: the one kept, or `run` started now and kept. */
export function memoReaderRun<T>(key: string, run: () => Promise<T>): Promise<T> {
  const here = currentParserScope();
  let entry = memo.get(key);
  if (entry?.failed && (entry.scope === undefined || entry.scope !== here)) {
    memo.delete(key);
    entry = undefined;
  }
  if (!entry) {
    const fresh: Entry = { promise: Promise.resolve(), scope: here, failed: false };
    const promise = (async () => run())();
    promise.then(
      () => failures.delete(key),
      (err: unknown) => {
        fresh.failed = true;
        failures.set(key, failureText(err));
        trim(failures);
      },
    );
    fresh.promise = promise;
    entry = fresh;
    memo.set(key, entry);
    trim(memo);
  }
  return entry.promise as Promise<T>;
}

/** The run of this key if one is kept: never a fresh job. */
export function keptReaderRun<T>(key: string): Promise<T> | undefined {
  return memo.get(key)?.promise as Promise<T> | undefined;
}

/** The words of the last failure of this key, if one is kept. */
export function readerRunFailure(key: string): string | undefined {
  return failures.get(key);
}
