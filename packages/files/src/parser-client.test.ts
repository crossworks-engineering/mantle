/**
 * The parser client's typed failures and the per-job count (./parser-client.ts),
 * against a stub of the parser on a loopback port. What is pinned:
 *  - too_large / timeout / crashed: retryable the first time for the same
 *    bytes in a job, terminal the second, and a terminal job is not sent
 *    again;
 *  - the count is per job: the pictures pass failing never makes the text
 *    read terminal;
 *  - a refusal the parser marks final (a fixed cap) is terminal the first
 *    time;
 *  - failed is neither retryable nor terminal; unavailable (a refused
 *    connection, a wrong token) is retryable and never counted;
 *  - an interactive exchange asks for the head of the parser's queue and
 *    skips this process's own.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PARSER_ERROR_STATUS, type ParserErrorCode } from './parser-wire';
import {
  ParserError,
  isParserUnavailable,
  parserFailureKey,
  parserHealth,
  parserImages,
  parserText,
  resetParserFailures,
  withParserScope,
  type ParserFailureCount,
  type ParserFailureLedger,
} from './parser-client';

type Reply =
  | { code: ParserErrorCode; final?: boolean }
  | { text: string }
  | { status: number }
  | { health: Record<string, unknown> };
let reply: Reply = { text: '' };
const hits: string[] = [];
const auths: string[] = [];
const priorities: string[] = [];
/** While set, a request to /images is answered only once it resolves. */
let holdImages: Promise<void> | null = null;
let server: Server;
let saved: { url?: string; token?: string };

beforeAll(async () => {
  server = createServer((req, res) => {
    req.resume();
    req.on('end', async () => {
      hits.push(req.url ?? '');
      auths.push(req.headers.authorization ?? '');
      priorities.push(String(req.headers['x-parser-priority'] ?? ''));
      if (req.url === '/images' && holdImages) await holdImages;
      if ('health' in reply) {
        res
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ ok: true, versions: {}, running: 0, queued: 0, ...reply.health }));
      } else if ('status' in reply) {
        res.writeHead(reply.status).end();
      } else if ('code' in reply) {
        res.writeHead(PARSER_ERROR_STATUS[reply.code], { 'content-type': 'application/json' }).end(
          JSON.stringify({
            ok: false,
            error: {
              code: reply.code,
              message: reply.code,
              ...(reply.final ? { final: true } : {}),
            },
          }),
        );
      } else {
        res
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ text: reply.text, images: [], candidates: 0, rejected: 0 }));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  saved = { url: process.env.PARSER_URL, token: process.env.PARSER_TOKEN };
  process.env.PARSER_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  delete process.env.PARSER_TOKEN;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (saved.url === undefined) delete process.env.PARSER_URL;
  else process.env.PARSER_URL = saved.url;
  if (saved.token !== undefined) process.env.PARSER_TOKEN = saved.token;
});

let seq = 0;
function doc(): Buffer {
  seq += 1;
  return Buffer.from(`synthetic document ${seq}`);
}

beforeEach(() => {
  resetParserFailures();
  hits.length = 0;
  auths.length = 0;
  priorities.length = 0;
  holdImages = null;
  reply = { text: '' };
});

async function failure(p: Promise<unknown>): Promise<ParserError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ParserError);
  return err as ParserError;
}

describe('parser client', () => {
  it('reads the text answer', async () => {
    reply = { text: 'hello' };
    expect(await parserText(doc(), 'docx')).toBe('hello');
    expect(hits).toEqual(['/text']);
  });

  for (const code of ['too_large', 'timeout', 'crashed'] as const) {
    it(`counts ${code}: retryable once, then terminal, then not sent again`, async () => {
      const bytes = doc();
      reply = { code };
      const first = await failure(parserText(bytes, 'docx'));
      expect(first).toMatchObject({ code, retryable: true, terminal: false });
      const second = await failure(parserText(bytes, 'docx'));
      expect(second).toMatchObject({ code, retryable: false, terminal: true });
      const third = await failure(parserText(bytes, 'docx'));
      expect(third).toMatchObject({ code, terminal: true });
      expect(hits).toHaveLength(2);
    });
  }

  it('counts per job: the pictures timing out twice leave the text read open', async () => {
    const bytes = doc();
    reply = { code: 'timeout' };
    await failure(parserImages(bytes, 'pdf', { maxImages: 4 }));
    const pics = await failure(parserImages(bytes, 'pdf', { maxImages: 4 }));
    expect(pics.terminal).toBe(true);
    reply = { text: 'the body' };
    expect(await parserText(bytes, 'pdf')).toBe('the body');
  });

  it('gives other bytes their own count', async () => {
    reply = { code: 'crashed' };
    await failure(parserText(doc(), 'docx'));
    const other = await failure(parserText(doc(), 'docx'));
    expect(other).toMatchObject({ retryable: true, terminal: false });
  });

  it('answers failed as a verdict: neither retried nor terminal', async () => {
    const bytes = doc();
    reply = { code: 'failed' };
    for (let i = 0; i < 3; i++) {
      const err = await failure(parserText(bytes, 'docx'));
      expect(err).toMatchObject({ code: 'failed', retryable: false, terminal: false });
    }
    expect(hits).toHaveLength(3);
  });

  it('reads a 401 (a wrong token) as unavailable, never counted', async () => {
    const bytes = doc();
    reply = { status: 401 };
    for (let i = 0; i < 3; i++) {
      const err = await failure(parserText(bytes, 'docx'));
      expect(err).toMatchObject({ code: 'unavailable', retryable: true, terminal: false });
      expect(isParserUnavailable(err)).toBe(true);
    }
  });

  it('reads a bare 503 (a stand-in or proxy, no envelope) as unavailable', async () => {
    reply = { status: 503 };
    const err = await failure(parserText(doc(), 'docx'));
    expect(err).toMatchObject({ code: 'unavailable', retryable: true, terminal: false });
    expect(err.message).toContain('(parser, HTTP 503)');
  });

  it('reads a refused connection as unavailable', async () => {
    const url = process.env.PARSER_URL;
    // A port nothing listens on: bind one, take its number, close it.
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const port = (probe.address() as AddressInfo).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    process.env.PARSER_URL = `http://127.0.0.1:${port}`;
    try {
      const err = await failure(parserText(doc(), 'docx'));
      expect(err).toMatchObject({ code: 'unavailable', retryable: true, terminal: false });
    } finally {
      process.env.PARSER_URL = url;
    }
  });

  it("counts in the scope's ledger, not in memory, and a count of two there is never sent", async () => {
    const kept = new Map<string, ParserFailureCount>();
    const ledger: ParserFailureLedger = {
      get: (key) => Promise.resolve(kept.get(key) ?? null),
      add: (key, code) => {
        const n = (kept.get(key)?.n ?? 0) + 1;
        kept.set(key, { n, code });
        return Promise.resolve(n);
      },
    };
    const bytes = doc();
    reply = { code: 'timeout' };
    const first = await failure(
      withParserScope({ failures: ledger }, () => parserText(bytes, 'docx')),
    );
    expect(first).toMatchObject({ retryable: true, terminal: false });
    expect(kept.get(parserFailureKey('text', bytes))).toEqual({ n: 1, code: 'timeout' });
    // Memory knows nothing of it: a call outside the scope counts afresh.
    const outside = await failure(parserText(bytes, 'docx'));
    expect(outside).toMatchObject({ retryable: true, terminal: false });
    // A restart (a fresh process's memory) changes nothing: the ledger says one.
    resetParserFailures();
    const second = await failure(
      withParserScope({ failures: ledger }, () => parserText(bytes, 'docx')),
    );
    expect(second).toMatchObject({ code: 'timeout', retryable: false, terminal: true });
    hits.length = 0;
    const third = await failure(
      withParserScope({ failures: ledger }, () => parserText(bytes, 'docx')),
    );
    expect(third).toMatchObject({ code: 'timeout', terminal: true });
    expect(hits).toEqual([]);
  });

  it('makes a final refusal (a fixed cap) terminal the first time, and never sends it again', async () => {
    const bytes = doc();
    reply = { code: 'too_large', final: true };
    const first = await failure(parserText(bytes, 'docx'));
    expect(first).toMatchObject({ code: 'too_large', retryable: false, terminal: true });
    hits.length = 0;
    const again = await failure(parserText(bytes, 'docx'));
    expect(again).toMatchObject({ code: 'too_large', terminal: true });
    expect(hits).toEqual([]);
  });

  it('gives a too_large that is not final (a full scratch space) its one retry', async () => {
    const bytes = doc();
    reply = { code: 'too_large' };
    const first = await failure(parserText(bytes, 'docx'));
    expect(first).toMatchObject({ code: 'too_large', retryable: true, terminal: false });
    const second = await failure(parserText(bytes, 'docx'));
    expect(second).toMatchObject({ code: 'too_large', retryable: false, terminal: true });
  });

  it('asks for the head of the queue on the interactive path, and skips this process’s queue', async () => {
    const saved = process.env.PARSER_CLIENT_CONCURRENCY;
    process.env.PARSER_CLIENT_CONCURRENCY = '1';
    let release!: () => void;
    holdImages = new Promise<void>((resolve) => (release = resolve));
    try {
      // A background job holds this process's only slot.
      const background = parserImages(doc(), 'docx', { maxImages: 1 });
      for (let i = 0; i < 100 && !hits.includes('/images'); i++) {
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(hits).toContain('/images');
      reply = { text: 'now' };
      // A person waiting does not queue behind it.
      const text = await withParserScope({ interactive: true }, () => parserText(doc(), 'docx'));
      expect(text).toBe('now');
      expect(priorities.at(-1)).toBe('interactive');
      expect(priorities[0]).toBe('');
      release();
      await background;
    } finally {
      release?.();
      if (saved === undefined) delete process.env.PARSER_CLIENT_CONCURRENCY;
      else process.env.PARSER_CLIENT_CONCURRENCY = saved;
    }
  });

  it('says busy at once on the interactive path, without waiting it out', async () => {
    reply = { code: 'busy' };
    const started = Date.now();
    const err = await failure(
      withParserScope({ interactive: true }, () => parserText(doc(), 'docx')),
    );
    expect(err).toMatchObject({ code: 'busy', retryable: true, terminal: false });
    expect(hits).toHaveLength(1);
    expect(Date.now() - started).toBeLessThan(1_500);
  });

  it("health: up only when the parser takes this process's token", async () => {
    reply = { health: { auth: 'token', authorized: true } };
    expect((await parserHealth(2_000)).up).toBe(true);
    reply = { health: { auth: 'token', authorized: false } };
    expect((await parserHealth(2_000)).up).toBe(false);
    // A parser that asks no token while this process has one: not recreated
    // with the token yet.
    process.env.PARSER_TOKEN = 'a-token';
    try {
      reply = { health: { auth: 'none', authorized: true } };
      expect((await parserHealth(2_000)).up).toBe(false);
      reply = { health: { auth: 'token', authorized: true } };
      expect((await parserHealth(2_000)).up).toBe(true);
      expect(auths.at(-1)).toBe('Bearer a-token');
    } finally {
      delete process.env.PARSER_TOKEN;
    }
    // A parser from before these fields: as it says.
    reply = { health: {} };
    expect((await parserHealth(2_000)).up).toBe(true);
  });
});
