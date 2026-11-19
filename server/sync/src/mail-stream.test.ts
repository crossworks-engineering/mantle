/**
 * A large message read as a stream (mail-stream.ts): every attachment
 * staged as it is read, an attached email among them, and an attachment the
 * brain refuses named in the note, never dropped silently.
 */
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { BrainError, MessageFault, type Brain } from './brain';
import {
  fitBody,
  notesText,
  parseStreamed,
  stageOne,
  stagerFor,
  failuresFor,
  FAILURES_MAX,
  MESSAGE_GIVE_UP_MS,
  type FailEntry,
  unreadStub,
  type Stager,
} from './mail-stream';
import { shareIdOf } from './outlook';

const CRLF = '\r\n';

function mime(parts: { type: string; name?: string; body: string; b64?: boolean }[]): string {
  const b = 'BOUNDARY-1';
  return [
    'From: Kim <kim@friends.test>',
    'To: me@example.com',
    'Subject: Drawings',
    'Message-ID: <big@friends.test>',
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${b}"`,
    '',
    ...parts.flatMap((p) => [
      `--${b}`,
      `Content-Type: ${p.type}${p.name ? `; name="${p.name}"` : ''}`,
      ...(p.name ? [`Content-Disposition: attachment; filename="${p.name}"`] : []),
      ...(p.b64 ? ['Content-Transfer-Encoding: base64'] : []),
      '',
      p.body,
    ]),
    `--${b}--`,
    '',
  ].join(CRLF);
}

/** A stager that hashes what it is handed, refusing names in `refuse`. */
function fakeStager(refuse: string[] = []) {
  const got: { mime: string; size: number }[] = [];
  const stage: Stager = async (body, type) => {
    const hash = createHash('sha256');
    let size = 0;
    for await (const c of body) {
      hash.update(c as Buffer);
      size += (c as Buffer).length;
    }
    if (refuse.includes(type)) throw new BrainError(413, 'attachment too large');
    got.push({ mime: type, size });
    return { sha256: hash.digest('hex'), size };
  };
  return { stage, got };
}

describe('a large message read as a stream', () => {
  it('stages each attachment, an attached email too, and keeps the body', async () => {
    const pdf = Buffer.alloc(300_000, 7);
    const source = mime([
      { type: 'text/plain; charset=utf-8', body: 'See the drawings.' },
      { type: 'application/pdf', name: 'plan.pdf', body: pdf.toString('base64'), b64: true },
      {
        type: 'message/rfc822',
        name: 'forwarded.eml',
        body: ['From: a@b.test', 'Subject: Old', '', 'Older mail'].join(CRLF),
      },
    ]);
    const { stage, got } = fakeStager();
    const m = await parseStreamed(Readable.from([Buffer.from(source)]), stage);
    expect(m.text?.trim()).toBe('See the drawings.');
    expect(m.attachments.map((a) => [a.filename, a.staged?.size])).toEqual([
      ['plan.pdf', 300_000],
      ['forwarded.eml', expect.any(Number)],
    ]);
    expect(m.attachments.every((a) => !a.contentB64 && a.staged?.sha256.length === 64)).toBe(true);
    expect(got).toHaveLength(2);
    expect(m.notes).toEqual([]);
    expect(m.headers.get('message-id')).toBe('<big@friends.test>');
  });

  it('names an attachment the brain refused in the note, and goes on', async () => {
    const source = mime([
      { type: 'text/plain', body: 'Hi' },
      {
        type: 'video/mp4',
        name: 'huge.mp4',
        body: Buffer.alloc(1000).toString('base64'),
        b64: true,
      },
      {
        type: 'application/pdf',
        name: 'a.pdf',
        body: Buffer.alloc(10).toString('base64'),
        b64: true,
      },
    ]);
    const { stage } = fakeStager(['video/mp4']);
    const m = await parseStreamed(Readable.from([Buffer.from(source)]), stage);
    expect(m.attachments.map((a) => a.filename)).toEqual(['a.pdf']);
    expect(m.notes).toHaveLength(1);
    expect(notesText(m.notes)).toContain('huge.mp4');
  });

  it('stores a body past the inline bound as an attachment of its own', async () => {
    const { stage, got } = fakeStager();
    const html = 'x'.repeat(17 * 1024 * 1024);
    const r = await fitBody(stage, { html });
    expect(r.html).toBeUndefined();
    expect(r.attachments.map((a) => a.filename)).toEqual(['message-body.html']);
    expect(got[0]!.size).toBe(html.length);
    expect(r.text).toContain('stored whole');
  });

  it('turns a sharing link into a Graph share id', () => {
    expect(shareIdOf('https://a.sharepoint.com/x?y=1')).toMatch(/^u![A-Za-z0-9_-]+$/);
  });
});

describe('an attachment whose upload failed', () => {
  const meta = { filename: 'big.bin', mimeType: 'application/octet-stream' };

  it('returns its note at once when the refused stream is already destroyed', async () => {
    const body = Readable.from([Buffer.alloc(10)]);
    const stage: Stager = async (b) => {
      b.destroy();
      await new Promise((r) => setImmediate(r));
      throw new BrainError(413, 'attachment too large');
    };
    const got = await stageOne(stage, body, meta);
    expect(got).toEqual({ note: expect.stringContaining('big.bin') });
  });

  it('throws, never waits, when the source broke part way', async () => {
    const body = new Readable({ read() {} });
    body.on('error', () => {}); // as stagerFor's listener
    const stage: Stager = async (b) => {
      b.destroy(new Error('the Graph body was cut off'));
      await new Promise((r) => setImmediate(r));
      throw new BrainError(0, 'the brain did not answer: aborted');
    };
    await expect(stageOne(stage, body, meta)).rejects.toThrow(/did not answer/);
    expect(body.destroyed).toBe(true);
  });

  it('throws the source error when a refusal came after the source broke', async () => {
    const body = new Readable({ read() {} });
    body.on('error', () => {}); // as stagerFor's listener
    const stage: Stager = async (b) => {
      b.destroy(new Error('socket hang up'));
      await new Promise((r) => setImmediate(r));
      throw new BrainError(413, 'attachment too large');
    };
    await expect(stageOne(stage, body, meta)).rejects.toThrow('socket hang up');
  });

  it('drains the rest of a refused stream that is still open', async () => {
    const body = Readable.from([Buffer.alloc(5), Buffer.alloc(5), Buffer.alloc(5)]);
    const stage: Stager = async () => {
      throw new BrainError(413, 'attachment too large');
    };
    const got = await stageOne(stage, body, meta);
    expect('note' in got).toBe(true);
    expect(body.readableEnded).toBe(true);
  });

  it('goes on past a refused attachment whose stream the upload destroyed', async () => {
    const source = mime([
      { type: 'text/plain', body: 'Hi' },
      {
        type: 'video/mp4',
        name: 'huge.mp4',
        body: Buffer.alloc(200_000).toString('base64'),
        b64: true,
      },
      {
        type: 'application/pdf',
        name: 'a.pdf',
        body: Buffer.alloc(10).toString('base64'),
        b64: true,
      },
    ]);
    const stage: Stager = async (b, type) => {
      if (type === 'video/mp4') {
        b.destroy();
        throw new BrainError(413, 'attachment too large');
      }
      let size = 0;
      for await (const c of b) size += (c as Buffer).length;
      return { sha256: 'a'.repeat(64), size };
    };
    const m = await parseStreamed(Readable.from([Buffer.from(source)]), stage);
    expect(m.attachments.map((a) => a.filename)).toEqual(['a.pdf']);
    expect(m.notes.join()).toContain('huge.mp4');
  });
});

describe('a brain from before streamed attachments', () => {
  it('stops the run with a plain reason, never a skip', async () => {
    const brain = {
      stream: async () => {
        throw new BrainError(404, 'not found');
      },
    } as unknown as Brain;
    const stage = stagerFor(brain, '00000000-0000-4000-8000-000000000001');
    const err = await stage(Readable.from([Buffer.alloc(1)]), 'text/plain').catch((e) => e);
    expect(err).toBeInstanceOf(BrainError);
    expect((err as BrainError).status).toBe(503);
    expect((err as Error).message).toContain('before this release');
  });

  it('keeps a switched-off mailbox as its own 404', async () => {
    const brain = {
      stream: async () => {
        throw new BrainError(404, 'no such mailbox');
      },
    } as unknown as Brain;
    const err = await stagerFor(brain, '00000000-0000-4000-8000-000000000001')(
      Readable.from([Buffer.alloc(1)]),
      'text/plain',
    ).catch((e) => e);
    expect((err as BrainError).status).toBe(404);
  });
});

describe('a message that fails to read', () => {
  const fakeState = () => {
    let kept: Record<string, FailEntry> = {};
    return {
      get kept() {
        return kept;
      },
      msgFails: async () => structuredClone(kept),
      putMsgFails: async (_: string, f: Record<string, FailEntry>) => {
        kept = f;
      },
    };
  };

  it('is tried again, and is last only after three tries over a day', async () => {
    const state = fakeState();
    let clock = 1_000_000;
    const failures = failuresFor(state, 'box', () => clock);
    await failures.record('m1', 'INBOX');
    await failures.record('m1', 'INBOX');
    await failures.record('m1', 'INBOX');
    expect(await failures.pending()).toEqual([{ id: 'm1', folder: 'INBOX', last: false }]);
    clock += MESSAGE_GIVE_UP_MS;
    expect(await failures.pending()).toEqual([{ id: 'm1', folder: 'INBOX', last: true }]);
    await failures.clear('m1');
    expect(state.kept).toEqual({});
    const stub = unreadStub(
      {
        providerMsgId: 'm1',
        fromAddr: 'a@b.test',
        toAddrs: [],
        internalDate: 'x',
        attachments: [],
      },
      new Error('NO [UNAVAILABLE] fetch failed'),
    );
    expect(stub.bodyText).toContain('could not be read');
    expect(stub.bodyText).toContain('UNAVAILABLE');
  });

  it('never lets one go: past the most kept, the run stops', async () => {
    const state = fakeState();
    const failures = failuresFor(state, 'box');
    for (let i = 0; i < FAILURES_MAX; i++) await failures.record(`m${i}`, 'INBOX');
    await expect(failures.record('one-more', 'INBOX')).rejects.toThrow(/run stops/);
    await failures.record('m0', 'INBOX'); // a known one is counted still
    expect(Object.keys(state.kept)).toHaveLength(FAILURES_MAX);
  });
});

describe('a source that broke part way', () => {
  it('is the message failing, never the brain', async () => {
    const brain = {
      stream: async (_p: string, body: ReadableStream<Uint8Array>) => {
        // The upload reads the body; the source breaks under it.
        const reader = body.getReader();
        await reader.read().catch(() => {});
        throw new BrainError(0, 'the brain did not answer: aborted');
      },
    } as unknown as Brain;
    const src = new Readable({ read() {} });
    setImmediate(() => src.destroy(new Error('Graph body terminated')));
    const err = await stagerFor(brain, '00000000-0000-4000-8000-000000000001')(
      src,
      'application/pdf',
    ).catch((e) => e);
    expect(err).toBeInstanceOf(MessageFault);
    expect((err as Error).message).toContain('Graph body terminated');
  });
});
