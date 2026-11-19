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
 *
 * What the lane does not do: the parser still has one job slot for the whole
 * box. A document's read waits there for the one drawing that is being read
 * (not for the drawings queued behind it), as it waits for any other read: a
 * chat attachment, a thumbnail, a drawing tool, a maintenance run. A PDF of
 * BOOK_HEAVY_MIN_BYTES (10 MB) or more is heavy (a book read by OCR window
 * by window), and so is a PDF of more than BOOK_HEAVY_MIN_PAGES (200) pages
 * (a long typed book: its page count, qpdf's, is read at the hop), with an
 * extract time that grows with its page windows (bookExpireMinutes); a
 * smaller PDF is light, so many small PDFs never queue behind a book.
 */
import {
  PIPELINE_WINDOW_DEFAULT,
  extOf,
  extractWeightOfFile,
  type ExtractWeight,
} from '@mantle/files';

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
  /** `data.size_bytes`: a PDF of BOOK_HEAVY_MIN_BYTES or more is heavy. */
  sizeBytes?: number | null;
  /** The PDF's page count (qpdf): one of more than BOOK_HEAVY_MIN_PAGES
   *  pages is heavy. */
  pages?: number | null;
}): ExtractWeight {
  if (node.type !== 'file') return 'light';
  return extractWeightOfFile(
    extOf(node.filename ?? node.title ?? ''),
    node.sizeBytes ?? null,
    node.pages ?? null,
  );
}

/** The minutes a book's extract gets for each page window of
 *  PIPELINE_WINDOW_DEFAULT (50 pages) over the base time budget: about 2.5
 *  minutes of OCR on 2 CPUs a window (1.8 s a page a CPU), the picture pass
 *  besides, doubled. */
export const BOOK_EXPIRE_MIN_PER_WINDOW = 5;
/** The longest a book's extract may run, in minutes: 8 hours, about 4,500
 *  pages of OCR on 2 CPUs. A book past it expires and is tried again as
 *  every extract is (the Reader's database is written when its last window
 *  is read), so it is the one bound of this path that can leave a book
 *  unread: said in the job's failure, never silent. */
export const BOOK_EXPIRE_MAX_MIN = 480;

/**
 * The time budget of a heavy PDF's extract (decision 3 of the large-PDF
 * finish, Jason: "Scale the limit by pages"): the base budget
 * (MANTLE_EXTRACT_EXPIRE_MIN, or the box's setting) for a small file, plus
 * BOOK_EXPIRE_MIN_PER_WINDOW for each page window, at most
 * BOOK_EXPIRE_MAX_MIN. A 1,000-page book: 60 + 20 x 5 = 160 minutes. An
 * unknown page count: the most. Never under the base.
 */
export function bookExpireMinutes(baseMin: number, pages: number | null): number {
  if (pages === null) return Math.max(baseMin, BOOK_EXPIRE_MAX_MIN);
  const windows = Math.ceil(Math.max(0, pages) / PIPELINE_WINDOW_DEFAULT.pages);
  const scaled = baseMin + windows * BOOK_EXPIRE_MIN_PER_WINDOW;
  return Math.max(baseMin, Math.min(BOOK_EXPIRE_MAX_MIN, scaled));
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
