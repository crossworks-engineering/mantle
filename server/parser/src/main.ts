/**
 * The parser service: the one container that reads every untrusted file the
 * brain receives (docs/parser.md). Documents (pdfjs, mammoth, exceljs,
 * anydoc, our own OOXML, Visio and markup readers), CAD drawings (a Python
 * child: dwg2dxf, ezdwg, ezdxf, ezdwf), images (canvas, heic-convert) and
 * audio out of uploaded video (ffmpeg). The brain talks to it through one
 * client (packages/files/src/parser-client.ts).
 *
 * The safety guarantee is the container: an OS memory limit (`mem_limit`,
 * with no swap beyond it), a CPU share, a read-only root filesystem with a
 * size-limited scratch space (a tmpfs on /tmp) and a network with no route
 * out (compose network `parser`, `internal: true`). Inside it, cheap
 * bounds only:
 *
 *  - one job at a time, so a job has the whole memory; up to
 *    PARSER_QUEUE_MAX waiting at most PARSER_QUEUE_WAIT_MS each, then
 *    `busy`; an interactive request (PRIORITY_HEADER) waits at the head of
 *    the queue, at most PARSER_INTERACTIVE_WAIT_MS. A request takes the
 *    slot BEFORE its body is read: a refused one leaves nothing on disk;
 *  - a request-body cap (PARSER_MAX_UPLOAD_MB), enforced while the body
 *    streams to disk, never after it sat in memory; a deadline on the
 *    body's arrival and on the answer's, so a slow transfer cannot hold
 *    the slot;
 *  - each job in its own process (./job.ts) and process group, killed at
 *    the job's deadline (PARSER_JOB_TIMEOUT_MS); the kernel's OOM kill
 *    lands on the job process, and the server answers `crashed`;
 *  - an answer cap (PARSER_ANSWER_MAX_BYTES), and the readers' own caps
 *    (zip parts, sheet cells, image pixels, pictures per answer).
 *
 * Between jobs the container is the boundary, not code. After every job,
 * once its answer is sent and before the slot is given back, the server
 * kills the job's group, removes its directory and checks the container is
 * as clean as a fresh one (./clean.ts): no process but its own, nothing
 * written anywhere but the empty job root. If it is not, or the cleanup
 * throws, the server stops taking jobs and exits, and Docker restarts the
 * container (`restart: unless-stopped`) with a fresh tmpfs and process
 * table. The check runs only after a job, so a clean start never exits.
 * A slot held past every deadline (a wedge) turns /healthz to 503, and
 * autoheal restarts it the same way. The brain reads a dropped connection
 * as `crashed`, a refused one as `unavailable`.
 *
 * This process never parses a document. It holds no secret but its bearer
 * token, mounts no data, and reads nothing but the bodies it is sent.
 */
import { timingSafeEqual } from 'node:crypto';
import { createWriteStream, promises as fs } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootSmokeExit, env, envNum, isBootSmoke } from '@mantle/config';
import { errorMessage } from '@mantle/std';
import { onShutdown } from '@mantle/std/shutdown';
import {
  MAX_OPTS_BYTES,
  OPTS_LENGTH_HEADER,
  PARSER_DEFAULT_PORT,
  PARSER_ERROR_STATUS,
  PARSER_INTERACTIVE_WAIT_MS,
  PARSER_JOB_TIMEOUT_MS,
  PARSER_QUEUE_WAIT_MS,
  PARSER_ROUTES,
  PARSER_SPOOL_DEADLINE_MS,
  PRIORITY_HEADER,
  PRIORITY_INTERACTIVE,
  parserSlotHoldMaxMs,
  type ParserErrorCode,
  type ParserJob,
} from '@mantle/files/parser-wire';
import { sendAnswer } from './answer';
import { inParserContainer, leftovers, readProcs, strays } from './clean';
import { JOB_CODES, JobFailure } from './job-failure';
import { jobEnv, runGroup } from './proc';
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
const QUEUE_MAX = Math.max(0, envNum('PARSER_QUEUE_MAX'));
const MAX_BODY_BYTES = Math.max(1, envNum('PARSER_MAX_UPLOAD_MB')) * 1024 * 1024;
const WORKDIR = env('PARSER_WORKDIR') ?? path.join(os.tmpdir(), 'mantle-parser');
/** Past this the slot is wedged (no job, transfer or cleanup takes so
 *  long): /healthz answers 503 and autoheal restarts the container. */
const SLOT_HOLD_MAX_MS = envNum('PARSER_SLOT_HOLD_MAX_MS', parserSlotHoldMaxMs());
/** How long the job's killed processes get to go before the check says
 *  they stayed. */
const SETTLE_MS = 2_000;
/** How long the requests in flight get to be answered (a waiter's
 *  `unavailable`) before a restart's exit. */
const RESTART_GRACE_MS = 20_000;

// ── the slot ────────────────────────────────────────────────────────────────

const slots = new Slots(QUEUE_MAX, PARSER_QUEUE_WAIT_MS, PARSER_INTERACTIVE_WAIT_MS);
/** Job requests in flight (waiting, running or answering). */
let inFlight = 0;
/** Why the server is restarting (it takes no more jobs), once it is. */
let restarting: string | null = null;

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

/** The write stream drained, or failed (its error is kept by the caller).
 *  Both listeners go once either fires: a large body waits here many
 *  times, and a listener left each time piles up on the stream. */
function drained(file: NodeJS.WritableStream): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      file.off('drain', done);
      file.off('error', done);
      resolve();
    };
    file.once('drain', done);
    file.once('error', done);
  });
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
      if (!file.write(rest)) await drained(file);
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
  await fs.writeFile(path.join(dir, 'opts.json'), opts || '{}').catch((err: unknown) => {
    throw serverFailure(err);
  });
  return size;
}

/** A write to the scratch space failed. Full (ENOSPC): the file does not
 *  fit. Not final: the space can be full for other reasons, so the bytes
 *  get their one retry. Anything else is the parser's own fault, never the
 *  file's: `unavailable` (retried, not counted). */
function scratchFailure(err: NodeJS.ErrnoException): JobFailure {
  if (err.code === 'ENOSPC') {
    return new JobFailure('too_large', "the file does not fit in the parser's scratch space");
  }
  return serverFailure(err);
}

/** The server's own I/O failed (its scratch directory, a write of the
 *  options): not a verdict on the file. */
function serverFailure(err: unknown): JobFailure {
  return new JobFailure(
    'unavailable',
    `the parser could not prepare the job: ${errorMessage(err)}`,
  );
}

type Outcome = 'ok' | ParserErrorCode;

type JobEnd = { code: 'ok' } | { code: ParserErrorCode; message: string; final: boolean };

/** Run the job process and read how it ended. `onSpawn` is told the job's
 *  process group. */
async function runJobProcess(
  job: ParserJob,
  dir: string,
  abort: AbortSignal,
  onSpawn: (pgid: number) => void,
): Promise<JobEnd> {
  const timeoutMs = PARSER_JOB_TIMEOUT_MS[job];
  // The job's temp files, home and caches: in its own directory (./proc.ts
  // jobEnv), removed with it.
  const scratch = path.join(dir, 'tmp');
  await fs.mkdir(scratch).catch((err: unknown) => {
    throw serverFailure(err);
  });
  const ended = await runGroup(process.execPath, [...process.execArgv, JOB_ENTRY, job, dir], {
    timeoutMs,
    abort,
    env: jobEnv(scratch),
    onSpawn,
  });
  if (ended.code === 0) return { code: 'ok' };
  if (ended.timedOut) {
    return {
      code: 'timeout',
      message: `the job ran past its ${timeoutMs / 1000} s limit and was killed`,
      final: false,
    };
  }
  if (ended.code === 3) {
    // The job's own verdict, from the codes a job may give: anything else
    // (the server's busy or unavailable, a made-up code) is a crash.
    try {
      const e = JSON.parse(await fs.readFile(path.join(dir, 'error.json'), 'utf8')) as {
        code?: unknown;
        message?: unknown;
        final?: unknown;
      };
      if (typeof e.code === 'string' && JOB_CODES.has(e.code as ParserErrorCode)) {
        return {
          code: e.code as ParserErrorCode,
          message: typeof e.message === 'string' ? e.message : e.code,
          final: e.final === true,
        };
      }
    } catch {
      /* fall through to crashed */
    }
  }
  const why = ended.signal
    ? `the job process was killed (${ended.signal}): the document needed more memory than the parser may use`
    : `the job process ended with code ${ended.code}${ended.spawnError ? ` (${ended.spawnError})` : ''}`;
  if (ended.stderr.trim())
    process.stderr.write(`[parser] ${job}: ${ended.stderr.trim().slice(-800)}\n`);
  return { code: 'crashed', message: why, final: false };
}

/**
 * After a job, with its answer sent and before the slot is given back:
 * kill its process group, remove its directory, and check the container
 * is clean (./clean.ts). Returns why it is not, or null. Never throws: a
 * cleanup that throws is a reason too.
 */
async function afterJob(dir: string | null, pgid: number | undefined): Promise<string | null> {
  try {
    if (pgid !== undefined) {
      try {
        process.kill(-pgid, 'SIGKILL');
      } catch {
        /* gone already */
      }
    }
    if (dir) {
      try {
        await fs.rm(dir, { recursive: true, force: true });
      } catch (err) {
        return `the job's directory could not be removed (${errorMessage(err)})`;
      }
    }
    const container = await inParserContainer();
    const scratchRoot = path.dirname(WORKDIR);
    // The killed processes need a moment to go; anything still there after
    // SETTLE_MS stayed.
    const until = Date.now() + SETTLE_MS;
    for (;;) {
      const left = await leftovers({ workdir: WORKDIR, scratchRoot, container });
      const procs = container ? strays(await readProcs(), process.pid, pgid) : [];
      const why =
        left ??
        (procs.length > 0
          ? `${procs.length} process(es) outlived the job (pid ${procs
              .slice(0, 5)
              .map((p) => p.pid)
              .join(', ')})`
          : null);
      if (!why || Date.now() >= until) return why;
      await new Promise((r) => setTimeout(r, 100));
    }
  } catch (err) {
    return `the cleanup after the job failed (${errorMessage(err)})`;
  }
}

/**
 * The container is dirty: take no more jobs, answer every waiter
 * `unavailable` (retried, never counted against its file), let the
 * requests in flight be answered, then exit so Docker restarts the
 * container with a fresh tmpfs and process table.
 */
function restart(why: string): void {
  if (restarting) return;
  restarting = why;
  process.stderr.write(
    `[parser] RESTART: ${why}; exiting so the container restarts with a fresh /tmp and process table\n`,
  );
  slots.close('the parser is restarting');
  const started = Date.now();
  const exitWhenIdle = (): void => {
    if (inFlight === 0 || Date.now() - started >= RESTART_GRACE_MS) process.exit(1);
    setTimeout(exitWhenIdle, 50);
  };
  // After this turn of the loop: the answer just sent is flushed first.
  setTimeout(exitWhenIdle, 50);
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = (req.url ?? '/').split('?')[0]!;
  if (req.method === 'GET' && url === '/healthz') {
    const heldMs = slots.heldMs();
    // A slot held past every deadline is a wedge; a restart is under way.
    const wedged = heldMs > SLOT_HOLD_MAX_MS;
    const ok = !wedged && !restarting;
    sendJson(res, ok ? 200 : 503, {
      ok,
      ...(wedged
        ? { why: `the job slot has been held ${Math.round(heldMs / 1000)} s, past every deadline` }
        : restarting
          ? { why: restarting }
          : {}),
      versions: await probeVersions(),
      running: slots.running,
      queued: slots.queued,
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
  inFlight++;
  try {
    await runRequest(job, req, res);
  } finally {
    inFlight--;
  }
}

async function runRequest(
  job: ParserJob,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const started = Date.now();
  const abort = new AbortController();
  res.on('close', () => {
    if (!res.writableFinished) abort.abort();
  });
  const interactive = req.headers[PRIORITY_HEADER] === PRIORITY_INTERACTIVE;
  let slot = false;
  let dir: string | null = null;
  let pgid: number | undefined;
  let outcome: Outcome = 'unavailable';
  let size = 0;
  try {
    // The slot first: a request that cannot run soon is refused before a
    // byte of its body is read, and the scratch space only ever holds the
    // file of the job that runs.
    await slots.acquire({ interactive });
    slot = true;
    dir = await fs.mkdtemp(path.join(WORKDIR, `${job}-`)).catch((err: unknown) => {
      throw serverFailure(err);
    });
    const jobDir = dir;
    size = await withTransferDeadline(req, PARSER_SPOOL_DEADLINE_MS, 'the file', () =>
      spoolBody(req, jobDir),
    );
    const ended = await runJobProcess(job, dir, abort.signal, (pid) => (pgid = pid));
    outcome = ended.code;
    if (ended.code !== 'ok') {
      await sendFailure(req, res, ended.code, ended.message, ended.final);
      return;
    }
    await sendAnswer(job, dir, res);
  } catch (err) {
    // A JobFailure is typed; anything else is the server's own fault, never
    // a verdict on the file (LOW-A): `unavailable`.
    const failure = err instanceof JobFailure ? err : serverFailure(err);
    outcome = failure.code;
    await sendFailure(req, res, failure.code, failure.message, failure.final);
  } finally {
    // The answer is sent. Before the slot is given back the job's group
    // goes, its directory goes, and the container must be as clean as a
    // fresh one; if it is not, no job runs here again (restart).
    if (slot) {
      const dirty = await afterJob(dir, pgid);
      if (dirty) restart(`after ${job}: ${dirty}`);
      slots.release();
    }
    // Log the job, never its content.
    process.stdout.write(
      `[parser] ${job}${interactive ? ' (interactive)' : ''} ${outcome} ${size} B ${Date.now() - started} ms (queued ${slots.queued})\n`,
    );
  }
}

// ── boot ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (isBootSmoke()) {
    await bootSmokeExit('parser', [() => import('./jobs'), () => import('./cad')]);
  }
  // A job directory left by a killed server is garbage now (in the
  // container a restart gives a fresh tmpfs anyway).
  await fs.rm(WORKDIR, { recursive: true, force: true });
  await fs.mkdir(WORKDIR, { recursive: true });
  // The versions before the first request: no probe of the server's own is
  // ever running beside a job.
  await probeVersions();
  if (!TOKEN) {
    process.stderr.write(
      '[parser] PARSER_TOKEN is not set: serving without a bearer token (the parser network is internal to the stack)\n',
    );
  }
  const server = http.createServer((req, res) => {
    handle(req, res).catch(
      (err: unknown) => void sendFailure(req, res, 'unavailable', errorMessage(err)),
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
      `[parser] listening on ${HOST}:${PORT} (one job at a time, ${QUEUE_MAX} queued, ${MAX_BODY_BYTES / 1024 / 1024} MB per file)\n`,
    );
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
