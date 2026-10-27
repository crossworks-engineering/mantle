/**
 * The parser service: the one container that reads every untrusted file the
 * brain receives (docs/parser.md). Documents (pdfjs, mammoth, exceljs,
 * anydoc, our own OOXML, Visio and markup readers), CAD drawings (a Python
 * child: dwg2dxf, ezdwg, ezdxf, ezdwf), images (canvas, heic-convert) and
 * audio out of uploaded video (ffmpeg). The brain talks to it through one
 * client (packages/files/src/parser-client.ts).
 *
 * The safety guarantee is the container: an OS memory limit (`mem_limit`),
 * a CPU share, and a network with no route out (compose network `parser`,
 * `internal: true`). Inside it, cheap bounds only:
 *
 *  - a request-body cap (PARSER_MAX_UPLOAD_MB), enforced while the body
 *    streams to disk, never after it sat in memory;
 *  - PARSER_MAX_JOBS jobs at a time (default 2), up to PARSER_QUEUE_MAX
 *    waiting at most PARSER_QUEUE_WAIT_MS each, then `busy`;
 *  - each job in its own process (./job.ts) and process group, killed at
 *    the job's deadline (PARSER_JOB_TIMEOUT_MS); the kernel's OOM kill
 *    lands on the job process, and the server answers `crashed`;
 *  - the readers' own caps (zip parts, sheet cells, image pixels).
 *
 * If the server itself dies, compose restarts it (`restart: unless-stopped`)
 * and the brain reads the dropped connection as `crashed`.
 *
 * This process never parses a document. It holds no secret but its bearer
 * token, mounts no data, and reads nothing but the bodies it is sent.
 */
import { timingSafeEqual } from 'node:crypto';
import { createReadStream, createWriteStream, promises as fs } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootSmokeExit, env, envNum, isBootSmoke } from '@mantle/config';
import {
  MAX_OPTS_BYTES,
  META_HEADER,
  OPTS_LENGTH_HEADER,
  PARSER_DEFAULT_PORT,
  PARSER_ERROR_STATUS,
  PARSER_JOB_TIMEOUT_MS,
  PARSER_QUEUE_WAIT_MS,
  PARSER_ROUTES,
  type ParserErrorCode,
  type ParserJob,
} from '@mantle/files/parser-wire';
import { runGroup } from './proc';
import { probeVersions } from './versions';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const JOB_ENTRY = path.join(HERE, 'job.ts');

const JOB_BY_PATH = new Map<string, ParserJob>(
  (Object.entries(PARSER_ROUTES) as Array<[ParserJob, string]>).map(([job, route]) => [route, job]),
);

class Refusal extends Error {
  constructor(
    readonly code: ParserErrorCode,
    message: string,
  ) {
    super(message);
  }
}

// ── config ──────────────────────────────────────────────────────────────────

const PORT = envNum('PARSER_PORT') || PARSER_DEFAULT_PORT;
const TOKEN = env('PARSER_TOKEN') ?? '';
const MAX_JOBS = Math.max(1, envNum('PARSER_MAX_JOBS'));
const QUEUE_MAX = Math.max(0, envNum('PARSER_QUEUE_MAX'));
const MAX_BODY_BYTES = Math.max(1, envNum('PARSER_MAX_UPLOAD_MB')) * 1024 * 1024;
const WORKDIR = env('PARSER_WORKDIR') ?? path.join(os.tmpdir(), 'mantle-parser');

// ── slots ───────────────────────────────────────────────────────────────────

let running = 0;
const queue: Array<{ resolve: () => void; timer: NodeJS.Timeout }> = [];

/** A job slot, or a `busy` refusal: the queue is full, or the wait passed. */
function acquireSlot(): Promise<void> {
  if (running < MAX_JOBS) {
    running++;
    return Promise.resolve();
  }
  if (queue.length >= QUEUE_MAX) {
    return Promise.reject(
      new Refusal('busy', `every job slot is taken and ${QUEUE_MAX} wait already`),
    );
  }
  return new Promise((resolve, reject) => {
    const entry = {
      resolve: () => {
        clearTimeout(entry.timer);
        running++;
        resolve();
      },
      timer: setTimeout(() => {
        const i = queue.indexOf(entry);
        if (i >= 0) queue.splice(i, 1);
        reject(
          new Refusal('busy', `no job slot came free within ${PARSER_QUEUE_WAIT_MS / 1000} s`),
        );
      }, PARSER_QUEUE_WAIT_MS),
    };
    queue.push(entry);
  });
}

function releaseSlot(): void {
  running--;
  queue.shift()?.resolve();
}

// ── one request ─────────────────────────────────────────────────────────────

function authorized(req: http.IncomingMessage): boolean {
  if (!TOKEN) return true;
  const got = Buffer.from(req.headers.authorization ?? '');
  const want = Buffer.from(`Bearer ${TOKEN}`);
  return got.length === want.length && timingSafeEqual(got, want);
}

function sendJson(res: http.ServerResponse, status: number, body: unknown, close = false): void {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': String(data.length),
    ...(close ? { connection: 'close' } : {}),
  });
  res.end(data);
}

function sendFailure(res: http.ServerResponse, code: ParserErrorCode, message: string): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  // Close: the request body may be unread, and on keep-alive it would be
  // read as the next request.
  sendJson(res, PARSER_ERROR_STATUS[code], { ok: false, error: { code, message } }, true);
}

/** Stream the body to the job's directory: the options, then the file,
 *  under the byte cap. */
async function spoolBody(req: http.IncomingMessage, dir: string): Promise<number> {
  const optsLen = Number(req.headers[OPTS_LENGTH_HEADER] ?? 0);
  if (!Number.isInteger(optsLen) || optsLen < 0 || optsLen > MAX_OPTS_BYTES) {
    throw new Refusal('bad_request', `${OPTS_LENGTH_HEADER} must be 0 to ${MAX_OPTS_BYTES}`);
  }
  const declared = Number(req.headers['content-length'] ?? NaN);
  if (Number.isFinite(declared) && declared - optsLen > MAX_BODY_BYTES) {
    throw new Refusal(
      'too_large',
      `the file is past the ${MAX_BODY_BYTES / 1024 / 1024} MB the parser takes`,
    );
  }
  const head: Buffer[] = [];
  let headLen = 0;
  let size = 0;
  const file = createWriteStream(path.join(dir, 'in.bin'));
  try {
    for await (const chunk of req as AsyncIterable<Buffer>) {
      let rest = chunk;
      if (headLen < optsLen) {
        const take = Math.min(optsLen - headLen, rest.length);
        head.push(rest.subarray(0, take));
        headLen += take;
        rest = rest.subarray(take);
      }
      if (rest.length === 0) continue;
      size += rest.length;
      if (size > MAX_BODY_BYTES) {
        throw new Refusal(
          'too_large',
          `the file is past the ${MAX_BODY_BYTES / 1024 / 1024} MB the parser takes`,
        );
      }
      if (!file.write(rest)) await new Promise((r) => file.once('drain', r));
    }
  } finally {
    await new Promise<void>((resolve) => file.end(() => resolve()));
  }
  if (headLen < optsLen) throw new Refusal('bad_request', 'the body ended inside the options');
  const opts = Buffer.concat(head).toString('utf8');
  try {
    if (opts) JSON.parse(opts);
  } catch {
    throw new Refusal('bad_request', 'the options are not JSON');
  }
  await fs.writeFile(path.join(dir, 'opts.json'), opts || '{}');
  return size;
}

type Outcome = 'ok' | ParserErrorCode;

/** Run the job process and read how it ended. */
async function runJobProcess(job: ParserJob, dir: string, abort: AbortSignal): Promise<Outcome> {
  const timeoutMs = PARSER_JOB_TIMEOUT_MS[job];
  const ended = await runGroup(process.execPath, [...process.execArgv, JOB_ENTRY, job, dir], {
    timeoutMs,
    abort,
  });
  if (ended.code === 0) return 'ok';
  if (ended.timedOut) {
    await fs.writeFile(
      path.join(dir, 'error.json'),
      JSON.stringify({
        code: 'timeout',
        message: `the job ran past its ${timeoutMs / 1000} s limit and was killed`,
      }),
    );
    return 'timeout';
  }
  if (ended.code === 3) {
    try {
      const e = JSON.parse(await fs.readFile(path.join(dir, 'error.json'), 'utf8')) as {
        code?: ParserErrorCode;
      };
      if (e.code && e.code in PARSER_ERROR_STATUS) return e.code;
    } catch {
      /* fall through to crashed */
    }
  }
  const why = ended.signal
    ? `the job process was killed (${ended.signal}): the document needed more memory than the parser may use`
    : `the job process ended with code ${ended.code}${ended.spawnError ? ` (${ended.spawnError})` : ''}`;
  if (ended.stderr.trim())
    process.stderr.write(`[parser] ${job}: ${ended.stderr.trim().slice(-800)}\n`);
  await fs.writeFile(
    path.join(dir, 'error.json'),
    JSON.stringify({ code: 'crashed', message: why }),
  );
  return 'crashed';
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = (req.url ?? '/').split('?')[0]!;
  if (req.method === 'GET' && url === '/healthz') {
    sendJson(res, 200, {
      ok: true,
      versions: await probeVersions(),
      running,
      queued: queue.length,
      maxJobs: MAX_JOBS,
    });
    return;
  }
  const job = req.method === 'POST' ? JOB_BY_PATH.get(url) : undefined;
  if (!job) {
    sendFailure(res, 'bad_request', `no route ${req.method} ${url}`);
    return;
  }
  if (!authorized(req)) {
    // `unavailable` to the brain: a wrong token is configuration, not the file.
    res.writeHead(401, { 'content-type': 'application/json', connection: 'close' });
    res.end(
      JSON.stringify({
        ok: false,
        error: { code: 'unavailable', message: 'missing or wrong bearer token' },
      }),
    );
    return;
  }
  const started = Date.now();
  const dir = await fs.mkdtemp(path.join(WORKDIR, `${job}-`));
  const abort = new AbortController();
  res.on('close', () => {
    if (!res.writableFinished) abort.abort();
  });
  let slot = false;
  let outcome: Outcome = 'failed';
  let size = 0;
  try {
    size = await spoolBody(req, dir);
    await acquireSlot();
    slot = true;
    outcome = await runJobProcess(job, dir, abort.signal);
    if (outcome !== 'ok') {
      const e = JSON.parse(await fs.readFile(path.join(dir, 'error.json'), 'utf8')) as {
        message?: string;
      };
      sendFailure(res, outcome, e.message ?? outcome);
      return;
    }
    await sendAnswer(job, dir, res);
  } catch (err) {
    if (err instanceof Refusal) {
      outcome = err.code;
      sendFailure(res, err.code, err.message);
    } else {
      outcome = 'failed';
      sendFailure(res, 'failed', err instanceof Error ? err.message : String(err));
    }
  } finally {
    if (slot) releaseSlot();
    // Log the job, never its content.
    process.stdout.write(
      `[parser] ${job} ${outcome} ${size} B ${Date.now() - started} ms (running ${running}, queued ${queue.length})\n`,
    );
    // The answer is sent (or the client is gone): the job's files go.
    void fs.rm(dir, { recursive: true, force: true });
  }
}

const BYTE_JOBS: ReadonlySet<ParserJob> = new Set(['extractAudio', 'thumbnail', 'visionImage']);

async function sendAnswer(job: ParserJob, dir: string, res: http.ServerResponse): Promise<void> {
  const byteJob = BYTE_JOBS.has(job);
  const file = path.join(dir, byteJob ? 'out.bin' : 'out.json');
  const { size } = await fs.stat(file);
  const headers: Record<string, string> = {
    'content-type': byteJob ? 'application/octet-stream' : 'application/json',
    'content-length': String(size),
  };
  if (byteJob) {
    const meta = await fs.readFile(path.join(dir, 'meta.json'), 'utf8').catch(() => '{}');
    headers[META_HEADER] = encodeURIComponent(meta);
  }
  res.writeHead(200, headers);
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(file);
    stream.on('error', reject);
    res.on('finish', resolve);
    res.on('close', resolve);
    stream.pipe(res);
  });
}

// ── boot ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (isBootSmoke()) {
    await bootSmokeExit('parser', [() => import('./jobs'), () => import('./cad')]);
  }
  // A job directory left by a killed server is garbage now.
  await fs.rm(WORKDIR, { recursive: true, force: true });
  await fs.mkdir(WORKDIR, { recursive: true });
  if (!TOKEN) {
    process.stderr.write(
      '[parser] PARSER_TOKEN is not set: serving without a bearer token (the parser network is internal to the stack)\n',
    );
  }
  const server = http.createServer((req, res) => {
    handle(req, res).catch((err: unknown) =>
      sendFailure(res, 'failed', err instanceof Error ? err.message : String(err)),
    );
  });
  // A request is the transfer of one file: no long idle sockets.
  server.requestTimeout = 0;
  server.headersTimeout = 30_000;
  server.keepAliveTimeout = 5_000;
  server.listen(PORT, '0.0.0.0', () => {
    process.stdout.write(
      `[parser] listening on :${PORT} (${MAX_JOBS} jobs, ${QUEUE_MAX} queued, ${MAX_BODY_BYTES / 1024 / 1024} MB per file)\n`,
    );
    void probeVersions();
  });
  const stop = () => server.close(() => process.exit(0));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

main().catch((err: unknown) => {
  process.stderr.write(`[parser] ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
