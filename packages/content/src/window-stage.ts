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
 * written or read costs a resume only: the run goes on. A window lost to a
 * passing failure (twice a timeout or a crash, `passing` of windowJob) is
 * not kept, nor any window after it in that run: a run tried again reads it
 * again, so a busy box never makes a lost window for good.
 *
 * Two runs of one file at once (an extract here and a read again in the web's
 * maintenance) share a run key's windows, which is right for a Reader whose
 * read of the same bytes is the same; the first build to end removes the
 * stage, and the other run loses only its resume.
 */
import { createHash } from 'node:crypto';
import { readWindowStage, writeWindowStage, type FileTabsWriteInput } from '@mantle/files';
import { errorMessage } from '@mantle/std';
import { log } from '@mantle/tracing';

/** The log of this module, made at the call (a test's mock of the tracing
 *  module may have no `log` until then). */
const logger = () => log('window-stage');

/** Where a run keeps its windows: the file's id, the sha256 of the bytes and
 *  the run's key. */
export type WindowStage = { fileId: string; sha256: string; runKey: string };

/** What one window gave to the run: its pages, and either the run of its
 *  step or the words of a window given up. Its pictures go beside it. */
export type WindowOutcome = {
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
      };
    }
);

/** The version of a kept window's form. */
const STAGE_FORM = 1;

/** A kept window's file: the outcome, its pictures by name as base64, and
 *  the run it is of. */
type StagedFile = WindowOutcome & {
  v: number;
  runKey: string;
  sha256: string;
  pictures: [string, string][];
};

/** The run16 of a run key: the first 16 hex of its sha256. */
export function run16Of(runKey: string): string {
  return createHash('sha256').update(runKey).digest('hex').slice(0, 16);
}

/** The run key of a Reader's windowed run: the memo key of the run, the kind
 *  and the first state, and the window's size. The whole first state is in
 *  it (the decision of the router too): the Reader writes it into its rows. */
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
function keptOf(
  stage: WindowStage,
  from: number,
  body: string,
): { outcome: WindowOutcome; pictures: Map<string, Buffer> } | null {
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
  if (!Array.isArray(o.pictures)) return null;
  const pictures = new Map<string, Buffer>();
  for (const p of o.pictures as unknown[]) {
    if (!Array.isArray(p) || typeof p[0] !== 'string' || typeof p[1] !== 'string') return null;
    pictures.set(p[0], Buffer.from(p[1], 'base64'));
  }
  if (typeof o.lost === 'string') return { outcome: { ...pages, lost: o.lost }, pictures };
  const run = o.run;
  if (!isObj(run) || run.status !== 'ok') return null;
  if (!Array.isArray(run.warnings) || !isObj(run.counts)) return null;
  const kept = run as Extract<WindowOutcome, { run: unknown }>['run'];
  return { outcome: { ...pages, run: kept }, pictures };
}

/** The windows kept of this run: `at(from)` reads the one that starts at
 *  that page, or gives null (none, not of this run, or unreadable). One
 *  window is read at a time. */
export async function openWindowStage(stage: WindowStage): Promise<{
  at(from: number): Promise<{ outcome: WindowOutcome; pictures: Map<string, Buffer> } | null>;
}> {
  let kept: Map<number, () => Promise<string | null>>;
  try {
    kept = await readWindowStage(stage.fileId, stage.sha256, run16Of(stage.runKey));
  } catch (err) {
    logger().warn(`the window stage of ${stage.fileId} was not read: ${errorMessage(err)}`);
    kept = new Map();
  }
  return {
    async at(from) {
      const body = await kept.get(from)?.();
      return body ? keptOf(stage, from, body) : null;
    },
  };
}

/** Keep one window of this run, with its pictures. Never throws: a window
 *  that cannot be kept (the disk, a body too large to write) is logged and
 *  costs only a resume of that window. */
export async function keepWindow(
  stage: WindowStage,
  outcome: WindowOutcome,
  pictures: ReadonlyMap<string, Buffer>,
): Promise<void> {
  try {
    const file: StagedFile = {
      v: STAGE_FORM,
      runKey: stage.runKey,
      sha256: stage.sha256,
      ...outcome,
      pictures: [...pictures].map(([name, b]) => [name, b.toString('base64')]),
    };
    await writeWindowStage(
      stage.fileId,
      stage.sha256,
      run16Of(stage.runKey),
      outcome.from,
      JSON.stringify(file),
    );
  } catch (err) {
    logger().warn(`a window of ${stage.fileId} was not kept: ${errorMessage(err)}`);
  }
}
