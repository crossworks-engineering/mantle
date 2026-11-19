/**
 * A large message, read as a stream (Sync service plan M2; docs/email-ingest.md):
 * past MAIL_MESSAGE_MAX_BYTES a message is not held in memory. Its source
 * (IMAP's download, Graph's MIME) streams through MailParser; each
 * attachment streams on to the brain as it is read (POST
 * /api/sidecar/mail/attachment, spooled to disk there) and the message posts
 * naming them (`staged`). Graph's own attachments stream the same way, one
 * by one (outlook.ts). The body text stays in memory; one past
 * MAIL_BODY_INLINE_MAX goes as an attachment of its own.
 *
 * What could not be taken in (the brain refused an attachment as over its
 * cap) is never dropped silently: it is named in a note the message carries
 * at the top of its body text.
 */
import { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';
import { MailParser, type AttachmentStream, type MessageText } from 'mailparser';
import { MAIL_BODY_INLINE_MAX, type WireAttachment, type WireMessage } from '@mantle/email/wire';
import { BrainError, type Brain } from './brain';
import type { State } from './state';

/** Upload one attachment's bytes: what the brain stored. */
export type Stager = (body: Readable, mime: string) => Promise<{ sha256: string; size: number }>;

export function stagerFor(brain: Brain, accountId: string): Stager {
  return async (body, mime) => {
    const ctrl = new AbortController();
    body.once('error', () => ctrl.abort());
    const q = new URLSearchParams({ accountId, mime: mime.slice(0, 255) });
    try {
      return await brain.stream<{ sha256: string; size: number }>(
        `/api/sidecar/mail/attachment?${q}`,
        Readable.toWeb(body) as unknown as ReadableStream<Uint8Array>,
        ctrl.signal,
      );
    } catch (err) {
      // A brain from before streamed attachments (the sidecar rolled
      // first): the run stops with a plain reason, the cursor stays, and
      // the message is taken in once the brain is updated. Never a skip.
      const old =
        err instanceof BrainError &&
        (err.status === 405 || (err.status === 404 && err.message !== 'no such mailbox'));
      if (old) {
        throw new BrainError(
          503,
          'the brain does not take streamed attachments yet (update the brain to this release)',
        );
      }
      throw err;
    }
  };
}

/** The brain refused this one attachment (400, or 413 past its cap): the
 *  message goes on, the attachment named in its note. Any other failure
 *  stops the message, so the run tries it again. */
const refused = (err: unknown) =>
  err instanceof BrainError && (err.status === 400 || err.status === 413);

/** Upload one attachment: its wire form, or a note line when the brain
 *  refused it. The stream is always read to its end. */
export async function stageOne(
  stage: Stager,
  body: Readable,
  meta: { filename: string; mimeType?: string },
): Promise<{ attachment: WireAttachment } | { note: string }> {
  try {
    const staged = await stage(body, meta.mimeType ?? 'application/octet-stream');
    return {
      attachment: {
        filename: meta.filename,
        mimeType: meta.mimeType,
        sizeBytes: staged.size,
        staged,
      },
    };
  } catch (err) {
    // Not a refusal of this one attachment (the source broke part way, the
    // brain failed, a timeout): the message fails, and the run tries it
    // again. The source is let go of at once, never waited on.
    if (!refused(err)) {
      body.destroy();
      throw err;
    }
    // Refused, but the source itself had already broken: that is the error.
    if (body.errored) throw body.errored;
    // Refused (over the brain's cap): what is left of the stream is drained,
    // so the parser goes on. A stream already ended or destroyed has nothing
    // left (its events have fired: waiting on them would hang the lane).
    if (!body.destroyed && !body.readableEnded) {
      body.resume();
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        finished(body).catch(() => undefined),
        new Promise((r) => {
          timer = setTimeout(r, DRAIN_WAIT_MS);
        }),
      ]);
      clearTimeout(timer);
    }
    return { note: `the attachment "${meta.filename}" (${(err as Error).message})` };
  }
}

/** The longest a refused attachment's rest is drained for. */
const DRAIN_WAIT_MS = 5 * 60_000;

/** The body texts, within MAIL_BODY_INLINE_MAX: a larger one goes as an
 *  attachment (`message-body.html` / `.txt`) and the inline text says so. */
export async function fitBody(
  stage: Stager,
  body: { text?: string; html?: string },
): Promise<{ text?: string; html?: string; attachments: WireAttachment[]; notes: string[] }> {
  const size = Buffer.byteLength(body.text ?? '') + Buffer.byteLength(body.html ?? '');
  if (size <= MAIL_BODY_INLINE_MAX) return { ...body, attachments: [], notes: [] };
  const attachments: WireAttachment[] = [];
  const notes: string[] = [];
  for (const [kind, value, mime] of [
    ['html', body.html, 'text/html'],
    ['txt', body.text, 'text/plain'],
  ] as const) {
    if (!value) continue;
    const got = await stageOne(stage, Readable.from([Buffer.from(value, 'utf8')]), {
      filename: `message-body.${kind}`,
      mimeType: mime,
    });
    if ('attachment' in got) attachments.push(got.attachment);
    else notes.push(got.note);
  }
  const head = (body.text ?? '').slice(0, 100_000);
  return {
    text: `(The body of this message is ${Math.round(size / 1048576)} MB: it is stored whole as its message-body attachment.)\n\n${head}`,
    attachments,
    notes,
  };
}

export type StreamedMessage = {
  text?: string;
  html?: string;
  headers: Map<string, unknown>;
  attachments: WireAttachment[];
  /** What could not be taken in. */
  notes: string[];
};

/** Parse a message source as a stream, each attachment staged as it is
 *  read (one at a time: the parser waits for each). */
export function parseStreamed(source: Readable, stage: Stager): Promise<StreamedMessage> {
  return new Promise((resolve, reject) => {
    const parser = new MailParser({ skipHtmlToText: true });
    const out: StreamedMessage = { headers: new Map(), attachments: [], notes: [] };
    let pending: Promise<void> = Promise.resolve();
    let failed = false;
    const fail = (err: unknown) => {
      if (failed) return;
      failed = true;
      source.destroy();
      parser.destroy();
      reject(err instanceof Error ? err : new Error(String(err)));
    };
    parser.on('headers', (h) => {
      out.headers = h as unknown as Map<string, unknown>;
    });
    parser.on('data', (data: AttachmentStream | MessageText) => {
      if (data.type === 'text') {
        if (typeof data.text === 'string') out.text = data.text;
        if (typeof data.html === 'string') out.html = data.html;
        return;
      }
      const att = data;
      const n = out.attachments.length + out.notes.length;
      pending = pending.then(async () => {
        if (failed) {
          att.content.resume();
          att.release?.();
          return;
        }
        try {
          const got = await stageOne(stage, att.content, {
            filename: att.filename ?? `unnamed-${n}`,
            mimeType: att.contentType,
          });
          if ('attachment' in got) out.attachments.push(got.attachment);
          else out.notes.push(got.note);
        } catch (err) {
          fail(err);
        } finally {
          att.release?.();
        }
      });
    });
    parser.on('end', () => {
      void pending.then(() => {
        if (!failed) resolve(out);
      });
    });
    parser.on('error', fail);
    source.on('error', fail);
    source.pipe(parser);
  });
}

/** The note a message carries when something of it was not taken in. */
export function notesText(notes: string[]): string | undefined {
  if (notes.length === 0) return undefined;
  return `(Not all of this message could be taken in: ${notes.join('; ')}. Read it in your mail client.)`;
}

/** After this many runs a message that fails to read (the mail server
 *  answers an error for it every time) is stored with its envelope and a
 *  note saying so, so one message never holds a mailbox's sync for good. */
export const MESSAGE_TRIES = 3;

/** Whether a message that failed to read is now to be stored as a stub
 *  (its tries counted across runs, in the brain). */
export type Tolerate = (providerMsgId: string) => Promise<boolean>;

export function tolerateFor(
  state: Pick<State, 'msgFails' | 'putMsgFails'>,
  mailboxId: string,
): Tolerate {
  return async (id) => {
    const fails = await state.msgFails(mailboxId);
    const n = (fails[id] ?? 0) + 1;
    if (n >= MESSAGE_TRIES) delete fails[id];
    else fails[id] = n;
    const keys = Object.keys(fails);
    for (const k of keys.slice(0, Math.max(0, keys.length - 200))) delete fails[k];
    await state.putMsgFails(mailboxId, fails);
    return n >= MESSAGE_TRIES;
  };
}

/** The stub of a message that could not be read. */
export function unreadStub(base: WireMessage, err: unknown): WireMessage {
  const why = (err instanceof Error ? err.message : String(err)).slice(0, 300);
  return {
    ...base,
    attachments: [],
    bodyText: `(This message could not be read from the mail server in ${MESSAGE_TRIES} runs: ${why}. Read it in your mail client.)`,
  };
}
