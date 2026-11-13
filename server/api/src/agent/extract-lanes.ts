/**
 * The extractor's two lanes, and the one ceiling over both.
 *
 * A drawing (DWG, DXF, DGN, DWF) is a heavy extraction: the parser reads it
 * for seconds to minutes on a whole core, and this process then builds its
 * tabs and its database. With every extraction in one queue, a batch of
 * drawings took every worker: two drawings at once kept two cores busy (one
 * in the parser, one here), the second one waited for the parser's single
 * job slot and failed `busy` into pg-boss retries, and a document uploaded
 * meanwhile waited behind all of them.
 *
 * So a heavy file runs in its own lane (extract-queue.ts): one at a time, on
 * its own queue, and the workers of the main queue stay free for light
 * files. Two rules, and no more:
 *
 *   1. weight: the file's extension says heavy or light
 *      (`extractWeightOfExt`, packages/files/src/slug.ts);
 *   2. ceiling: light and heavy together never pass the box's
 *      "extractions at once" setting. A box set to 1 runs one extraction at
 *      a time, whatever it is.
 */
import { extOf, extractWeightOfExt, type ExtractWeight } from '@mantle/files';

/** Heavy extractions at once. One, as the parser has one job slot: a second
 *  heavy file could only wait for that slot. */
export const HEAVY_LANE_WORKERS = 1;

/** What a hop to the heavy lane answers. pg-boss stores a handler's answer
 *  as the job's output, so the queue counts can leave a hop out of "done"
 *  (server/web/lib/extraction-queue.ts reads the same key). */
export const HEAVY_HOP_OUTPUT = { lane: 'heavy' } as const;

/** The weight of a node's extraction. Only a file has one: a note, a page or
 *  an email is light. The name is the one the extractor types the file by
 *  (extract/load-body.ts): `data.filename`, or the title for an email
 *  attachment. */
export function extractWeightOfNode(node: {
  type: string;
  title: string | null;
  filename: string | null;
}): ExtractWeight {
  if (node.type !== 'file') return 'light';
  return extractWeightOfExt(extOf(node.filename ?? node.title ?? ''));
}

/**
 * At most `limit` runs at once, first come first served. The limit is live:
 * a lower one lets the runs in flight finish, a higher one wakes the waiting.
 */
export class ExtractCeiling {
  private inFlight = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private limit: number) {}

  /** A new limit (at least 1). */
  setLimit(limit: number): void {
    this.limit = Math.max(1, Math.floor(limit));
    this.wake();
  }

  get running(): number {
    return this.inFlight;
  }

  get queued(): number {
    return this.waiting.length;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.inFlight >= this.limit || this.waiting.length > 0) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    } else {
      this.inFlight++;
    }
    try {
      return await fn();
    } finally {
      this.inFlight--;
      this.wake();
    }
  }

  /** Hand free places to the waiting, in order. The place is taken here, for
   *  the waiter, so a newcomer cannot slip in before it runs. */
  private wake(): void {
    while (this.inFlight < this.limit) {
      const next = this.waiting.shift();
      if (!next) return;
      this.inFlight++;
      next();
    }
  }
}
