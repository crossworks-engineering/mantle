/**
 * Re-save every `pid` canvas on a box through the checks a save runs
 * (@mantle/content resavePidCanvas: storedCanvasSource), once, after the
 * release that brought those checks (DWG bones phase 6). A canvas saved
 * before them may carry what a save now refuses or rewrites: a typed
 * "(CHECKED BY IMAGE)" in a label (circuit_trace wrote the words into
 * labels before the marks), a mark no seal holds, a count of its own.
 * The runtime already draws such a canvas honestly on view (a typed claim
 * on an element with no mark draws as GUESS); this makes the stored source
 * say the same, so an export, a copy or an agent's read of it does too.
 *
 * Manual only: the `pid-canvas-resave` maintenance task
 * (scripts/pid-canvas-resave.ts). Dry run by default (counts what would
 * change); `--apply` writes. No cron, no trigger, no model: the write
 * announces nothing and schedules no re-index (resavePidCanvas), so it
 * never spends. Each written canvas gets its own revision (the old source
 * stays in its history). A canvas a save would refuse is left as it is.
 * Every canvas's poster (the snapshot a Page embed shows, drawn by the
 * runtime before these checks) is cleared, the refused and unchanged ones
 * too: the embed shows "no snapshot yet" until the canvas's next look.
 *
 * Output is counts only: safe on a client box.
 */
import {
  listPidCanvasPage,
  resavePidCanvas,
  type PidResaveOutcome,
} from '@mantle/content/presents';

/** Canvases read per page (each up to 1 MB). */
export const RESAVE_PAGE = 20;

export type ResaveCounts = Record<PidResaveOutcome, number> & {
  canvases: number;
  /** Posters cleared (a dry run: that would be). */
  posters: number;
};

/** Every `pid` canvas, page by page, through resavePidCanvas: the counts.
 *  `limit` stops after that many canvases (null: all). */
export async function resavePidCanvases(opts: {
  apply: boolean;
  limit?: number | null;
}): Promise<ResaveCounts & { cut: boolean }> {
  const counts: ResaveCounts = {
    canvases: 0,
    changed: 0,
    unchanged: 0,
    refused: 0,
    moved: 0,
    posters: 0,
  };
  const limit = opts.limit ?? null;
  let after: string | null = null;
  for (;;) {
    const page = await listPidCanvasPage(after, RESAVE_PAGE);
    for (const id of page.ids) {
      if (limit !== null && counts.canvases >= limit) return { ...counts, cut: true };
      counts.canvases += 1;
      const r = await resavePidCanvas(id, { apply: opts.apply });
      counts[r.outcome] += 1;
      if (r.poster) counts.posters += 1;
    }
    if (!page.next) return { ...counts, cut: false };
    after = page.next;
  }
}

const USAGE = 'usage: pnpm pid:resave [--apply] [--limit <n> | --limit=<n>]';

/** The flags: `--apply`, `--limit <n>` or `--limit=<n>` (a whole number of
 *  at least 1). Anything else is an error, never ignored: a mistyped
 *  `--aply` must not run a dry run the operator took for the real one. */
export function parseResaveArgs(
  argv: readonly string[],
): { apply: boolean; limit: number | null } | { error: string } {
  let apply = false;
  let limit: number | null = null;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]!;
    if (a === '--apply') {
      apply = true;
      continue;
    }
    let value: string | undefined;
    if (a === '--limit') value = argv[++i];
    else if (a.startsWith('--limit=')) value = a.slice('--limit='.length);
    else return { error: `unknown argument '${a}'. ${USAGE}` };
    if (value === undefined || !/^[1-9][0-9]*$/.test(value))
      return {
        error: `--limit takes a whole number of at least 1 (got '${value ?? ''}'). ${USAGE}`,
      };
    limit = Number(value);
  }
  return { apply, limit };
}
