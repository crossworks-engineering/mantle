/**
 * The parser server (./main.ts), booted for real on a loopback port, against
 * the brain's own client (packages/files/src/parser-client.ts). What is
 * pinned: a refusal reaches the client as the refusal it is, also while the
 * client is still sending a large body (a refusal sent over an unread body
 * arrives as a reset connection, which the client reads as `crashed` and
 * counts against the file):
 *  - a body past the cap is `too_large`;
 *  - with every slot taken and no room to wait, `busy`, at once, and nothing
 *    of the body is written;
 *  - a wrong token is `unavailable`;
 * and `/healthz` says whether a token is asked and whether the caller's is
 * right. And the slot is never wedged: a client that hangs up mid-answer
 * gives it back; a slot held past every deadline turns /healthz to 503 (the
 * watchdog autoheal acts on); a job that leaves anything behind makes the
 * server answer first, refuse its waiter `unavailable` and exit 1 (Docker
 * restarts the container).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { PARSER_ROUTES } from '@mantle/files/parser-wire';
import {
  isParserError,
  parserHealth,
  parserText,
  resetParserFailures,
  withParserScope,
} from '@mantle/files';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOKEN = 'test-parser-token';
let child: ChildProcess;
let base: string;
let workdir: string;
const saved = { url: process.env.PARSER_URL, token: process.env.PARSER_TOKEN };

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

/** Boot a parser on a free loopback port with `extra` settings; resolves
 *  once it listens. */
async function boot(
  dir: string,
  extra: Record<string, string> = {},
): Promise<{ proc: ChildProcess; url: string; out: () => string }> {
  const port = await freePort();
  const proc = spawn(process.execPath, ['--import', 'tsx', path.join(HERE, 'main.ts')], {
    cwd: path.join(HERE, '..'),
    env: {
      ...process.env,
      PARSER_PORT: String(port),
      PARSER_HOST: '127.0.0.1',
      PARSER_TOKEN: TOKEN,
      PARSER_QUEUE_MAX: '0',
      PARSER_MAX_UPLOAD_MB: '1',
      PARSER_WORKDIR: path.join(dir, 'jobs'),
      ...extra,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  proc.stdout!.on('data', (d: Buffer) => (out += d.toString()));
  proc.stderr!.on('data', (d: Buffer) => (out += d.toString()));
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the parser did not start')), 30_000);
    proc.stdout!.on('data', () => {
      if (out.includes('listening on')) {
        clearTimeout(timer);
        resolve();
      }
    });
    proc.once('exit', (code) => reject(new Error(`the parser exited ${code}: ${out}`)));
  });
  return { proc, url: `http://127.0.0.1:${port}`, out: () => out };
}

beforeAll(async () => {
  workdir = mkdtempSync(path.join(os.tmpdir(), 'parser-main-test-'));
  const booted = await boot(workdir);
  child = booted.proc;
  base = booted.url;
  process.env.PARSER_URL = base;
  process.env.PARSER_TOKEN = TOKEN;
}, 60_000);

afterAll(() => {
  child?.kill('SIGKILL');
  rmSync(workdir, { recursive: true, force: true });
  if (saved.url === undefined) delete process.env.PARSER_URL;
  else process.env.PARSER_URL = saved.url;
  if (saved.token === undefined) delete process.env.PARSER_TOKEN;
  else process.env.PARSER_TOKEN = saved.token;
  resetParserFailures();
});

async function failureOf(p: Promise<unknown>) {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(isParserError(err)).toBe(true);
  return err as { code: string; retryable: boolean; terminal: boolean };
}

/** A /text request whose body arrives only when `held` resolves: it holds
 *  the slot meanwhile (a request takes the slot before its body is read). */
function slowText(url: string, held: Promise<void>): Promise<Response> {
  const opts = Buffer.from(JSON.stringify({ ext: 'txt' }));
  return fetch(`${url}${PARSER_ROUTES.text}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${TOKEN}`,
      'x-parser-opts-length': String(opts.length),
    },
    body: new ReadableStream<Uint8Array>({
      async start(c) {
        c.enqueue(opts);
        c.enqueue(Buffer.from('a slow small body'));
        await held;
        c.close();
      },
    }),
    duplex: 'half',
  } as RequestInit);
}

async function health(url: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const r = await fetch(`${url}/healthz`);
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
}

/** Poll until `ok` holds (a loaded machine is slow), at most `ms`. */
async function until(ok: () => Promise<boolean>, ms = 30_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await ok()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return ok();
}

describe('the parser server', () => {
  it('answers a body past the cap too_large, also a large one still streaming', async () => {
    const err = await failureOf(parserText(Buffer.alloc(64 * 1024 * 1024, 0x41), 'txt'));
    expect(err.code).toBe('too_large');
  });

  it('answers busy at once when the only slot is taken, never a reset, and writes nothing', async () => {
    // The answer of the test before may come back before its job has given
    // the slot back: start from an idle parser.
    for (let i = 0; i < 300; i++) {
      const h = (await (await fetch(`${base}/healthz`)).json()) as { running?: number };
      if (h.running === 0) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    // The slot is taken before a body is read: hold it with a request whose
    // body arrives slowly.
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const slow = slowText(base, held);
    // Wait until the slow request holds the slot (the parser says so); on
    // a loaded machine that can take a while, and the test means nothing
    // until it does.
    let holding = false;
    for (let i = 0; i < 300 && !holding; i++) {
      const h = (await (await fetch(`${base}/healthz`)).json()) as { running?: number };
      holding = h.running === 1;
      if (!holding) await new Promise((r) => setTimeout(r, 100));
    }
    expect(holding).toBe(true);
    try {
      const started = Date.now();
      // Interactive: the client says busy at once instead of waiting it out.
      const err = await failureOf(
        withParserScope({ interactive: true }, () =>
          parserText(Buffer.alloc(32 * 1024 * 1024, 0x42), 'txt'),
        ),
      );
      expect(err).toMatchObject({ code: 'busy', retryable: true, terminal: false });
      expect(Date.now() - started).toBeLessThan(10_000);
      // Only the held job's directory is in the scratch space.
      const dirs = readdirSync(path.join(workdir, 'jobs'));
      expect(dirs.length).toBeLessThanOrEqual(1);
    } finally {
      release();
    }
    const r = await slow;
    expect(r.ok).toBe(true);
  }, 60_000);

  it('answers a wrong token unavailable, also over a large body', async () => {
    process.env.PARSER_TOKEN = 'wrong';
    try {
      const err = await failureOf(parserText(Buffer.alloc(8 * 1024 * 1024, 0x43), 'txt'));
      expect(err).toMatchObject({ code: 'unavailable', retryable: true });
      expect((await parserHealth(5_000)).up).toBe(false);
    } finally {
      process.env.PARSER_TOKEN = TOKEN;
    }
    expect((await parserHealth(5_000)).up).toBe(true);
  });

  it('reads a small text end to end', async () => {
    expect(await parserText(Buffer.from('hello parser'), 'txt')).toBe('hello parser');
  });

  it('a client that hangs up mid-answer gives the slot back', async () => {
    const text = Buffer.alloc(900 * 1024, 0x61);
    const opts = Buffer.from(JSON.stringify({ ext: 'txt' }));
    await new Promise<void>((resolve) => {
      const req = http.request(
        `${base}${PARSER_ROUTES.text}`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${TOKEN}`,
            'x-parser-opts-length': String(opts.length),
            'content-length': String(opts.length + text.length),
          },
        },
        (res) => {
          // The answer started: hang up after its first bytes.
          res.once('data', () => {
            req.destroy();
            resolve();
          });
        },
      );
      req.on('error', () => resolve());
      req.end(Buffer.concat([opts, text]));
    });
    expect(await until(async () => (await health(base)).body.running === 0)).toBe(true);
    expect(await parserText(Buffer.from('after the hang-up'), 'txt')).toBe('after the hang-up');
  }, 60_000);
});

describe('the parser server between jobs (one booted for each case)', () => {
  let dir: string;
  let proc: ChildProcess | null = null;
  afterEach(() => {
    proc?.kill('SIGKILL');
    proc = null;
    rmSync(dir, { recursive: true, force: true });
  });

  it('answers /healthz 503 while the slot is held past every deadline (the watchdog)', async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'parser-watchdog-'));
    const booted = await boot(dir, { PARSER_SLOT_HOLD_MAX_MS: '1500' });
    proc = booted.proc;
    expect((await health(booted.url)).status).toBe(200);
    let release!: () => void;
    const slow = slowText(booted.url, new Promise<void>((r) => (release = r)));
    try {
      expect(await until(async () => (await health(booted.url)).body.running === 1)).toBe(true);
      expect(await until(async () => (await health(booted.url)).status === 503)).toBe(true);
      expect(String((await health(booted.url)).body.why)).toContain('past every deadline');
    } finally {
      release();
    }
    expect((await slow).ok).toBe(true);
    expect(await until(async () => (await health(booted.url)).status === 200)).toBe(true);
  }, 90_000);

  it('a job that leaves anything behind: answered first, its waiter unavailable, then exit 1', async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'parser-restart-'));
    const booted = await boot(dir, { PARSER_QUEUE_MAX: '1' });
    proc = booted.proc;
    const exited = new Promise<number | null>((r) => booted.proc.once('exit', (code) => r(code)));
    let release!: () => void;
    const slow = slowText(booted.url, new Promise<void>((r) => (release = r)));
    expect(await until(async () => (await health(booted.url)).body.running === 1)).toBe(true);
    // A waiter in the queue behind it.
    const waiter = fetch(`${booted.url}${PARSER_ROUTES.text}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'x-parser-opts-length': '0' },
      body: 'the waiter',
    });
    expect(await until(async () => (await health(booted.url)).body.queued === 1)).toBe(true);
    // What a job could leave: a file in the scratch space outside its own
    // directory (the job root is the parser's, never a job's).
    writeFileSync(path.join(dir, 'jobs', 'left-behind'), 'x');
    release();
    const r = await slow;
    expect(r.ok).toBe(true);
    expect(((await r.json()) as { text?: string }).text).toBe('a slow small body');
    const w = await waiter;
    expect(w.status).toBe(503);
    expect(((await w.json()) as { error: { code: string } }).error.code).toBe('unavailable');
    expect(await exited).toBe(1);
    expect(booted.out()).toContain('RESTART: after text: the job root');
  }, 90_000);
});
