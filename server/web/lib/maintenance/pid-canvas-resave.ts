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

export type ResaveCounts = Record<PidResaveOutcome, number> & { canvases: number };

/** Every `pid` canvas, page by page, through resavePidCanvas: the counts.
 *  `limit` stops after that many canvases (null: all). */
export async function resavePidCanvases(opts: {
  apply: boolean;
  limit?: number | null;
}): Promise<ResaveCounts & { cut: boolean }> {
  const counts: ResaveCounts = { canvases: 0, changed: 0, unchanged: 0, refused: 0, moved: 0 };
  const limit = opts.limit ?? null;
  let after: string | null = null;
  for (;;) {
    const page = await listPidCanvasPage(after, RESAVE_PAGE);
    for (const id of page.ids) {
      if (limit !== null && counts.canvases >= limit) return { ...counts, cut: true };
      counts.canvases += 1;
      counts[await resavePidCanvas(id, { apply: opts.apply })] += 1;
    }
    if (!page.next) return { ...counts, cut: false };
    after = page.next;
  }
}
