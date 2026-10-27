/**
 * The parser client's typed failures and the per-job count (./parser-client.ts),
 * against a stub of the parser on a loopback port. What is pinned:
 *  - too_large / timeout / crashed: retryable the first time for the same
 *    bytes in a job, terminal the second, and a terminal job is not sent
 *    again;
 *  - the count is per job: the pictures pass failing never makes the text
 *    read terminal;
 *  - failed is neither retryable nor terminal; unavailable (a refused
 *    connection, a wrong token) is retryable and never counted.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PARSER_ERROR_STATUS, type ParserErrorCode } from './parser-wire';
import {
  ParserError,
  isParserUnavailable,
  parserImages,
  parserText,
  resetParserFailures,
} from './parser-client';

type Reply = { code: ParserErrorCode } | { text: string } | { status: number };
let reply: Reply = { text: '' };
const hits: string[] = [];
let server: Server;
let saved: { url?: string; token?: string };

beforeAll(async () => {
  server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      hits.push(req.url ?? '');
      if ('status' in reply) {
        res.writeHead(reply.status).end();
      } else if ('code' in reply) {
        res
          .writeHead(PARSER_ERROR_STATUS[reply.code], { 'content-type': 'application/json' })
          .end(JSON.stringify({ ok: false, error: { code: reply.code, message: reply.code } }));
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
});
