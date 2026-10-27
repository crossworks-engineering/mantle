/**
 * The parser service's wire contract, shared by the service (server/parser)
 * and its one client (./parser-client.ts): the routes, their time limits, the
 * error codes and the request framing. Kept free of imports so both sides
 * load it without pulling anything else in.
 *
 * Framing: every route is a POST whose body is the job's options as JSON
 * (`X-Parser-Opts-Length` bytes, possibly 0) followed by the file's raw
 * bytes, and whose answer is JSON, except the byte routes (audio, images
 * converted for vision, thumbnails), which answer the bytes with the
 * metadata in headers. Every non-2xx answer is the envelope
 * `{ ok: false, error: { code, message } }`. Bearer auth (`PARSER_TOKEN`) on
 * everything but GET /healthz.
 */

/** Every job the parser runs, by route. */
export const PARSER_ROUTES = {
  /** Document → plain text (packages/files/src/read-document.ts). */
  text: '/text',
  /** Document → its embedded pictures, gated and capped. */
  images: '/images',
  /** Workbook / MSPDI plan / DWF registry → grids. */
  grid: '/grid',
  /** PDF → PNG pages for OCR. */
  pdfRasterize: '/pdf/rasterize',
  /** PDF → page count. */
  pdfInfo: '/pdf/info',
  /** Password-protected PDF → text, with one candidate password. */
  pdfUnlock: '/pdf/unlock',
  /** DWG / DXF → registry, bones and a model-space PNG (Python CAD tier). */
  dwgRender: '/dwg/render',
  /** DWG / DXF → close-up crops for the image check (Python CAD tier). */
  dwgCrop: '/dwg/crop',
  /** Video or audio file → mp3 (ffmpeg). */
  extractAudio: '/extract-audio',
  /** Image → bounded JPEG thumbnail. */
  thumbnail: '/image/thumbnail',
  /** Image → bytes a vision model reads (HEIC/HEIF to JPEG). */
  visionImage: '/image/vision',
} as const;

export type ParserJob = keyof typeof PARSER_ROUTES;

/**
 * How long one job may run in the parser before it is killed (SIGKILL of
 * the job's process group), in ms. The client waits this long plus
 * {@link PARSER_QUEUE_WAIT_MS} plus {@link PARSER_BACKSTOP_MS}.
 */
export const PARSER_JOB_TIMEOUT_MS: Record<ParserJob, number> = {
  text: 120_000,
  images: 180_000,
  grid: 120_000,
  pdfRasterize: 180_000,
  pdfInfo: 60_000,
  pdfUnlock: 60_000,
  // The CAD tier: a real 500 KB drawing converts, parses and renders in
  // 3 to 17 s; 240 s covers files an order of magnitude bigger plus the
  // ezdwg fallback retry inside one child (the media sidecar's numbers).
  dwgRender: 240_000,
  dwgCrop: 240_000,
  extractAudio: 600_000,
  thumbnail: 30_000,
  visionImage: 60_000,
};

/** The longest a request waits in the parser for a free job slot before it
 *  is answered `busy`. */
export const PARSER_QUEUE_WAIT_MS = 30_000;

/** Slack on top of the job and queue limits for the transfer itself. */
export const PARSER_BACKSTOP_MS = 30_000;

/** The client's whole-exchange deadline for one job. */
export function parserClientTimeoutMs(job: ParserJob): number {
  return PARSER_JOB_TIMEOUT_MS[job] + PARSER_QUEUE_WAIT_MS + PARSER_BACKSTOP_MS;
}

/**
 * Every typed failure, from the parser or from the exchange with it.
 *
 *  - `too_large`   the document is past a cap (the body cap, a zip part's
 *                  inflate cap, a sheet's cell budget, anydoc's own limit).
 *  - `timeout`     the job ran past its time limit and was killed, or the
 *                  client's deadline passed.
 *  - `crashed`     the job's process died (the kernel's OOM kill inside the
 *                  container's memory limit, a native crash), or the
 *                  connection dropped mid-exchange (the whole parser
 *                  restarted).
 *  - `unsupported` no reader takes this format.
 *  - `busy`        every job slot stayed taken past the queue wait.
 *  - `failed`      the reader refused the document: corrupt, encrypted,
 *                  not the format its name says.
 *  - `unavailable` the parser could not be reached (restarting, not
 *                  running, a wrong token).
 *  - `bad_request` the request itself was malformed (a client bug).
 */
export type ParserErrorCode =
  | 'too_large'
  | 'timeout'
  | 'crashed'
  | 'unsupported'
  | 'busy'
  | 'failed'
  | 'unavailable'
  | 'bad_request';

export const PARSER_ERROR_CODES: readonly ParserErrorCode[] = [
  'too_large',
  'timeout',
  'crashed',
  'unsupported',
  'busy',
  'failed',
  'unavailable',
  'bad_request',
];

/** The codes that count against the same bytes: retryable the first time,
 *  terminal the second (./parser-client.ts). */
export const PARSER_COUNTED_CODES: ReadonlySet<ParserErrorCode> = new Set([
  'too_large',
  'timeout',
  'crashed',
]);

/** HTTP status the parser answers each code with. */
export const PARSER_ERROR_STATUS: Record<ParserErrorCode, number> = {
  too_large: 413,
  timeout: 504,
  crashed: 502,
  unsupported: 415,
  busy: 429,
  failed: 422,
  unavailable: 503,
  bad_request: 400,
};

/** Request header: the byte length of the JSON options ahead of the file. */
export const OPTS_LENGTH_HEADER = 'x-parser-opts-length';
/** The JSON options may be at most this long (a crop spec is the largest). */
export const MAX_OPTS_BYTES = 512 * 1024;
/** Response header on the byte routes: the job's JSON metadata,
 *  percent-encoded on one line. */
export const META_HEADER = 'x-parser-meta';

export const PARSER_DEFAULT_PORT = 8095;
