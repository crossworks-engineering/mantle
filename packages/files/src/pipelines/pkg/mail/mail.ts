/**
 * The mail engine of the Reader `mail`: an email file (`.eml`, `.msg`) or a
 * mailbox (`.mbox`) to its messages. Each message gives its headers (From,
 * To, Cc, Date, Subject), its whole body as text, and the names of its
 * attachments. It runs in the parser job `pipelineRun`, as every package
 * does: these bytes are untrusted.
 *
 * - `.eml`: one RFC 822 message, read with mailparser (MIT).
 * - `.mbox`: many RFC 822 messages, split on the `From ` line that starts
 *   each one (mboxrd: a body line `>From ` loses one `>`), each read as an
 *   `.eml`.
 * - `.msg`: an Outlook message (an OLE2 compound file), read with
 *   @kenjiuno/msgreader (Apache-2.0).
 *
 * The body: the plain text part; with none, the HTML part through the
 * markup reader (../../../markup.ts); a `.msg` with neither, its compressed
 * RTF body, unpacked (@kenjiuno/decompressrtf, BSD-2-Clause) and read by
 * anydoc.
 *
 * Attachments are named, never read (the owner's answer Q2, 2026-11-23: the
 * archive rule). A message part that is inline is the message's own text,
 * so a forwarded mail shown inline is read as the body; one sent as an
 * attachment is a name.
 *
 * An attachment's bytes are drained as they are parsed, counted and never
 * kept, so a large attachment costs no memory.
 *
 * Nothing is cut silently (docs/files.md, "Read in part"). Two safety caps
 * end a read early: the bytes of one answer (MAIL_ANSWER_MAX_BYTES, the
 * parser's answer must fit its 96 MB wire) and the time of one read
 * (MAIL_READ_MAX_MS, so a huge mailbox ends in part, not killed whole by the
 * job's deadline). A message of a mailbox that mailparser refuses, or an
 * Outlook RTF body past its bounds, is not read. Each of these is counted:
 * `whole` is the messages read in full, of `total`.
 */
import { decompressRTF } from '@kenjiuno/decompressrtf';
import MsgReader, { type FieldsData } from '@kenjiuno/msgreader';
import { MailParser, type AddressObject, type AttachmentStream } from 'mailparser';
import { parseAnydocBytes } from '../../../anydoc';
import { htmlToText } from '../../../markup';

/** One attachment, by its name: never read. */
export type MailAttachment = { name: string; type: string; bytes: number | null };

/** One message: its headers, its body as text, and its attachments' names. */
export type MailMessage = {
  from: string;
  to: string;
  cc: string;
  bcc: string;
  /** ISO 8601 in UTC, or '' when the message has no date we can read. */
  date: string;
  subject: string;
  body: string;
  attachments: MailAttachment[];
  /** False: the message was not read in full (refused, its body past a
   *  bound, or cut by the answer cap). */
  whole: boolean;
};

/** What one read gives: the messages read, how many the file holds, and
 *  why the read stopped before the end (null: it read them all). */
export type MailRead = {
  messages: MailMessage[];
  total: number;
  stopped: 'text' | 'time' | null;
  /** How many of `messages` are read in full. */
  whole: number;
};

/** The most bytes the messages take in the answer, as JSON in UTF-8 (the
 *  text and the tab both): the answer is at most 96 MB on the wire
 *  (PARSER_ANSWER_MAX_BYTES), so this leaves room to spare. */
export const MAIL_ANSWER_MAX_BYTES = 40 * 1024 * 1024;

/** The most bytes of an Outlook RTF body, packed: it unpacks to at most 8
 *  times that (16 MB). */
export const MSG_RTF_MAX_PACKED_BYTES = 2 * 1024 * 1024;

/** The most time one read takes. The job's deadline is the manifest's
 *  `needs.timeMs` (240 s); a read that stops here keeps what it read. */
export const MAIL_READ_MAX_MS = 150_000;

const OLE2 = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

/** True for the first bytes of an OLE2 compound file (an Outlook `.msg`). */
export function isOle2(bytes: Buffer): boolean {
  return bytes.length >= 8 && bytes.subarray(0, 8).equals(OLE2);
}

/** Read the messages of a mail file. `ext` is `eml`, `msg` or `mbox`. An
 *  OLE2 file is read as an Outlook message whatever its name, and any
 *  other bytes as RFC 822 (a renamed message); an OLE2 file that msgreader
 *  cannot read throws, as a single message mailparser refuses does. */
export async function readMail(
  bytes: Buffer,
  ext: string,
  opts: { maxBytes?: number; maxMs?: number; now?: () => number } = {},
): Promise<MailRead> {
  const maxBytes = opts.maxBytes ?? MAIL_ANSWER_MAX_BYTES;
  const maxMs = opts.maxMs ?? MAIL_READ_MAX_MS;
  const now = opts.now ?? Date.now;
  const ole = isOle2(bytes);
  const parts = ole ? [bytes] : ext === 'mbox' ? splitMbox(bytes) : [bytes];
  const start = now();
  const messages: MailMessage[] = [];
  let used = 0;
  const done = (stopped: MailRead['stopped']): MailRead => ({
    messages,
    total: parts.length,
    stopped,
    whole: messages.filter((m) => m.whole).length,
  });
  for (const part of parts) {
    if (messages.length > 0 && now() - start > maxMs) return done('time');
    // One bad message of a mailbox does not cost the others: it is counted
    // as not read. A file of one message throws, and gets its word.
    const m = ole ? await readMsg(part) : await readEml(part, parts.length > 1);
    // A body past the budget in characters is past it in bytes: never
    // measured whole (a string that large may not stringify).
    const size = m.body.length > maxBytes ? Infinity : answerBytes(m);
    if (used + size > maxBytes) {
      // The first message is kept, its body cut to the budget, so a file of
      // one huge message still gives its headers and the head of its text.
      if (messages.length === 0) messages.push(cutToFit(m, maxBytes));
      return done('text');
    }
    used += size;
    messages.push(m);
  }
  return done(null);
}

/** The bytes a message takes in the answer: its text and its row, as JSON
 *  in UTF-8 (escapes counted). */
function answerBytes(m: MailMessage): number {
  return Buffer.byteLength(JSON.stringify([messageText(m), mailRow(m, 0)]));
}

/** The message with its body cut until it fits `maxBytes`: first to
 *  `maxBytes` characters (no string past the budget is measured), then by
 *  the share that is over, a few passes at most. The headers fit: each
 *  header block is at most 1 MB (mailparser) and each attachment name at
 *  most NAME_MAX_CHARS. */
function cutToFit(m: MailMessage, maxBytes: number): MailMessage {
  let body = m.body.slice(0, maxBytes);
  for (let size = answerBytes({ ...m, body }); size > maxBytes && body.length > 0;) {
    body = body.slice(0, Math.floor((body.length * maxBytes) / size) - 1);
    size = answerBytes({ ...m, body });
  }
  return { ...m, body, whole: false };
}

/** The most characters of an attachment's name: past any file system's
 *  name length, so only a made-up name is ever cut. */
const NAME_MAX_CHARS = 255;

// ─── mbox ──────────────────────────────────────────────────────────────

const FROM_LINE = Buffer.from('\nFrom ');
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

/**
 * The messages of a mailbox: each starts at a line `From ` (at the start of
 * the file or after a line feed); that line is the mailbox's, not the
 * message's, and is dropped. A body line `>From ` (mboxrd, any number of
 * `>`) loses one `>`. A file that does not start with `From ` is one
 * message (an `.eml` named `.mbox`). An empty file has none.
 */
export function splitMbox(raw: Buffer): Buffer[] {
  // A byte order mark and blank lines before the first `From ` are no message.
  let lead = raw.subarray(0, 3).equals(BOM) ? 3 : 0;
  while (lead < raw.length && (raw[lead] === 0x0a || raw[lead] === 0x0d || raw[lead] === 0x20))
    lead += 1;
  const bytes = raw.subarray(lead);
  if (bytes.length === 0) return [];
  if (!bytes.subarray(0, 5).equals(FROM_LINE.subarray(1))) return [bytes];
  const starts: number[] = [0];
  for (let at = bytes.indexOf(FROM_LINE); at !== -1; at = bytes.indexOf(FROM_LINE, at + 1)) {
    starts.push(at + 1);
  }
  const out: Buffer[] = [];
  for (const [i, s] of starts.entries()) {
    const end = i + 1 < starts.length ? starts[i + 1]! : bytes.length;
    const lineEnd = bytes.indexOf(0x0a, s);
    const body =
      lineEnd === -1 || lineEnd >= end ? Buffer.alloc(0) : bytes.subarray(lineEnd + 1, end);
    out.push(unescapeFromLines(body));
  }
  return out;
}

/** mboxrd: `>From `, `>>From ` ... at a line start lose one `>`. Latin-1
 *  maps each byte to one character and back, so the bytes are kept. */
function unescapeFromLines(body: Buffer): Buffer {
  if (body.indexOf('>From ') === -1) return body;
  return Buffer.from(body.toString('latin1').replace(/^>(>*From )/gm, '$1'), 'latin1');
}

// ─── eml ───────────────────────────────────────────────────────────────

const addressText = (a: AddressObject | AddressObject[] | undefined): string =>
  (Array.isArray(a) ? a : a ? [a] : []).map((x) => x.text).join(', ');

const isoOf = (d: Date | undefined | null): string =>
  d instanceof Date && !Number.isNaN(d.getTime()) ? d.toISOString() : '';

/** One RFC 822 message, read as a stream: each attachment's bytes are
 *  drained and counted, never kept. mailparser reads any bytes (a file with
 *  no headers gives empty fields); it refuses a message past its own bounds
 *  (1,000 parts, a header block past 1 MB). Then a file of one message
 *  throws; a message of a mailbox (`lenient`) keeps what was read of it, its
 *  headers and attachment names, and counts as not read in full, so one bad
 *  message does not cost the others. */
async function readEml(bytes: Buffer, lenient: boolean): Promise<MailMessage> {
  const parser = new MailParser({
    skipHtmlToText: true,
    skipTextToHtml: true,
    skipTextLinks: true,
    skipImageLinks: true,
    checksumAlgo: false,
  });
  const attachments: MailAttachment[] = [];
  let text = '';
  let html = '';
  const read = new Promise<void>((resolve, reject) => {
    parser.on(
      'data',
      (d: AttachmentStream | { type: 'text'; text?: string; html?: string | false }) => {
        if (d.type === 'text') {
          text = d.text ?? '';
          html = typeof d.html === 'string' ? d.html : '';
          return;
        }
        const at = attachments.length;
        const a: MailAttachment = {
          name: (d.filename ?? `attachment-${at + 1}`).slice(0, NAME_MAX_CHARS),
          type: d.contentType ?? '',
          bytes: 0,
        };
        attachments.push(a);
        d.content.on('data', (c: Buffer) => (a.bytes! += c.length));
        d.content.on('end', () => d.release?.());
        d.content.on('error', reject);
      },
    );
    parser.on('end', () => resolve());
    parser.on('error', reject);
    parser.end(bytes);
  });
  let whole = true;
  try {
    await read;
  } catch (err) {
    if (!lenient) throw err;
    whole = false;
  }
  const body = text.trim() || (html ? htmlToText(html).trim() : '');
  return {
    from: addressText(parser.from),
    to: addressText(parser.to),
    cc: addressText(parser.cc),
    bcc: addressText(parser.bcc),
    date: isoOf(parser.date),
    subject: parser.subject ?? '',
    body: whole
      ? body
      : [body, '[The rest of this message could not be read.]'].filter(Boolean).join('\n\n'),
    attachments,
    whole,
  };
}

// ─── msg ───────────────────────────────────────────────────────────────

/** `Name <address>`, the name alone, or the address alone. */
function person(name: string | undefined, address: string | undefined): string {
  const n = (name ?? '').trim();
  const a = (address ?? '').trim();
  if (n && a && n !== a) return `${n} <${a}>`;
  return n || a;
}

/** An Outlook message. Its body: plain, else HTML, else compressed RTF. */
async function readMsg(bytes: Buffer): Promise<MailMessage> {
  // A view of these bytes only: a Buffer may be a slice of a larger memory.
  const reader = new MsgReader(new DataView(bytes.buffer, bytes.byteOffset, bytes.length));
  const f = reader.getFileData() as FieldsData & { error?: string };
  if (f.error) throw new Error(`The Outlook message could not be read: ${f.error}`);
  const recipients = (kind: 'to' | 'cc' | 'bcc') =>
    (f.recipients ?? [])
      .filter((r) => (r.recipType ?? 'to') === kind)
      .map((r) => person(r.name, r.smtpAddress ?? r.email))
      .filter(Boolean)
      .join(', ');
  const { body, whole } = await msgBody(f);
  return {
    from: person(f.senderName, f.senderSmtpAddress ?? f.senderEmail),
    to: recipients('to'),
    cc: recipients('cc'),
    bcc: recipients('bcc'),
    date: isoOf(dateOf(f.clientSubmitTime ?? f.messageDeliveryTime ?? f.creationTime)),
    subject: f.subject ?? '',
    body,
    attachments: (f.attachments ?? []).map((a, i) => ({
      name: msgAttachmentName(a, i),
      type: a.attachMimeTag ?? (a.innerMsgContent ? 'application/vnd.ms-outlook' : ''),
      bytes: typeof a.contentLength === 'number' ? a.contentLength : null,
    })),
    whole,
  };
}

function dateOf(s: string | undefined): Date | null {
  return s ? new Date(s) : null;
}

/** The name of a `.msg` attachment: its long file name, its short one, or,
 *  for an embedded message, its display name with `.msg`. */
function msgAttachmentName(a: FieldsData, i: number): string {
  return msgName(a, i).slice(0, NAME_MAX_CHARS);
}

function msgName(a: FieldsData, i: number): string {
  const name = (a.fileName ?? a.fileNameShort ?? '').trim();
  if (name) return name;
  const shown = (a.name ?? '').trim();
  if (a.innerMsgContent) return `${shown || `message-${i + 1}`}.msg`;
  return shown || `attachment-${i + 1}`;
}

/** The body of an Outlook message, and whether it was read. An RTF body is
 *  unpacked only when its header's size is within its bytes (the unpacker
 *  reads to that size) and it is at most MSG_RTF_MAX_PACKED_BYTES (it
 *  unpacks to at most 8 times that). */
async function msgBody(f: FieldsData): Promise<{ body: string; whole: boolean }> {
  const plain = (f.body ?? '').trim();
  if (plain) return { body: plain, whole: true };
  const html = f.bodyHtml ?? (f.html ? Buffer.from(f.html).toString('utf8') : '');
  if (html.trim()) return { body: htmlToText(html).trim(), whole: true };
  const packed = f.compressedRtf;
  if (!packed || packed.length === 0) return { body: '', whole: true };
  const head = Buffer.from(packed.buffer, packed.byteOffset, packed.length);
  const fits =
    head.length >= 16 &&
    head.readUInt32LE(0) + 4 <= head.length &&
    head.length <= MSG_RTF_MAX_PACKED_BYTES;
  if (!fits) return { body: '', whole: false };
  try {
    const rtf = Buffer.from(decompressRTF(packed as unknown as number[]));
    return { body: (await parseAnydocBytes(rtf, 'rtf')).trim(), whole: true };
  } catch {
    return { body: '', whole: false };
  }
}

// ─── text and tab ──────────────────────────────────────────────────────

const kb = (n: number): string =>
  n < 1024
    ? `${n} bytes`
    : n < 1024 * 1024
      ? `${Math.round(n / 1024)} KB`
      : `${(n / (1024 * 1024)).toFixed(1)} MB`;

/** One attachment as a line of the text: name, type and size. */
function attachmentLine(a: MailAttachment): string {
  const facts = [a.type, a.bytes !== null ? kb(a.bytes) : ''].filter(Boolean).join(', ');
  return `- ${a.name}${facts ? ` (${facts})` : ''}`;
}

/** The text of one message: the header lines, a blank line, the body, and
 *  the attachments' names. */
function messageText(m: MailMessage): string {
  const head = [
    ['From', m.from],
    ['To', m.to],
    ['Cc', m.cc],
    ['Bcc', m.bcc],
    ['Date', m.date],
    ['Subject', m.subject],
  ]
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}: ${v}`);
  const parts = [head.join('\n'), m.body];
  if (m.attachments.length > 0) {
    parts.push(
      `Attachments (named only, not read):\n${m.attachments.map(attachmentLine).join('\n')}`,
    );
  }
  return parts.filter(Boolean).join('\n\n');
}

/** The file's text: one message as it is; a mailbox with a heading
 *  `## Message N` before each, so a passage names its message. */
export function mailText(read: MailRead, ext: string): string {
  if (ext !== 'mbox') return read.messages.map(messageText).join('\n\n');
  return read.messages.map((m, i) => `## Message ${i + 1}\n\n${messageText(m)}`).join('\n\n');
}

/** One row of the tab Mail. */
function mailRow(m: MailMessage, i: number) {
  return [
    i + 1,
    m.from,
    m.to,
    m.cc,
    m.bcc,
    m.date || null,
    m.subject,
    m.attachments.map((a) => a.name).join('; '),
  ];
}

/** The tab Mail: one row a message, its headers and its attachments'
 *  names. The bodies are the file's text (search), not cells. */
export function mailTab(read: MailRead) {
  return {
    name: 'Mail',
    columns: [
      { name: 'Message', type: 'number' as const },
      { name: 'From', type: 'text' as const },
      { name: 'To', type: 'text' as const },
      { name: 'Cc', type: 'text' as const },
      { name: 'Bcc', type: 'text' as const },
      { name: 'Date', type: 'datetime' as const },
      { name: 'Subject', type: 'text' as const },
      { name: 'Attachments', type: 'text' as const },
    ],
    rows: read.messages.map(mailRow),
  };
}
