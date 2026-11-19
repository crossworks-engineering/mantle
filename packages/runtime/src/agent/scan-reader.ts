/**
 * The Scan reader (docs/ai-workers.md, "The Scan reader"): one scanned page,
 * as a one-page PDF, in; its text, the figures the engine found on it and a
 * quality answer out, from the brain's `scan_reader` worker. Every scanned
 * page of a PDF book is read by it (owner decision 2026-11-19: no local OCR
 * first, no vision backup): a read the check judges bad leaves the page
 * unread.
 *
 * The engine is fixed: OpenRouter's PDF parser `mistral-ocr`
 * (SCAN_READER_ENGINE), whatever the worker says. The page goes through it
 * and the text is the parser's own (the file annotation), cleaned of its
 * wrapper, markdown table dividers and picture links (cleanParsedText). The
 * worker's model is only the cheap text model the parsed text is handed to
 * (16 tokens out, not used). The billed cost holds the parser's fee.
 *
 * One paid call a page (two only with `tries: 2`, when the provider failed
 * with no answer: a timeout, a dropped line, a 5xx; never on a refusal, and
 * never because the answer read badly). Whether it read badly comes from
 * the answer and the page's line count from its picture (scanReadQualityOf),
 * never from a second call. With no Scan reader worker on the brain nothing
 * is called (`ran: false`, `attempted: false`, `model: null`).
 *
 * The spend: the vision adapter records the call on the trace step in
 * context (docs/spend-recording.md), with the billed cost; the caller wraps
 * the call in its step.
 */
import { resolveDefaultWorker } from '@mantle/api-keys';
import { bumpWorkerUsage } from '@mantle/db';
import { getVisionAdapter } from '@mantle/voice';
import {
  providerErrorStatus,
  providerWaitOf,
  publicProviderErrorMessage,
  type ProviderWait,
} from '@mantle/std';
import { scanReadQualityOf, type OcrWord, type ScanReadQuality } from './scan-reader-quality';

/** The Scan reader's engine: OpenRouter's PDF parser `mistral-ocr`, $2 per
 *  1,000 pages ($2.20 in the US region). Fixed (owner decision 2026-11-19). */
export const SCAN_READER_ENGINE = 'mistral-ocr';

/** The answer cap of the text model behind the engine: its answer is not
 *  used, the parser's text is. */
export const SCAN_READER_ENGINE_MAX_TOKENS = 16;

export type ScanReaderResult = {
  /** True when the provider answered (its text may still read badly). */
  ran: boolean;
  /** True when a call went out (it may have failed: the provider may still
   *  bill it). False when nothing was called. */
  attempted: boolean;
  text: string;
  /** The figures the engine found on the page (its picture links). */
  pictures: number;
  /** Why there is no text, or why the call did not run. */
  note: string | null;
  /** The worker's model; null when the brain has no Scan reader worker. */
  model: string | null;
  /** The engine of the read (SCAN_READER_ENGINE). */
  engine: string;
  adapterName?: string;
  tokensIn?: number;
  tokensOut?: number;
  /** The billed cost in USD, when the provider gave it. */
  costUsd?: number;
  /** The read's quality: `ok: false` leaves the page unread. */
  quality: ScanReadQuality;
  /** The provider said "not now" (a rate limit, no credit, busy:
   *  @mantle/std provider-wait.ts): the page waits for a run again, it is
   *  not a bad read. Only with `ran: false`. */
  wait?: ProviderWait;
};

const notRun = (note: string, model: string | null, attempted = false): ScanReaderResult => ({
  ran: false,
  attempted,
  text: '',
  pictures: 0,
  note,
  model,
  engine: SCAN_READER_ENGINE,
  quality: scanReadQualityOf(''),
});

/** A line that is only a markdown table divider: `| --- | :---: |`. */
const DIVIDER = /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?$/;
/** The parser's wrapper around a file's text: `<file name="page.pdf">`. */
const WRAPPER = /^<\/?file(\s[^>]*)?>$/i;
/** A markdown picture link: `![img-0.jpeg](img-0.jpeg)`. */
const PICTURE_LINK = /!\[[^\]]*\]\([^)]*\)/g;

/** The picture links in a PDF parser's markdown: the figures it found. */
export function parsedPictureCount(text: string): number {
  return text.match(PICTURE_LINK)?.length ?? 0;
}

/**
 * A PDF parser's markdown as the Scan reader's plain text: the `<file>`
 * wrapper, markdown table dividers and picture links out; a table row as
 * its cells split by ` | ` with no outer bars; heading marks and paired bold
 * marks (`#`, `**A**`, `__A__`) off; runs of blank lines as one. Every word
 * of the page is kept.
 */
export function cleanParsedText(text: string): string {
  const out: string[] = [];
  for (const raw of text.split('\n')) {
    let line = raw.replace(PICTURE_LINK, '').trim();
    // A line that was only a picture link is no line of the page.
    if (line === '' && raw.trim() !== '') continue;
    if (WRAPPER.test(line) || DIVIDER.test(line)) continue;
    if (line.startsWith('|') && line.endsWith('|') && line.length > 1) {
      line = line
        .slice(1, -1)
        .split('|')
        .map((c) => c.trim())
        .join(' | ');
    }
    line = line
      .replace(/^#{1,6}\s+/, '')
      // Only paired marks around words: a footnote's `150**` or a form's
      // `______` is printed text and stays.
      .replace(/\*\*([^\s*](?:[^*]*?[^\s*])?)\*\*/g, '$1')
      .replace(/(^|\s)__([^\s_](?:[^_]*?[^\s_])?)__(?=\s|$)/g, '$1$2');
    if (line === '' && (out.length === 0 || out[out.length - 1] === '')) continue;
    out.push(line);
  }
  while (out.length > 0 && out[out.length - 1] === '') out.pop();
  return out.join('\n');
}

/**
 * Read one scanned page (a one-page PDF) with the brain's Scan reader
 * worker, through the engine. `expectedLines`: the page's text lines by its
 * picture (the book reader's `Lines`), for the check. Never throws for a
 * provider failure.
 */
export async function runScanReader(opts: {
  ownerId: string;
  pdf: Buffer;
  expectedLines?: number;
  /** Tesseract's words of the page, for a caller that has them (the book
   *  path has none): the agreement check. */
  ocrWords?: readonly OcrWord[];
  tries?: 1 | 2;
}): Promise<ScanReaderResult> {
  if (!opts.pdf?.length) return notRun('No page to read.', null);
  const route = await resolveDefaultWorker(
    opts.ownerId,
    'scan_reader',
    (w) => typeof getVisionAdapter(w.provider)?.parsePdf === 'function',
  );
  if (!route.ok) {
    if (route.why === 'none') return notRun('No Scan reader worker.', null);
    if (route.why === 'no_key') {
      return notRun(`Scan reader worker '${route.worker.slug}' has no key.`, null);
    }
    return notRun(
      route.why === 'unusable'
        ? `Scan reader provider '${route.worker.provider}' has no PDF parser engine.`
        : `Scan reader worker '${route.worker.slug}' api_key could not be decrypted.`,
      route.worker.model,
    );
  }
  const { worker, credential } = route;
  const adapter = getVisionAdapter(worker.provider)!;
  const parsePdf = adapter.parsePdf!.bind(adapter);
  const call = () =>
    parsePdf(opts.pdf, {
      ...credential,
      engine: SCAN_READER_ENGINE,
      model: worker.model,
      maxTokens: SCAN_READER_ENGINE_MAX_TOKENS,
    });
  try {
    // One time more only where a second call can help (no answer, the
    // provider's own fault); a refusal (4xx) is not asked again.
    const again = (err: unknown) => {
      const status = providerErrorStatus(err);
      if (status !== undefined && status < 500) throw err;
      return call();
    };
    const r = await (opts.tries === 2 ? call().catch(again) : call());
    void bumpWorkerUsage(worker.id);
    const raw = r.text ?? '';
    const text = cleanParsedText(raw);
    return {
      ran: true,
      attempted: true,
      text,
      pictures: parsedPictureCount(raw),
      note: text ? null : 'Scan reader returned no text.',
      model: worker.model,
      engine: SCAN_READER_ENGINE,
      adapterName: adapter.adapterName,
      tokensIn: r.tokensIn,
      tokensOut: r.tokensOut,
      ...(r.reportedCostUsd !== undefined ? { costUsd: r.reportedCostUsd } : {}),
      // The text model's 16-token cut says nothing of the page: no `cut`.
      quality: scanReadQualityOf(text, {
        ocrWords: opts.ocrWords ?? [],
        expectedLines: opts.expectedLines ?? null,
      }),
    };
  } catch (err) {
    const wait = providerWaitOf(err);
    return {
      ...notRun(
        `Scan reader failed: ${publicProviderErrorMessage(err, 'scan-reader')}`,
        worker.model,
        true,
      ),
      ...(wait ? { wait } : {}),
    };
  }
}
