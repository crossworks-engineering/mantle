/**
 * A large message read as a stream (mail-stream.ts): every attachment
 * staged as it is read, an attached email among them, and an attachment the
 * brain refuses named in the note, never dropped silently.
 */
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { BrainError } from './brain';
import { fitBody, notesText, parseStreamed, type Stager } from './mail-stream';
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
