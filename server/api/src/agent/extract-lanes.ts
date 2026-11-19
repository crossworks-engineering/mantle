/**
 * The extractor's three lanes, and the ceiling over two of them.
 *
 * A drawing (DWG, DXF, DGN, DWF) is a heavy extraction: the parser reads it
 * for seconds to minutes on a whole core, and this process then builds its
 * tabs and its database. With every extraction in one queue, a batch of
 * drawings took every worker: two drawings at once kept two cores busy (one
 * in the parser, one here), the second one waited for the parser's single
 * job slot and failed `busy` into pg-boss retries, and a document uploaded
 * meanwhile waited behind all of them.
 *
 * A book is longer still: a PDF of BOOK_HEAVY_MIN_BYTES (10 MB) or more, or
 * of more than BOOK_HEAVY_MIN_PAGES (200) pages (its page count, qpdf's, is
 * read at the hop), is read by OCR window by window, with an extract time
 * that grows with its page windows (bookExpireMinutes), up to 8 hours. In
 * the heavy lane it held the one heavy place for all that time, and every
 * drawing waited behind it.
 *
 * So each runs in a lane of its own (extract-queue.ts):
 *
 *   light  the main queue, `mantle.extract`: every file but these two, a
 *          smaller PDF included, so many small PDFs never queue behind a
 *          book. "Extractions at once" workers.
 *   heavy  `mantle.extract.heavy`: a drawing, HEAVY_LANE_WORKERS (1) at a
 *          time. A book is never here, so it never holds a drawing back.
 *   book   `mantle.extract.book`: a book, and the run of a Reader or an
 *          Agent on one, bookLaneWorkers() at a time (the saved "books at
 *          once", else EXTRACT_BOOK_CONCURRENCY, default 1; read live).
 *
 * Three rules, and no more:
 *
 *   1. lane: the file says it (extractLaneOfNode): its extension, and for a
 *      PDF its bytes and pages (`extractWeightOfFile`,
 *      packages/files/src/slug.ts);
 *   2. ceiling: light and heavy together never pass the box's "extractions
 *      at once" setting. A box set to 1 runs one of those at a time,
 *      whatever it is;
 *   3. a book's place is its lane's own (its own ceiling of
 *      bookLaneWorkers()), outside the one above: a book takes hours, and
 *      inside the shared ceiling it would hold a place light and heavy work
 *      need for all of them (on a box set to 1, every place). So at most
 *      "extractions at once" + "books at once" run in all.
 *
 * What the lanes do not do: the parser still has one job slot for the whole
 * box. A document's read waits there for the one job being read (a
 * drawing's read, or one page window of a book, never a whole book), as it
 * waits for any other read: a chat attachment, a thumbnail, a drawing tool,
 * a maintenance run.
 */
import { resolveBookConcurrency } from '@mantle/embeddings/extraction-concurrency';
import {
  PIPELINE_WINDOW_DEFAULT,
  extOf,
  extractWeightOfFile,
  type ExtractWeight,
} from '@mantle/files';

/** Heavy extractions at once. One, as the parser has one job slot: a second
 *  heavy file could only wait for that slot. */
export const HEAVY_LANE_WORKERS = 1;

/** Books at once, in the book lane: the saved setting
 *  (embedding_config.extraction_book_concurrency, 0391), then
 *  EXTRACT_BOOK_CONCURRENCY, then 1; 1 to 4. Each book is a long run of
 *  parser jobs, one page window at a time, so a second book only shares the
 *  parser's one job slot with the first; a box with more parser room may
 *  raise it. The queue reads the saved value live (its 30 s reconcile). */
export function bookLaneWorkers(saved?: number | null): number {
  return resolveBookConcurrency(saved);
}

/** The lane of an extraction (see the header). */
export type ExtractLane = 'light' | 'heavy' | 'book';

/** What a hop to the heavy or the book lane answers. pg-boss stores a
 *  handler's answer as the job's output, so the queue counts can leave a hop
 *  out of "done" (packages/db/src/provider-alerts.ts reads the same key). */
export const HEAVY_HOP_OUTPUT = { lane: 'heavy' } as const;
export const BOOK_HOP_OUTPUT = { lane: 'book' } as const;

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

/** The lane of a node's extraction: a heavy PDF is a book, any other heavy
 *  file (a drawing) heavy, the rest light. */
export function extractLaneOfNode(node: Parameters<typeof extractWeightOfNode>[0]): ExtractLane {
  if (extractWeightOfNode(node) !== 'heavy') return 'light';
  const name = (node.filename ?? node.title ?? '').toLowerCase();
  return extOf(name) === 'pdf' ? 'book' : 'heavy';
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
 *  unread: said in the job's failure, never silent. A run tried again does
 *  not start over: each page window the Reader read is kept as it ends
 *  (packages/content/src/window-stage.ts), and the next try reads on from
 *  the first window not kept. */
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
