/**
 * A job's answer (./answer.ts). What is pinned: the answer arrives whole;
 * and the send settles whatever happens to the connection, so the slot is
 * never held by an answer nobody reads: a connection gone before the
 * answer starts, and one closed in the middle of a large answer.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { sendAnswer } from './answer';
import { JobFailure } from './job-failure';

let server: http.Server | null = null;
let dir: string;

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = null;
  rmSync(dir, { recursive: true, force: true });
});

/** A server whose one route runs `onRequest`; resolves with its URL and the
 *  settle of the send. */
async function serve(
  onRequest: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>,
): Promise<{ url: string; settled: Promise<'settled' | 'threw'> }> {
  let settle!: (v: 'settled' | 'threw') => void;
  const settled = new Promise<'settled' | 'threw'>((r) => (settle = r));
  server = http.createServer((req, res) => {
    onRequest(req, res).then(
      () => settle('settled'),
      () => settle('threw'),
    );
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', () => resolve()));
  return { url: `http://127.0.0.1:${(server!.address() as AddressInfo).port}/`, settled };
}

function within<T>(p: Promise<T>, ms: number): Promise<T | 'hung'> {
  return Promise.race([p, new Promise<'hung'>((r) => setTimeout(() => r('hung'), ms))]);
}

describe('sendAnswer', () => {
  it('sends the answer whole', async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'parser-answer-'));
    writeFileSync(path.join(dir, 'out.json'), JSON.stringify({ text: 'hello' }));
    const { url, settled } = await serve((_req, res) => sendAnswer('text', dir, res));
    const res = await fetch(url);
    expect(await res.json()).toEqual({ text: 'hello' });
    expect(await settled).toBe('settled');
  });

  it('settles when the connection is gone before the answer starts', async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'parser-answer-'));
    writeFileSync(path.join(dir, 'out.json'), JSON.stringify({ text: 'never read' }));
    const { url, settled } = await serve(async (req, res) => {
      // The client went away while the job ran.
      req.socket.destroy();
      await new Promise((r) => setTimeout(r, 50));
      await sendAnswer('text', dir, res);
    });
    await fetch(url).catch(() => null);
    expect(await within(settled, 5_000)).toBe('settled');
  });

  it('settles when the connection closes in the middle of a large answer', async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'parser-answer-'));
    // Far more than the socket buffers hold, so the send is mid-stream.
    writeFileSync(path.join(dir, 'out.bin'), Buffer.alloc(64 * 1024 * 1024, 0x61));
    const { url, settled } = await serve((_req, res) => sendAnswer('thumbnail', dir, res));
    await new Promise<void>((resolve) => {
      const req = http.get(url, (res) => {
        res.once('data', () => {
          // Read one chunk, then hang up.
          req.destroy();
          resolve();
        });
      });
      req.on('error', () => resolve());
    });
    expect(await within(settled, 10_000)).toBe('settled');
  });

  it('no answer from a job that said it succeeded: crashed', async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'parser-answer-'));
    let thrown: unknown = null;
    const { url, settled } = await serve(async (_req, res) => {
      try {
        await sendAnswer('text', dir, res);
      } catch (err) {
        thrown = err;
        res.end();
      }
    });
    await fetch(url);
    await settled;
    expect(thrown).toBeInstanceOf(JobFailure);
    expect((thrown as JobFailure).code).toBe('crashed');
  });
});
