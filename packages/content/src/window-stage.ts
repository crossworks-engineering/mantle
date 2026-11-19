/**
 * The window stage of a Reader's windowed run (docs/pipelines.md, "Page
 * windows", "A book read again"): each page window a real read finished is
 * kept as it ends, so a run tried again (an expired book, a restart, a busy
 * parser in window 40) takes the windows kept and reads on from the first one
 * that is not, never from window 1.
 *
 * Kept on disk beside the file's database, in the same folder
 * (@mantle/files file-dbs.ts, `<file id>.<sha16>.stage-<run16>-<first
 * page>.json`): one JSON file a window, what the window gave to the run
 * (runWindowed): its pages, and either the run of its step (status `ok`, its
 * write, warnings, counts, the state for the next window and its pictures)
 * or the words of a window given up (`lost`). A window given up is kept too,
 * so a read resumed is the read it would have been in one go.
 *
 * Keyed by the file's id, the sha256 of the bytes read (the stage checks the
 * whole sha256 inside each file, not only the sha16 of its name) and the run
 * key: the Reader's id and version, the bytes, the options, the kind it was
 * named and the state of its first window, and the window's size. New bytes,
 * another Reader version or other options never take a kept window.
 *
 * The Reader's step asks no model (runWindowed has no `ask`), so no paid call
 * is kept or repeated here: an Agent's paid rows are written into the file's
 * database window by window already (runAgentWindowed) and taken by their
 * hash on the next run.
 *
 * Removed at the end of the build (buildFileDatabase: removeWindowStage),
 * with the file's other names on a delete or a turn to private, and on new
 * bytes (removeOtherWindowStages, the extract's gate). A stage that cannot be
 * written or read costs a resume only: the run goes on.
 */
import { createHash } from 'node:crypto';
import { readWindowStage, writeWindowStage, type FileTabsWriteInput } from '@mantle/files';
import { log } from '@mantle/tracing';

const logger = log('window-stage');

/** Where a run keeps its windows: the file's id, the sha256 of the bytes and
 *  the run's key. */
export type WindowStage = { fileId: string; sha256: string; runKey: string };

/** What one window gave to the run, as kept. */
export type StagedOutcome = {
  from: number;
  to: number;
  pagesTotal: number;
} & (
  | { lost: string }
  | {
      run: {
        status: 'ok';
        write?: FileTabsWriteInput;
        warnings: string[];
        counts: Record<string, number>;
        state?: unknown;
        /** The window's pictures, by name, as base64. */
        pictures: [string, string][];
      };
    }
);

/** The version of a kept window's form. */
const STAGE_FORM = 1;

type StagedFile = StagedOutcome & { v: number; runKey: string; sha256: string };

/** The run16 of a run key: the first 16 hex of its sha256. */
export function run16Of(runKey: string): string {
  return createHash('sha256').update(runKey).digest('hex').slice(0, 16);
}

/** The run key of a Reader's windowed run: the memo key of the run, the kind
 *  and the first state, and the window's size. */
export function windowRunKey(
  memoKey: string,
  named: { kind?: string; state?: unknown },
  window: { pages: number; mb: number },
): string {
  const state = createHash('sha256')
    .update(JSON.stringify(named.state ?? null))
    .digest('hex')
    .slice(0, 16);
  return `${memoKey}|kind=${named.kind ?? ''}|state=${state}|window=${window.pages}x${window.mb}`;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** One kept window as read back, or null when it is not one of this run. */
function outcomeOf(stage: WindowStage, from: number, body: string): StagedOutcome | null {
  let o: unknown;
  try {
    o = JSON.parse(body);
  } catch {
    return null;
  }
  if (!isObj(o) || o.v !== STAGE_FORM) return null;
  if (o.runKey !== stage.runKey || o.sha256 !== stage.sha256 || o.from !== from) return null;
  const { to, pagesTotal } = o;
  if (!Number.isInteger(to) || !Number.isInteger(pagesTotal)) return null;
  if ((to as number) < from || (pagesTotal as number) < (to as number)) return null;
  const pages = { from, to: to as number, pagesTotal: pagesTotal as number };
  if (typeof o.lost === 'string') return { ...pages, lost: o.lost };
  const run = o.run;
  if (!isObj(run) || run.status !== 'ok') return null;
  if (!Array.isArray(run.warnings) || !isObj(run.counts) || !Array.isArray(run.pictures)) {
    return null;
  }
  return { ...pages, run: run as Extract<StagedOutcome, { run: unknown }>['run'] };
}

/** The windows kept of this run, by their first page. Empty when none, or
 *  when the stage cannot be read. */
export async function stagedWindows(stage: WindowStage): Promise<Map<number, StagedOutcome>> {
  const out = new Map<number, StagedOutcome>();
  try {
    const kept = await readWindowStage(stage.fileId, stage.sha256, run16Of(stage.runKey));
    for (const [from, body] of kept) {
      const o = outcomeOf(stage, from, body);
      if (o) out.set(from, o);
    }
  } catch (err) {
    logger.warn(`the window stage of ${stage.fileId} was not read: ${String(err)}`);
  }
  return out;
}

/** Keep one window of this run. A failure is logged by the write and costs
 *  only a resume of that window. */
export async function keepWindow(stage: WindowStage, outcome: StagedOutcome): Promise<void> {
  const file: StagedFile = {
    v: STAGE_FORM,
    runKey: stage.runKey,
    sha256: stage.sha256,
    ...outcome,
  };
  await writeWindowStage(
    stage.fileId,
    stage.sha256,
    run16Of(stage.runKey),
    outcome.from,
    JSON.stringify(file),
  );
}

/** A window's pictures, as the stage keeps them. */
export function picturesToStage(pictures: ReadonlyMap<string, Buffer>): [string, string][] {
  return [...pictures].map(([name, b]) => [name, b.toString('base64')]);
}

/** A kept window's pictures, as the run holds them. */
export function picturesFromStage(pictures: readonly [string, string][]): Map<string, Buffer> {
  return new Map(pictures.map(([name, b64]) => [name, Buffer.from(b64, 'base64')]));
}
