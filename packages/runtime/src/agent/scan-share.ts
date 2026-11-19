/**
 * The Scan reader's reads of a file's pages, shared by every reader of the
 * same upload (owner decision 2026-11-19, "Share the reads"): the chat turn
 * that got the file (./attachments.ts), the background extract of a PDF
 * outside a book (server/api extract/images.ts) and a book's paid ask
 * (server/api extract/pipeline-ask.ts). Whichever reads a page first keeps
 * it; the others take it. One paid call a page, never two.
 *
 * Kept on the file's node, by the sha256 of its bytes and the page number:
 * `data.ocr.scan` (a byte-derived key: new bytes drop it, as does a read
 * again a person starts):
 *
 *   { sha256, total, pages: { "<n>": [method, why, text] },
 *     claims: { "<n>": [by, until] }, chat_until }
 *
 * A page is kept only when final (scanPageFinal: read, blank, read badly,
 * too large, a figure not described); one a later read may cure (no Scan
 * reader yet, no answer, not cut) is not, so it is read again. Before a paid
 * call a reader CLAIMS the page (a row lock on the node: one claim wins);
 * a page another reader holds a live claim on is waited for, never read
 * twice. A claim ends at its `until` (a reader that died), and a reader's
 * own claim of a try before is its own (`by`: `chat`, `extract`, `book`).
 * The chat turn says it is reading (`chat_until`), so a book's ask, which
 * writes nothing here otherwise (a book's rows are its record, and a page
 * write would rewrite the whole node), claims and keeps its pages only while
 * a chat turn may want them.
 *
 * Only for a node whose bytes are the reader's (`data.sha256` equal to the
 * sha256 of the bytes in hand, or the node's own for a book's ask): a cache
 * of other bytes is never read nor written. A chat turn with no saved file
 * has no background read to share with, and no node: it reads alone.
 *
 * System work (`ocr` is a key only the brain writes: packages/db
 * edit-check.ts), bound here: a chat turn runs as its login.
 */
import { and, eq, sql } from 'drizzle-orm';
import { db, nodes, runAsSystem } from '@mantle/db';
import { sleep as stdSleep } from '@mantle/std';
import { scanPageFinal, type ScanPage, type ScanPageMethod } from './scan-pdf';
import type { ScanUnreadReason } from '@mantle/files/read-cut';

/** Who reads. */
export type ScanReader = 'chat' | 'extract' | 'book';

/** A kept page: its method, why it is unread (or ''), its text. */
type Entry = [ScanPageMethod, string, string];

/** The shared reads as stored. */
export type ScanShareData = {
  sha256: string;
  total?: number;
  pages: Record<string, Entry>;
  claims: Record<string, [ScanReader, number]>;
  chat_until?: number;
};

const SYSTEM = 'scan:share';

/** The store's one binding: system work (see the module note). */
function asShare<T>(fn: () => Promise<T>): Promise<T> {
  return runAsSystem(SYSTEM, fn);
}

/** The node holds a whole read of its bytes by the core (its text, and the
 *  `ocr` mark of a finished scan read: true, or the pages read). Built at
 *  the call: a test that mocks @mantle/db loads this module too. */
const finalRead = () =>
  sql<boolean>`(${nodes.data}->>'text' is not null and (${nodes.data}->'ocr' = 'true'::jsonb or jsonb_typeof(${nodes.data}->'ocr'->'pages_read') = 'number'))`;

const pageOf = (n: number, [method, why, text]: Entry): ScanPage => ({
  page: n,
  method,
  text,
  ...(method === 'unread' && why ? { why: why as ScanUnreadReason } : {}),
});

/** The stored value, checked; null when it is not one or of other bytes. */
export function shareDataOf(raw: unknown, sha256: string): ScanShareData | null {
  const o = raw as Partial<ScanShareData> | null | undefined;
  if (!o || typeof o !== 'object' || o.sha256 !== sha256) return null;
  const pages: Record<string, Entry> = {};
  for (const [k, v] of Object.entries(o.pages ?? {})) {
    if (
      /^\d+$/.test(k) &&
      Array.isArray(v) &&
      typeof v[0] === 'string' &&
      typeof v[1] === 'string' &&
      typeof v[2] === 'string'
    ) {
      pages[k] = [v[0] as ScanPageMethod, v[1], v[2]];
    }
  }
  const claims: Record<string, [ScanReader, number]> = {};
  for (const [k, v] of Object.entries(o.claims ?? {})) {
    if (
      /^\d+$/.test(k) &&
      Array.isArray(v) &&
      typeof v[0] === 'string' &&
      typeof v[1] === 'number'
    ) {
      claims[k] = [v[0] as ScanReader, v[1]];
    }
  }
  return {
    sha256,
    ...(typeof o.total === 'number' ? { total: o.total } : {}),
    pages,
    claims,
    ...(typeof o.chat_until === 'number' ? { chat_until: o.chat_until } : {}),
  };
}

/** What a claim answers: the pages kept already, the pages now this
 *  reader's to read, and the pages another reader holds (until when). */
export type ScanClaim = {
  /** The bytes were read whole meanwhile: the node holds the final read
   *  (its text and `ocr` mark), and nothing is claimed. */
  final?: true;
  kept: Map<number, ScanPage>;
  mine: number[];
  theirs: Map<number, number>;
};

/** Pure: claim `pages` on `share` for `by` at `now` until `until`. */
export function claimOn(
  share: ScanShareData,
  pages: readonly number[],
  by: ScanReader,
  now: number,
  until: number,
): ScanClaim {
  const out: ScanClaim = { kept: new Map(), mine: [], theirs: new Map() };
  for (const n of pages) {
    const kept = share.pages[String(n)];
    if (kept) {
      out.kept.set(n, pageOf(n, kept));
      continue;
    }
    const c = share.claims[String(n)];
    if (c && c[0] !== by && c[1] > now) {
      out.theirs.set(n, c[1]);
      continue;
    }
    share.claims[String(n)] = [by, until];
    out.mine.push(n);
  }
  return out;
}

/** Pure: keep `pages` (the final ones) and end `by`'s claims on all of
 *  them. */
export function keepOn(
  share: ScanShareData,
  pages: readonly ScanPage[],
  by: ScanReader,
  final: (p: ScanPage) => boolean,
  total?: number,
): void {
  for (const p of pages) {
    const k = String(p.page);
    // No NUL: jsonb refuses it.
    if (final(p))
      share.pages[k] = [p.method, p.why ?? '', p.text.split(String.fromCharCode(0)).join('')];
    if (share.claims[k]?.[0] === by) delete share.claims[k];
  }
  if (total !== undefined) share.total = total;
}

/**
 * One change of a node's shared reads, under the node's row lock. `sha256`
 * null: the node's own bytes (a book's ask). Null (nothing done) when the
 * node is gone, has no bytes named, or holds other bytes.
 */
async function change<T>(
  nodeId: string,
  sha256: string | null,
  fn: (share: ScanShareData, now: number, final: boolean) => { value: T; write: boolean },
): Promise<T | null> {
  return asShare(() =>
    db.transaction(async (tx) => {
      const [row] = await tx
        .select({
          sha: sql<string | null>`${nodes.data}->>'sha256'`,
          scan: sql<unknown>`case when jsonb_typeof(${nodes.data}->'ocr') = 'object' then ${nodes.data}->'ocr'->'scan' end`,
          final: finalRead(),
        })
        .from(nodes)
        .where(eq(nodes.id, nodeId))
        .for('update');
      // A node with no sha256 named holds the bytes of the reader who
      // read them (an older upload); one of other bytes shares nothing.
      const sha = row?.sha ?? sha256;
      if (!row || !sha || (sha256 !== null && sha !== sha256)) return null;
      const share = shareDataOf(row.scan, sha) ?? { sha256: sha, pages: {}, claims: {} };
      const { value, write } = fn(share, Date.now(), row.final === true);
      if (write) {
        await tx.execute(sql`select set_config('mantle.keep_updated_at', 'on', true)`);
        await tx
          .update(nodes)
          .set({
            data: sql`jsonb_set(coalesce(${nodes.data}, '{}'::jsonb), '{ocr}', case when jsonb_typeof(${nodes.data}->'ocr') = 'object' then ${nodes.data}->'ocr' else '{}'::jsonb end || jsonb_build_object('scan', ${JSON.stringify(share)}::jsonb))`,
          })
          .where(
            and(eq(nodes.id, nodeId), sql`coalesce(${nodes.data}->>'sha256', ${sha}) = ${sha}`),
          );
      }
      return value;
    }),
  );
}

/** The shared reads of a node's bytes now (no lock), or null. */
export async function scanShareOf(
  nodeId: string,
  sha256: string | null,
): Promise<ScanShareData | null> {
  return asShare(async () => {
    const [row] = await db
      .select({
        sha: sql<string | null>`${nodes.data}->>'sha256'`,
        scan: sql<unknown>`case when jsonb_typeof(${nodes.data}->'ocr') = 'object' then ${nodes.data}->'ocr'->'scan' end`,
      })
      .from(nodes)
      .where(eq(nodes.id, nodeId))
      .limit(1);
    const sha = row?.sha ?? sha256;
    if (!row || !sha || (sha256 !== null && sha !== sha256)) return null;
    return shareDataOf(row.scan, sha);
  });
}

/** The pages already kept of a node's bytes, by page (none: empty). */
export async function scanKeptOf(
  nodeId: string,
  sha256: string | null,
): Promise<Map<number, ScanPage>> {
  const share = await scanShareOf(nodeId, sha256);
  const out = new Map<number, ScanPage>();
  for (const [k, e] of Object.entries(share?.pages ?? {})) out.set(Number(k), pageOf(Number(k), e));
  return out;
}

/** What a reader of one node's pages does with the shared reads: the hooks
 *  readScannedPdf takes (`share`), and the book's ask. */
export type ScanShareHooks = {
  claim(pages: readonly number[]): Promise<ScanClaim>;
  keep(pages: readonly ScanPage[], total?: number): Promise<void>;
  /** The pages of `pages` kept by `until` (ms), checked every `pollMs`; it
   *  returns early when a page's claim has ended unkept (its reader died):
   *  the caller claims it again. */
  wait(pages: readonly number[], until: number): Promise<Map<number, ScanPage>>;
};

/** How often a reader looks for pages another reader holds. */
export const SCAN_WAIT_POLL_MS = 1_500;

/**
 * The hooks of reader `by` on a node's bytes. `final`: which pages are kept
 * (scanPageFinal). `claimMs`: how long a claim holds. A node of other
 * bytes, or none, shares nothing: every page is the reader's, nothing kept.
 */
export function scanShareHooks(opts: {
  nodeId: string;
  sha256: string | null;
  by: ScanReader;
  final: (p: ScanPage) => boolean;
  claimMs: () => number;
  sleep?: (ms: number) => Promise<void>;
}): ScanShareHooks {
  const sleep = opts.sleep ?? stdSleep;
  return {
    claim: async (pages) =>
      (await change<ScanClaim>(opts.nodeId, opts.sha256, (share, now, final) => {
        if (final && opts.by === 'chat') {
          return {
            value: { final: true, kept: new Map(), mine: [], theirs: new Map() },
            write: false,
          };
        }
        const c = claimOn(share, pages, opts.by, now, now + opts.claimMs());
        return { value: c, write: c.mine.length > 0 };
      })) ?? { kept: new Map(), mine: [...pages], theirs: new Map() },
    keep: async (pages, total) => {
      if (pages.length === 0 && total === undefined) return;
      await change(opts.nodeId, opts.sha256, (share) => {
        keepOn(share, pages, opts.by, opts.final, total);
        return { value: null, write: true };
      });
    },
    wait: async (pages, until) => {
      const got = new Map<number, ScanPage>();
      for (;;) {
        const share = await scanShareOf(opts.nodeId, opts.sha256);
        const now = Date.now();
        let open = false;
        let ended = false;
        for (const n of pages) {
          const kept = share?.pages[String(n)];
          if (kept) got.set(n, pageOf(n, kept));
          else {
            open = true;
            const c = share?.claims[String(n)];
            if (!c || c[1] <= now) ended = true;
          }
        }
        if (!open || ended || now >= until) return got;
        await sleep(Math.min(SCAN_WAIT_POLL_MS, Math.max(0, until - now)));
      }
    },
  };
}

/** A chat turn says it reads a node's bytes until `until` (null: it ended),
 *  so a book's ask shares its pages meanwhile. */
export async function setChatReading(
  nodeId: string,
  sha256: string,
  until: number | null,
): Promise<void> {
  await change(nodeId, sha256, (share) => {
    if (until === null) delete share.chat_until;
    else share.chat_until = until;
    return { value: null, write: true };
  });
}

/** Whether a chat turn reads the node's bytes now (its `chat_until`). */
export function chatReadingNow(share: ScanShareData | null, now = Date.now()): boolean {
  return typeof share?.chat_until === 'number' && share.chat_until > now;
}

/** The node's whole read of these bytes by the core, when it has one: its
 *  text and its `ocr` mark. A chat turn takes it and reads nothing. */
export async function scanFinalReadOf(
  nodeId: string,
  sha256: string,
): Promise<{ text: string; ocr: unknown } | null> {
  return asShare(async () => {
    const [row] = await db
      .select({
        text: sql<string | null>`${nodes.data}->>'text'`,
        ocr: sql<unknown>`${nodes.data}->'ocr'`,
        final: finalRead(),
      })
      .from(nodes)
      .where(and(eq(nodes.id, nodeId), sql`${nodes.data}->>'sha256' = ${sha256}`))
      .limit(1);
    return row?.final === true && row.text ? { text: row.text, ocr: row.ocr } : null;
  });
}

/** What a book's ask of one page does about the shared reads. */
export type BookScanTurn =
  /** Another reader of the upload kept it: no call. */
  | { kept: ScanPage }
  /** A chat turn reads the file now: this page is claimed; the read is kept
   *  (`hooks.keep`) whatever its end, which also ends the claim. */
  | { hooks: ScanShareHooks }
  /** No chat turn reads it: the book's rows are its record, nothing shared. */
  | { alone: true };

/** How long a book's claim on one page holds (one call, one try more, and
 *  a figure's vision call). */
const BOOK_CLAIM_MS = 5 * 60_000;

/**
 * A book's ask of page `page` of node `nodeId` (its own bytes): take a page
 * a chat turn kept; while a chat turn reads the file, claim the page first,
 * and wait for one the turn holds (claimed again if its claim ends unkept,
 * at most three times). Never throws for the store: a store that fails is
 * `alone` (the ask reads as before).
 */
export async function bookScanTurn(
  nodeId: string,
  page: number,
  opts: { now?: () => number } = {},
): Promise<BookScanTurn> {
  try {
    const share = await scanShareOf(nodeId, null);
    const kept = share?.pages[String(page)];
    if (kept) return { kept: pageOf(page, kept) };
    if (!chatReadingNow(share, opts.now?.() ?? Date.now())) return { alone: true };
    const hooks = scanShareHooks({
      nodeId,
      sha256: share!.sha256,
      by: 'book',
      final: scanPageFinal,
      claimMs: () => BOOK_CLAIM_MS,
    });
    for (let round = 0; round < 3; round += 1) {
      const c = await hooks.claim([page]);
      const got = c.kept.get(page);
      if (got) return { kept: got };
      if (c.mine.includes(page)) return { hooks };
      const until = c.theirs.get(page) ?? 0;
      const waited = (await hooks.wait([page], until)).get(page);
      if (waited) return { kept: waited };
    }
    return { alone: true };
  } catch {
    return { alone: true };
  }
}
