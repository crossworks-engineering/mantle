/**
 * The ONE client for the parser service (server/parser): the container that
 * reads every untrusted file the brain receives. Documents (text, pictures,
 * grids, PDF pages), CAD drawings (./parser-cad.ts builds on this module),
 * images for thumbnails and vision, and audio out of uploaded video all go
 * through here; nothing in api/web opens such a file itself.
 *
 * The parser runs with an OS memory limit, a job time limit and no network
 * route out. A document that blows up kills a job (or the whole parser,
 * which restarts), never a brain process. What the brain sees is a typed
 * error ({@link ParserError}, codes in ./parser-wire.ts):
 *
 *  - `busy` and `unavailable` are about the parser, not the document: always
 *    retryable, never counted against the bytes.
 *  - `too_large`, `timeout` and `crashed` count against the BYTES: the first
 *    for given bytes is retryable (a loaded box can be slow once; a restart
 *    can drop one connection), the second is terminal. A document already
 *    terminal here is refused at once, without asking the parser again, so
 *    one bomb costs the parser at most two jobs per brain process. The count
 *    lives in this process: a restart in between gives the bytes one more
 *    try, never a loop.
 *  - `failed`, `unsupported` and `bad_request` are verdicts on the request:
 *    neither retried nor terminal here; each caller decides (the extractor
 *    indexes the title, a chat turn says the file could not be read).
 *
 * A small concurrency cap per process (PARSER_CLIENT_CONCURRENCY, default 2)
 * keeps one busy brain process from filling the parser's queue alone. The
 * parser's own slots and queue are the real bound.
 *
 * Never sends a byte anywhere but PARSER_URL, the service on the stack's
 * internal network.
 */
import { createHash } from 'node:crypto';
import { env, envNum } from '@mantle/config';
import { errorMessage, timeoutSignal, withRetry } from '@mantle/std';
import {
  META_HEADER,
  OPTS_LENGTH_HEADER,
  PARSER_COUNTED_CODES,
  PARSER_DEFAULT_PORT,
  PARSER_ERROR_CODES,
  PARSER_ROUTES,
  parserClientTimeoutMs,
  type ParserErrorCode,
  type ParserJob,
} from './parser-wire';

export type { ParserErrorCode } from './parser-wire';

/** A password-protected PDF's read with one candidate password (the shape
 *  of packages/files/src/pdf-password.ts, the parser's reader). */
export type PdfPasswordResult =
  | { ok: true; text: string; numPages: number }
  | { ok: false; reason: 'password' | 'no_text' | 'error'; message?: string };

/** A typed failure of a parser exchange (see the module note). */
export class ParserError extends Error {
  readonly code: ParserErrorCode;
  /** Worth trying again later (the job, or the caller's retry). */
  readonly retryable: boolean;
  /** The second counted failure for the same bytes: stop trying. */
  readonly terminal: boolean;
  constructor(
    code: ParserErrorCode,
    message: string,
    opts: { retryable: boolean; terminal: boolean },
  ) {
    super(message);
    this.name = 'ParserError';
    this.code = code;
    this.retryable = opts.retryable;
    this.terminal = opts.terminal;
  }
}

/** True for a {@link ParserError}, also one loaded twice. */
export function isParserError(err: unknown): err is ParserError {
  return (
    err instanceof ParserError ||
    (err instanceof Error &&
      err.name === 'ParserError' &&
      typeof (err as { code?: unknown }).code === 'string')
  );
}

/** A result instead of a throw, for the callers that branch on the code
 *  (the CAD tier, video_ingest). */
export type ParserResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      code: ParserErrorCode;
      message: string;
      retryable: boolean;
      terminal: boolean;
    };

function config(): { url: string; token: string } {
  const url = env('PARSER_URL') || `http://127.0.0.1:${PARSER_DEFAULT_PORT}`;
  return { url: url.replace(/\/+$/, ''), token: env('PARSER_TOKEN') ?? '' };
}

// ── the bytes' failure count ────────────────────────────────────────────────

type Failure = { count: number; code: ParserErrorCode; message: string };
const FAILURES_MAX = 512;
const failures = new Map<string, Failure>();

function bytesKey(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Record a counted failure; true when it made the bytes terminal. */
function countFailure(key: string, code: ParserErrorCode, message: string): boolean {
  const prior = failures.get(key);
  const count = (prior?.count ?? 0) + 1;
  failures.delete(key);
  failures.set(key, { count, code, message });
  if (failures.size > FAILURES_MAX) {
    const oldest = failures.keys().next().value;
    if (oldest !== undefined) failures.delete(oldest);
  }
  return count >= 2;
}

/** Tests only: forget every count. */
export function resetParserFailures(): void {
  failures.clear();
}

// ── the per-process slots ───────────────────────────────────────────────────

let active = 0;
const waiting: Array<() => void> = [];

async function acquire(): Promise<void> {
  const max = Math.max(1, envNum('PARSER_CLIENT_CONCURRENCY'));
  if (active < max) {
    active++;
    return;
  }
  await new Promise<void>((resolve) => waiting.push(resolve));
  active++;
}

function release(): void {
  active--;
  waiting.shift()?.();
}

// ── one exchange ────────────────────────────────────────────────────────────

/** How the exchange failed below HTTP: a connection that never opened is
 *  `unavailable`, one that dropped mid-exchange is `crashed`, our deadline is
 *  `timeout`. */
function transportCode(err: unknown): ParserErrorCode {
  const name = (err as { name?: string } | null)?.name;
  if (name === 'TimeoutError' || name === 'AbortError') return 'timeout';
  const codes: string[] = [];
  for (let e: unknown = err, i = 0; e && i < 5; i++) {
    const c = (e as { code?: unknown }).code;
    if (typeof c === 'string') codes.push(c);
    e = (e as { cause?: unknown }).cause;
  }
  if (codes.some((c) => ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH'].includes(c))) {
    return 'unavailable';
  }
  return 'crashed';
}

/** The body: the options, then the file's bytes, streamed (no copy of a
 *  large file). A fresh stream per attempt. */
function bodyOf(head: Buffer, bytes: Buffer): ReadableStream<Uint8Array> {
  const parts = [head, bytes];
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = parts[i++];
      if (next) controller.enqueue(next);
      else controller.close();
    },
  });
}

async function readCapped(res: Response, maxBytes: number): Promise<Buffer> {
  const reader = res.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new ParserError('too_large', `the parser's answer was past ${maxBytes} bytes`, {
        retryable: false,
        terminal: false,
      });
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

type Answer = { body: Buffer; headers: Headers };

/** Busy answers are retried this many times, after these waits. */
const BUSY_WAITS_MS = [2_000, 5_000, 10_000];

/** One attempt's outcome: the answer, or the typed failure. */
type Attempt = { ok: true; answer: Answer } | { ok: false; code: ParserErrorCode; message: string };

/** One request: never throws, every failure typed. */
async function attempt(
  job: ParserJob,
  bytes: Buffer,
  head: Buffer,
  maxAnswerBytes: number,
): Promise<Attempt> {
  const cfg = config();
  try {
    const res = await fetch(`${cfg.url}${PARSER_ROUTES[job]}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        [OPTS_LENGTH_HEADER]: String(head.length),
        ...(cfg.token ? { authorization: `Bearer ${cfg.token}` } : {}),
      },
      body: bodyOf(head, bytes),
      duplex: 'half',
      signal: timeoutSignal(parserClientTimeoutMs(job)),
    } as RequestInit);
    if (res.ok) {
      return {
        ok: true,
        answer: { body: await readCapped(res, maxAnswerBytes), headers: res.headers },
      };
    }
    return { ok: false, ...(await envelopeOf(res)) };
  } catch (err) {
    if (isParserError(err)) return { ok: false, code: err.code, message: err.message };
    const code = transportCode(err);
    return {
      ok: false,
      code,
      message:
        code === 'unavailable'
          ? `the parser service could not be reached (${errorMessage(err)})`
          : code === 'timeout'
            ? `the parser did not answer within ${Math.round(parserClientTimeoutMs(job) / 1000)} s`
            : `the connection to the parser dropped mid-job (${errorMessage(err)}): the parser most likely ran out of memory and restarted`,
    };
  }
}

/**
 * One job: the request (retried while the parser answers `busy`), every
 * failure typed, the bytes' count kept. Throws a {@link ParserError}; never
 * anything else.
 */
async function exchange(
  job: ParserJob,
  bytes: Buffer,
  opts: Record<string, unknown>,
  maxAnswerBytes: number,
): Promise<Answer> {
  const key = bytesKey(bytes);
  const known = failures.get(key);
  if (known && known.count >= 2) {
    throw new ParserError(
      known.code,
      `${known.message} (this file failed the same way twice; it is not sent again)`,
      { retryable: false, terminal: true },
    );
  }
  const head = Buffer.from(JSON.stringify(opts), 'utf8');
  await acquire();
  let result: Attempt;
  try {
    result = await withRetry(() => attempt(job, bytes, head, maxAnswerBytes), {
      retries: BUSY_WAITS_MS.length,
      isFailure: (r) => !r.ok && r.code === 'busy',
      delayMs: (retry) => BUSY_WAITS_MS[retry - 1] ?? null,
    });
  } finally {
    release();
  }
  if (result.ok) return result.answer;
  const { code, message } = result;
  if (PARSER_COUNTED_CODES.has(code)) {
    const terminal = countFailure(key, code, message);
    throw new ParserError(code, message, { retryable: !terminal, terminal });
  }
  throw new ParserError(code, message, {
    retryable: code === 'busy' || code === 'unavailable',
    terminal: false,
  });
}

async function envelopeOf(res: Response): Promise<{ code: ParserErrorCode; message: string }> {
  let code: ParserErrorCode = res.status === 401 ? 'unavailable' : 'failed';
  let message = `the parser answered ${res.status}`;
  try {
    const body = (await res.json()) as { error?: { code?: string; message?: string } };
    const c = body?.error?.code;
    if (c && (PARSER_ERROR_CODES as readonly string[]).includes(c)) code = c as ParserErrorCode;
    if (body?.error?.message) message = body.error.message;
  } catch {
    /* keep the status-line fallback */
  }
  return { code, message };
}

function jsonOf(answer: Answer): Record<string, unknown> {
  try {
    return JSON.parse(answer.body.toString('utf8')) as Record<string, unknown>;
  } catch {
    throw new ParserError('failed', 'the parser answered something that is not JSON', {
      retryable: false,
      terminal: false,
    });
  }
}

function metaOf(answer: Answer): Record<string, unknown> {
  const raw = answer.headers.get(META_HEADER);
  if (!raw) return {};
  try {
    return JSON.parse(decodeURIComponent(raw)) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** The exchange as a {@link ParserResult}: for callers that branch. */
export async function asResult<T>(run: () => Promise<T>): Promise<ParserResult<T>> {
  try {
    return { ok: true, value: await run() };
  } catch (err) {
    const e = isParserError(err)
      ? err
      : new ParserError('failed', errorMessage(err), { retryable: false, terminal: false });
    return {
      ok: false,
      code: e.code,
      message: e.message,
      retryable: e.retryable,
      terminal: e.terminal,
    };
  }
}

/** For ./parser-cad.ts: one JSON job. */
export async function parserJson(
  job: ParserJob,
  bytes: Buffer,
  opts: Record<string, unknown>,
  maxAnswerBytes: number,
): Promise<Record<string, unknown>> {
  return jsonOf(await exchange(job, bytes, opts, maxAnswerBytes));
}

// ── documents ───────────────────────────────────────────────────────────────

/** A document's text never comes back longer than this (the extractor stores
 *  at most a few MB of any document). */
const TEXT_ANSWER_MAX = 96 * 1024 * 1024;

/** Document → plain text ('' when it holds none). Throws a ParserError. */
export async function parserText(bytes: Buffer, ext: string): Promise<string> {
  const body = jsonOf(await exchange('text', bytes, { ext }, TEXT_ANSWER_MAX));
  return typeof body.text === 'string' ? body.text : '';
}

/** Pictures: at most the per-document cap of images, each at most 32 MB
 *  raw, as base64. */
const IMAGES_ANSWER_MAX = 400 * 1024 * 1024;

/** A document's embedded pictures, gated and capped in the parser. */
export async function parserImages(
  bytes: Buffer,
  ext: string,
  opts: { maxImages: number; dpi?: number },
): Promise<import('./embedded-images').ExtractEmbeddedImagesResult> {
  const body = jsonOf(
    await exchange(
      'images',
      bytes,
      { ext, maxImages: opts.maxImages, ...(opts.dpi ? { dpi: opts.dpi } : {}) },
      IMAGES_ANSWER_MAX,
    ),
  );
  const { describeImageBytes } = await import('./embedded-images');
  const images: import('./embedded-images').EmbeddedImage[] = [];
  for (const raw of Array.isArray(body.images) ? body.images : []) {
    const o = raw as Record<string, unknown>;
    if (typeof o.bytes_base64 !== 'string') continue;
    const data = Buffer.from(o.bytes_base64, 'base64');
    if (data.length === 0) continue;
    const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
    const loc = (o.location ?? {}) as Record<string, unknown>;
    const location = {
      ...(typeof loc.page === 'number' ? { page: loc.page } : {}),
      ...(typeof loc.slide === 'number' ? { slide: loc.slide } : {}),
      ...(str(loc.sheet) ? { sheet: str(loc.sheet) } : {}),
    };
    images.push({
      // The digest and the sniff are taken here, from the bytes we hold.
      ...describeImageBytes(data, str(o.ext) ?? 'bin'),
      bytes: data,
      ordinal: images.length + 1,
      ...(Object.keys(location).length ? { location } : {}),
      ...(str(o.altText) ? { altText: str(o.altText) } : {}),
      ...(str(o.caption) ? { caption: str(o.caption) } : {}),
      ...(str(o.heading) ? { heading: str(o.heading) } : {}),
      ...(o.essential === true ? { essential: true } : {}),
      ...(o.provenance === 'sidecar_render' || o.provenance === 'embedded_thumbnail'
        ? { provenance: o.provenance }
        : {}),
    });
  }
  const rejected: Record<string, number> = {};
  if (body.rejected && typeof body.rejected === 'object') {
    for (const [k, v] of Object.entries(body.rejected as Record<string, unknown>)) {
      if (typeof v === 'number' && Number.isFinite(v)) rejected[k] = v;
    }
  }
  return {
    images,
    rejected,
    candidates: typeof body.candidates === 'number' ? body.candidates : images.length,
  };
}

const GRID_ANSWER_MAX = 256 * 1024 * 1024;

/** What a grid read gives: the sheets, and for an MSPDI plan its facts. */
export type ParserGrid = {
  sheets: import('./sheet-to-grid').ParsedSheet[];
  plan: { taskCount: number; summaryCount: number } | null;
};

/** Workbook (.xlsx/.xlsm/.xls/.xlsb), MSPDI plan (.xml) or DWF registry
 *  (.dwf) → grids. Throws a ParserError. */
export async function parserGrid(bytes: Buffer, ext: string): Promise<ParserGrid> {
  const body = jsonOf(await exchange('grid', bytes, { ext }, GRID_ANSWER_MAX));
  const sheets = Array.isArray(body.sheets)
    ? (body.sheets as import('./sheet-to-grid').ParsedSheet[])
    : [];
  const p = body.plan as Record<string, unknown> | null | undefined;
  return {
    sheets,
    plan:
      p && typeof p === 'object'
        ? {
            taskCount: typeof p.taskCount === 'number' ? p.taskCount : 0,
            summaryCount: typeof p.summaryCount === 'number' ? p.summaryCount : 0,
          }
        : null,
  };
}

// ── PDF ─────────────────────────────────────────────────────────────────────

const PDF_PAGES_ANSWER_MAX = 400 * 1024 * 1024;

/** PDF → PNG pages for OCR, at most `maxPages`. Throws a ParserError; a
 *  password-protected PDF is `failed` with "password" in the message. */
export async function parserRasterizePdf(
  bytes: Buffer,
  opts: { maxPages: number },
): Promise<Array<{ pageNumber: number; png: Buffer }>> {
  const body = jsonOf(
    await exchange('pdfRasterize', bytes, { maxPages: opts.maxPages }, PDF_PAGES_ANSWER_MAX),
  );
  const out: Array<{ pageNumber: number; png: Buffer }> = [];
  for (const raw of Array.isArray(body.pages) ? body.pages : []) {
    const o = raw as Record<string, unknown>;
    if (typeof o.pageNumber !== 'number' || typeof o.png_base64 !== 'string') continue;
    out.push({ pageNumber: o.pageNumber, png: Buffer.from(o.png_base64, 'base64') });
  }
  return out;
}

/** A PDF's page count, or null when it cannot be read. */
export async function parserPdfPageCount(bytes: Buffer): Promise<number | null> {
  const body = jsonOf(await exchange('pdfInfo', bytes, {}, 64 * 1024));
  return typeof body.pages === 'number' ? body.pages : null;
}

/** A password-protected PDF's text with one candidate password. The
 *  password travels in the request body to the parser on the internal
 *  network, never in a header or a log. */
export async function parserPdfUnlock(bytes: Buffer, password: string): Promise<PdfPasswordResult> {
  const body = jsonOf(await exchange('pdfUnlock', bytes, { password }, TEXT_ANSWER_MAX));
  if (body.ok === true && typeof body.text === 'string') {
    return {
      ok: true,
      text: body.text,
      numPages: typeof body.numPages === 'number' ? body.numPages : 0,
    };
  }
  const reason = body.reason === 'password' || body.reason === 'no_text' ? body.reason : 'error';
  return {
    ok: false,
    reason,
    ...(typeof body.message === 'string' ? { message: body.message } : {}),
  };
}

// ── images ──────────────────────────────────────────────────────────────────

/** Image → a JPEG of at most `maxDim` on the long edge, or null when the
 *  image cannot be decoded (the caller shows the type icon). */
export async function parserThumbnail(
  bytes: Buffer,
  mimeType: string,
  maxDim: number,
): Promise<Buffer | null> {
  try {
    const answer = await exchange('thumbnail', bytes, { mimeType, maxDim }, 16 * 1024 * 1024);
    return answer.body.length > 0 ? answer.body : null;
  } catch (err) {
    if (isParserError(err) && (err.code === 'failed' || err.code === 'unsupported')) return null;
    throw err;
  }
}

/** Image → bytes a vision model reads: HEIC/HEIF converted to JPEG, other
 *  formats passed back as they are (never sent). */
export async function parserImageForVision(
  bytes: Buffer,
  mimeType: string,
): Promise<{ bytes: Buffer; mimeType: string }> {
  const answer = await exchange('visionImage', bytes, { mimeType }, 128 * 1024 * 1024);
  const meta = metaOf(answer);
  return {
    bytes: answer.body,
    mimeType: typeof meta.mimeType === 'string' ? meta.mimeType : 'image/jpeg',
  };
}

// ── audio ───────────────────────────────────────────────────────────────────

/** Audio out of an uploaded video (or audio) file, as mp3, with its
 *  duration. Refused past `maxDurationSeconds` (`too_large`) before any
 *  transcode, and past `maxAudioBytes` after it. */
export async function parserExtractAudio(
  video: Buffer,
  opts: { maxDurationSeconds: number; maxAudioBytes: number },
): Promise<ParserResult<{ bytes: Buffer; durationSeconds: number | null }>> {
  return asResult(async () => {
    const answer = await exchange(
      'extractAudio',
      video,
      { maxDurationSeconds: opts.maxDurationSeconds, maxAudioBytes: opts.maxAudioBytes },
      opts.maxAudioBytes + 1024,
    );
    const meta = metaOf(answer);
    return {
      bytes: answer.body,
      durationSeconds:
        typeof meta.durationSeconds === 'number' && Number.isFinite(meta.durationSeconds)
          ? meta.durationSeconds
          : null,
    };
  });
}

// ── health ──────────────────────────────────────────────────────────────────

export type ParserHealth = {
  up: boolean;
  /** Reader and tool versions the parser reports (node, anydoc, python,
   *  ezdxf, ezdwf, dwg2dxf, ffmpeg); empty when down. */
  versions: Record<string, string>;
  /** Jobs running and waiting right now. */
  running: number | null;
  queued: number | null;
};

/** GET /healthz. Never throws. */
export async function parserHealth(timeoutMs: number): Promise<ParserHealth> {
  const down: ParserHealth = { up: false, versions: {}, running: null, queued: null };
  try {
    const res = await fetch(`${config().url}/healthz`, { signal: timeoutSignal(timeoutMs) });
    if (!res.ok) return down;
    const body = (await res.json()) as Record<string, unknown>;
    const versions: Record<string, string> = {};
    if (body.versions && typeof body.versions === 'object') {
      for (const [k, v] of Object.entries(body.versions as Record<string, unknown>)) {
        if (typeof v === 'string' && v) versions[k] = v;
      }
    }
    return {
      up: body.ok === true,
      versions,
      running: typeof body.running === 'number' ? body.running : null,
      queued: typeof body.queued === 'number' ? body.queued : null,
    };
  } catch {
    return down;
  }
}
