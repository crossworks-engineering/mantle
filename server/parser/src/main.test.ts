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
 * right.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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

beforeAll(async () => {
  const port = await freePort();
  workdir = mkdtempSync(path.join(os.tmpdir(), 'parser-main-test-'));
  child = spawn(process.execPath, ['--import', 'tsx', path.join(HERE, 'main.ts')], {
    cwd: path.join(HERE, '..'),
    env: {
      ...process.env,
      PARSER_PORT: String(port),
      PARSER_HOST: '127.0.0.1',
      PARSER_TOKEN: TOKEN,
      PARSER_MAX_JOBS: '1',
      PARSER_QUEUE_MAX: '0',
      PARSER_MAX_UPLOAD_MB: '1',
      PARSER_WORKDIR: path.join(workdir, 'jobs'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  base = `http://127.0.0.1:${port}`;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the parser did not start')), 30_000);
    child.stdout!.on('data', (d: Buffer) => {
      if (d.toString().includes('listening on')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once('exit', (code) => reject(new Error(`the parser exited ${code}`)));
  });
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
    const opts = Buffer.from(JSON.stringify({ ext: 'txt' }));
    const slow = fetch(`${base}${PARSER_ROUTES.text}`, {
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
});
