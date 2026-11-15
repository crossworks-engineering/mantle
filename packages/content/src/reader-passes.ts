/**
 * The text and the pictures of a file from its Reader (docs/pipelines.md,
 * "Text and pictures from every Reader"). The caller asks only where the
 * core has no reader of its own for that pass: the text pass when the
 * extension has no text route (`parserRouteForExt(ext) === 'none'`), the
 * picture pass when the extension is not one the core reads pictures of. So
 * the core's text and pictures always stand where it has them.
 *
 * The rule, once for both passes: the box's Reader of the extension
 * (boxPipelines) gives a pass it names in `produces` (`text`, with no core
 * text route: readerGivesText; `pictures`),
 * unless it is off in the file's home workspace (pipelineOffHere, the one
 * test the database pass makes too). Its run is the one the database pass
 * made, kept for the extract (readerRun), so the three passes cost one job.
 * No model is asked: the run is model-free.
 */
import { effectiveOptions } from '@mantle/files';
import { readFileRowNow } from './file-database';
import { boxPipelines } from './pipeline-registry';
import { readerGivesText, readerRun, type PipelineRunResult } from './pipeline-runner';
import { pipelineOffHere, pipelineStateOf } from './pipeline-state';

export { readerGivesText };

export type ReaderPass = 'text' | 'pictures';

/**
 * The run of the Reader of this file for one pass, or null when no Reader
 * of the box gives that pass for the extension, or it is off where the file
 * lives. Nothing runs until the caller calls it with the bytes. `fileId`:
 * the file whose home workspace the off list is read for (null: a file with
 * no row yet, on in every workspace).
 */
export async function readerPassOf(
  ownerId: string,
  fileId: string | null,
  ext: string,
  pass: ReaderPass,
): Promise<((bytes: Buffer) => Promise<PipelineRunResult>) | null> {
  const reader = (await boxPipelines(ownerId)).readerFor(ext);
  if (!reader) return null;
  if (pass === 'text' ? !readerGivesText(reader, ext) : reader.produces.pictures !== true)
    return null;
  const state = await pipelineStateOf(ownerId, reader);
  const home = fileId ? ((await readFileRowNow(fileId, ownerId))?.home ?? null) : null;
  if (pipelineOffHere(state, home)) return null;
  const options = effectiveOptions(reader, state.options);
  return (bytes) => readerRun(reader, bytes, ext, options);
}

/** The text of a Reader's run: its write's `text` when it ended `ok`, else
 *  ''. A failed run throws, as for any document. */
export async function readerTextOf(
  run: (bytes: Buffer) => Promise<PipelineRunResult>,
  bytes: Buffer,
): Promise<string> {
  const r = await run(bytes);
  return r.status === 'ok' ? (r.write?.text ?? '') : '';
}
