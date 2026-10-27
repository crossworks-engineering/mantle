/**
 * The parser service: the one container that reads every untrusted file the
 * brain receives (docs/parser.md). Documents (pdfjs, mammoth, exceljs,
 * anydoc, our own OOXML, Visio and markup readers), CAD drawings (a Python
 * child: dwg2dxf, ezdwg, ezdxf, ezdwf), images (canvas, heic-convert) and
 * audio out of uploaded video (ffmpeg). The brain talks to it through one
 * client (packages/files/src/parser-client.ts).
 *
 * The safety guarantee is the container: an OS memory limit (`mem_limit`,
 * with no swap beyond it), a CPU share, a size-limited scratch space (a
 * tmpfs) and a network with no route out (compose network `parser`,
 * `internal: true`). Inside it, cheap bounds only:
 *
 *  - PARSER_MAX_JOBS jobs at a time (default 1, so one job has the whole
 *    memory), up to PARSER_QUEUE_MAX waiting at most PARSER_QUEUE_WAIT_MS
 *    each, then `busy`; an interactive request (PRIORITY_HEADER) waits at
 *    the head of the queue, at most PARSER_INTERACTIVE_WAIT_MS. A request
 *    takes its slot BEFORE its body is read: a refused one leaves nothing
 *    on disk;
 *  - a request-body cap (PARSER_MAX_UPLOAD_MB), enforced while the body
 *    streams to disk, never after it sat in memory; a deadline on the
 *    body's arrival and on the answer's, so a slow transfer cannot hold
 *    the slot;
 *  - each job in its own process (./job.ts) and process group, killed at
 *    the job's deadline (PARSER_JOB_TIMEOUT_MS); the kernel's OOM kill
 *    lands on the job process, and the server answers `crashed`. Before
 *    the slot is given back, what the job left running is killed
 *    (./proc.ts `reapOrphans`) and what it left in /tmp is removed;
 *  - an answer cap (PARSER_ANSWER_MAX_BYTES), and the readers' own caps
 *    (zip parts, sheet cells, image pixels, pictures per answer).
 *
 * If the server itself dies, compose restarts it (`restart: unless-stopped`)
 * and the brain reads the dropped connection as `crashed`.
 *
 * This process never parses a document. It holds no secret but its bearer
 * token, mounts no data, and reads nothing but the bodies it is sent.
 */
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { createReadStream, createWriteStream, promises as fs } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootSmokeExit, env, envNum, isBootSmoke } from '@mantle/config';
import { errorMessage } from '@mantle/std';
import { onShutdown } from '@mantle/std/shutdown';
import {
  MAX_OPTS_BYTES,
  META_HEADER,
  OPTS_LENGTH_HEADER,
  PARSER_ANSWER_DEADLINE_MS,
  PARSER_ANSWER_MAX_BYTES,
  PARSER_DEFAULT_PORT,
  PARSER_ERROR_STATUS,
  PARSER_INTERACTIVE_WAIT_MS,
  PARSER_JOB_TIMEOUT_MS,
  PARSER_QUEUE_WAIT_MS,
  PARSER_ROUTES,
  PARSER_SPOOL_DEADLINE_MS,
  PRIORITY_HEADER,
  PRIORITY_INTERACTIVE,
  type ParserErrorCode,
  type ParserJob,
} from '@mantle/files/parser-wire';
import { JobFailure } from './job-failure';
import { cleanScratch, inParserContainer, jobEnv, reapOrphans, runGroup } from './proc';
import { Slots } from './slots';
import { probeVersions } from './versions';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const JOB_ENTRY = path.join(HERE, 'job.ts');

const JOB_BY_PATH = new Map<string, ParserJob>(
  (Object.entries(PARSER_ROUTES) as Array<[ParserJob, string]>).map(([job, route]) => [route, job]),
);

// ── config ──────────────────────────────────────────────────────────────────

const PORT = envNum('PARSER_PORT') || PARSER_DEFAULT_PORT;
// 0.0.0.0 in the container (its only network is the internal one); the dev
// script binds 127.0.0.1 so a laptop's parser is not on the LAN.
const HOST = env('PARSER_HOST') ?? '0.0.0.0';
const TOKEN = env('PARSER_TOKEN') ?? '';
const MAX_JOBS = Math.max(1, envNum('PARSER_MAX_JOBS'));
const QUEUE_MAX = Math.max(0, envNum('PARSER_QUEUE_MAX'));
const MAX_BODY_BYTES = Math.max(1, envNum('PARSER_MAX_UPLOAD_MB')) * 1024 * 1024;
const WORKDIR = env('PARSER_WORKDIR') ?? path.join(os.tmpdir(), 'mantle-parser');
/** This server's mark on every process its jobs start (./proc.ts
 *  JOB_MARK_VAR): what the reaper looks for. */
const MARK = randomUUID();
/** The process groups of the jobs running now: the reaper leaves them be. */
const runningGroups = new Set<number>();

// ── slots ───────────────────────────────────────────────────────────────────

const slots = new Slots(MAX_JOBS, QUEUE_MAX, PARSER_QUEUE_WAIT_MS, PARSER_INTERACTIVE_WAIT_MS);

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

/** How long a refused request's unread body is read (and dropped) before
 *  the answer goes. */
const DRAIN_MS = 60_000;

/**
 * Read the rest of a request's body and drop it: nothing is written. A
 * refusal sent while the client is still sending a large body reaches the
 * client as a reset connection (which it reads as `crashed`, counted against
 * the file), not as the refusal; once the body is read, the answer arrives
 * as sent.
 */
function drainBody(req: http.IncomingMessage): Promise<void> {
  if (req.complete || req.destroyed) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(done, DRAIN_MS);
    req.once('end', done);
    req.once('close', done);
    req.once('error', done);
    req.resume();
  });
}

async function sendFailure(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  code: ParserErrorCode,
  message: string,
  final = false,
): Promise<void> {
  // Mid-answer, or the connection is gone (a deadline cut it): nothing to
  // say it on.
  if (res.headersSent || res.destroyed || !res.socket || res.socket.destroyed) {
    res.destroy();
    return;
  }
  await drainBody(req);
  // Close: one request per connection after a refusal. `final`: the same
  // bytes fail the same way every time (the client makes it terminal).
  sendJson(
    res,
    PARSER_ERROR_STATUS[code],
    { ok: false, error: { code, message, ...(final ? { final: true } : {}) } },
    true,
  );
}

/** `fn`, with the request cut (its socket destroyed) when it runs past
 *  `ms`: a slow transfer gives the slot back. The cut is answered
 *  `timeout`. */
async function withTransferDeadline<T>(
  req: http.IncomingMessage,
  ms: number,
  what: string,
  fn: () => Promise<T>,
): Promise<T> {
  let late = false;
  const timer = setTimeout(() => {
    late = true;
    req.destroy();
  }, ms);
  const tooLate = () => new JobFailure('timeout', `${what} did not arrive within ${ms / 1000} s`);
  try {
    const out = await fn();
    // A cut body may also end without an error: never run a job on part of
    // a file.
    if (late) throw tooLate();
    return out;
  } catch (err) {
    if (late) throw tooLate();
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** Stream the body to the job's directory: the options, then the file,
 *  under the byte cap. */
async function spoolBody(req: http.IncomingMessage, dir: string): Promise<number> {
  const optsLen = Number(req.headers[OPTS_LENGTH_HEADER] ?? 0);
  if (!Number.isInteger(optsLen) || optsLen < 0 || optsLen > MAX_OPTS_BYTES) {
    throw new JobFailure('bad_request', `${OPTS_LENGTH_HEADER} must be 0 to ${MAX_OPTS_BYTES}`);
  }
  const declared = Number(req.headers['content-length'] ?? NaN);
  if (Number.isFinite(declared) && declared - optsLen > MAX_BODY_BYTES) {
    throw new JobFailure(
      'too_large',
      `the file is past the ${MAX_BODY_BYTES / 1024 / 1024} MB the parser takes`,
      { final: true },
    );
  }
  const head: Buffer[] = [];
  let headLen = 0;
  let size = 0;
  const file = createWriteStream(path.join(dir, 'in.bin'));
  let writeError: NodeJS.ErrnoException | null = null;
  file.on('error', (err) => {
    writeError = err;
  });
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
      // Past the cap, or the scratch space full: the rest is read and
      // dropped (never written), and the refusal follows the whole body
      // (see drainBody).
      if (size > MAX_BODY_BYTES || writeError) continue;
      if (!file.write(rest)) await new Promise((r) => file.once('drain', r).once('error', r));
    }
  } finally {
    await new Promise<void>((resolve) => {
      if (file.destroyed) resolve();
      else file.end(() => resolve());
    });
  }
  if (size > MAX_BODY_BYTES) {
    throw new JobFailure(
      'too_large',
      `the file is past the ${MAX_BODY_BYTES / 1024 / 1024} MB the parser takes`,
      { final: true },
    );
  }
  if (writeError) throw scratchFailure(writeError);
  if (headLen < optsLen) throw new JobFailure('bad_request', 'the body ended inside the options');
  const opts = Buffer.concat(head).toString('utf8');
  try {
    if (opts) JSON.parse(opts);
  } catch {
    throw new JobFailure('bad_request', 'the options are not JSON');
  }
  await fs.writeFile(path.join(dir, 'opts.json'), opts || '{}');
  return size;
}

/** A write to the scratch space failed. Full (ENOSPC): the file does not
 *  fit beside what the running jobs hold. Not final: the space can be full
 *  for other reasons, so the bytes get their one retry. */
function scratchFailure(err: NodeJS.ErrnoException): JobFailure {
  if (err.code === 'ENOSPC') {
    return new JobFailure('too_large', "the file does not fit in the parser's scratch space");
  }
  return new JobFailure('failed', `the parser could not write the file: ${err.message}`);
}

type Outcome = 'ok' | ParserErrorCode;

/** Run the job process and read how it ended. */
async function runJobProcess(job: ParserJob, dir: string, abort: AbortSignal): Promise<Outcome> {
  const timeoutMs = PARSER_JOB_TIMEOUT_MS[job];
  // The job's temp files, home and caches: in its own directory (./proc.ts
  // jobEnv), removed with it.
  const scratch = path.join(dir, 'tmp');
  await fs.mkdir(scratch);
  let pgid: number | undefined;
  const ended = await runGroup(process.execPath, [...process.execArgv, JOB_ENTRY, job, dir], {
    timeoutMs,
    abort,
    env: jobEnv(scratch, MARK),
    onSpawn: (pid) => {
      pgid = pid;
      runningGroups.add(pid);
    },
  }).finally(() => {
    if (pgid !== undefined) runningGroups.delete(pgid);
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
      running: slots.running,
      queued: slots.queued,
      maxJobs: MAX_JOBS,
      // Whether this parser asks for a token, and whether the caller sent
      // the right one: the brain's health screen reads a mismatch as down.
      auth: TOKEN ? 'token' : 'none',
      authorized: authorized(req),
    });
    return;
  }
  const job = req.method === 'POST' ? JOB_BY_PATH.get(url) : undefined;
  if (!job) {
    await sendFailure(req, res, 'bad_request', `no route ${req.method} ${url}`);
    return;
  }
  if (!authorized(req)) {
    // `unavailable` to the brain: a wrong token is configuration, not the file.
    await drainBody(req);
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
  const abort = new AbortController();
  res.on('close', () => {
    if (!res.writableFinished) abort.abort();
  });
  const interactive = req.headers[PRIORITY_HEADER] === PRIORITY_INTERACTIVE;
  let slot = false;
  let dir: string | null = null;
  let outcome: Outcome = 'failed';
  let size = 0;
  try {
    // The slot first: a request that cannot run soon is refused before a
    // byte of its body is read, and the scratch space only ever holds the
    // files of the jobs that run.
    await slots.acquire({ interactive });
    slot = true;
    dir = await fs.mkdtemp(path.join(WORKDIR, `${job}-`));
    const jobDir = dir;
    size = await withTransferDeadline(req, PARSER_SPOOL_DEADLINE_MS, 'the file', () =>
      spoolBody(req, jobDir),
    );
    outcome = await runJobProcess(job, dir, abort.signal);
    if (outcome !== 'ok') {
      const e = JSON.parse(await fs.readFile(path.join(dir, 'error.json'), 'utf8')) as {
        message?: string;
        final?: boolean;
      };
      await sendFailure(req, res, outcome, e.message ?? outcome, e.final === true);
      return;
    }
    await sendAnswer(job, dir, res);
  } catch (err) {
    if (err instanceof JobFailure) {
      outcome = err.code;
      await sendFailure(req, res, err.code, err.message, err.final);
    } else {
      outcome = 'failed';
      await sendFailure(req, res, 'failed', errorMessage(err));
    }
  } finally {
    // The job's files go before its slot does: the next job gets the whole
    // scratch space. Then whatever the job left running, and whatever it
    // left in /tmp, before the slot is given back: the next job starts with
    // neither.
    if (dir) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    if (slot) {
      const killed = await reapOrphans({ mark: MARK, keepGroups: runningGroups });
      if (killed > 0)
        process.stderr.write(`[parser] ${job}: killed ${killed} left-behind process(es)\n`);
      // Only while no other job runs (one, by default): a running job's
      // files are under WORKDIR, but a program may write to /tmp itself.
      if (slots.running === 1 && (await scratchIsTmp())) await cleanScratch(os.tmpdir(), WORKDIR);
      slots.release();
    }
    // Log the job, never its content.
    process.stdout.write(
      `[parser] ${job}${interactive ? ' (interactive)' : ''} ${outcome} ${size} B ${Date.now() - started} ms (running ${slots.running}, queued ${slots.queued})\n`,
    );
  }
}

/** /tmp is the parser's own scratch tmpfs: inside its container, with the
 *  job root directly in it. Never on a developer's machine. */
async function scratchIsTmp(): Promise<boolean> {
  return path.dirname(WORKDIR) === os.tmpdir() && (await inParserContainer());
}

const BYTE_JOBS: ReadonlySet<ParserJob> = new Set(['extractAudio', 'thumbnail', 'visionImage']);

async function sendAnswer(job: ParserJob, dir: string, res: http.ServerResponse): Promise<void> {
  const byteJob = BYTE_JOBS.has(job);
  const file = path.join(dir, byteJob ? 'out.bin' : 'out.json');
  const { size } = await fs.stat(file);
  // An answer the brain would refuse is not sent: it holds every answer in
  // memory (packages/files/src/parser-client.ts).
  if (size > PARSER_ANSWER_MAX_BYTES) {
    throw new JobFailure(
      'too_large',
      `the answer is ${Math.round(size / 1024 / 1024)} MB, past the ${PARSER_ANSWER_MAX_BYTES / 1024 / 1024} MB an answer may be`,
      { final: true },
    );
  }
  const headers: Record<string, string> = {
    'content-type': byteJob ? 'application/octet-stream' : 'application/json',
    'content-length': String(size),
  };
  if (byteJob) {
    const meta = await fs.readFile(path.join(dir, 'meta.json'), 'utf8').catch(() => '{}');
    headers[META_HEADER] = encodeURIComponent(meta);
  }
  res.writeHead(200, headers);
  // A client that does not read its answer gives the slot back at the
  // deadline: the connection is cut.
  const cut = setTimeout(() => res.destroy(), PARSER_ANSWER_DEADLINE_MS);
  try {
    await new Promise<void>((resolve, reject) => {
      const stream = createReadStream(file);
      stream.on('error', reject);
      res.on('finish', resolve);
      res.on('close', () => {
        stream.destroy();
        resolve();
      });
      stream.pipe(res);
    });
  } finally {
    clearTimeout(cut);
  }
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
    handle(req, res).catch(
      (err: unknown) => void sendFailure(req, res, 'failed', errorMessage(err)),
    );
  });
  // A request is the transfer of one file: no long idle sockets. Node's
  // whole-request timeout is off; the slot holder's own deadlines bound it
  // (the body's arrival, the job, the answer).
  server.requestTimeout = 0;
  server.headersTimeout = 30_000;
  server.keepAliveTimeout = 5_000;
  server.listen(PORT, HOST, () => {
    process.stdout.write(
      `[parser] listening on ${HOST}:${PORT} (${MAX_JOBS} jobs, ${QUEUE_MAX} queued, ${MAX_BODY_BYTES / 1024 / 1024} MB per file)\n`,
    );
    void probeVersions();
  });
  // Stop taking requests and let the running ones answer; Docker's default
  // 10 s grace ends the rest (a job's group dies with the container).
  onShutdown({
    name: 'parser',
    deadlineMs: 8_000,
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  });
}

main().catch((err: unknown) => {
  process.stderr.write(`[parser] ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
