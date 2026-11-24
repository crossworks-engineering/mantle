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
 * Two safety caps, each said as a cut (docs/files.md, "Read in part"): the
 * text of one read (MAIL_TEXT_MAX_CHARS, the parser's answer must fit its
 * wire) and the time of one read (MAIL_READ_MAX_MS, so a huge mailbox ends
 * in part, not killed whole by the job's deadline). The messages past either
 * are counted, not read.
 */
import { decompressRTF } from '@kenjiuno/decompressrtf';
import MsgReader, { type FieldsData } from '@kenjiuno/msgreader';
import { simpleParser, type AddressObject } from 'mailparser';
import { parseAnydocBytes } from '../../../anydoc';
import { htmlToText } from '../../../markup';

/** One attachment, by its name: never read. */
export type MailAttachment = { name: string; type: string; bytes: number | null };

/** One message: its headers, its body as text, and its attachments' names. */
export type MailMessage = {
  from: string;
  to: string;
  cc: string;
  /** ISO 8601 in UTC, or '' when the message has no date we can read. */
  date: string;
  subject: string;
  body: string;
  attachments: MailAttachment[];
};

/** What one read gives: the messages read, how many the file holds, and
 *  why the read stopped before the end (null: it read them all). */
export type MailRead = {
  messages: MailMessage[];
  total: number;
  stopped: 'text' | 'time' | null;
  /** How many of `messages` are read in full: all but a first message
   *  whose body the text cap cut. */
  whole: number;
};

/** The most characters of text one read gives: the text travels in the
 *  parser's answer (96 MB on the wire), as the sheet's read budget. */
export const MAIL_TEXT_MAX_CHARS = 32 * 1024 * 1024;

/** The most time one read takes. The job's deadline is the manifest's
 *  `needs.timeMs` (240 s); a read that stops here keeps what it read. */
export const MAIL_READ_MAX_MS = 150_000;

export const MAIL_EXTS: readonly string[] = ['eml', 'msg', 'mbox'];

const OLE2 = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

/** True for the first bytes of an OLE2 compound file (an Outlook `.msg`). */
export function isOle2(bytes: Buffer): boolean {
  return bytes.length >= 8 && bytes.subarray(0, 8).equals(OLE2);
}

/** Read the messages of a mail file. `ext` is `eml`, `msg` or `mbox`. A
 *  `.msg` that is no OLE2 file is read as an `.eml` (a renamed message);
 *  an OLE2 file that msgreader cannot read throws. */
export async function readMail(
  bytes: Buffer,
  ext: string,
  opts: { maxChars?: number; maxMs?: number; now?: () => number } = {},
): Promise<MailRead> {
  const maxChars = opts.maxChars ?? MAIL_TEXT_MAX_CHARS;
  const maxMs = opts.maxMs ?? MAIL_READ_MAX_MS;
  const now = opts.now ?? Date.now;
  if (ext === 'msg' && isOle2(bytes)) {
    const m = await readMsg(bytes);
    if (m.body.length <= maxChars) return { messages: [m], total: 1, stopped: null, whole: 1 };
    return {
      messages: [{ ...m, body: m.body.slice(0, maxChars) }],
      total: 1,
      stopped: 'text',
      whole: 0,
    };
  }
  const parts = ext === 'mbox' ? splitMbox(bytes) : [bytes];
  const start = now();
  const messages: MailMessage[] = [];
  let chars = 0;
  for (const part of parts) {
    if (messages.length > 0 && now() - start > maxMs) {
      return { messages, total: parts.length, stopped: 'time', whole: messages.length };
    }
    const m = await readEml(part);
    const size = messageChars(m);
    if (chars + size > maxChars) {
      // The first message is kept, its body cut to the budget, so a file of
      // one huge message still gives its headers and the first of its text.
      const whole = messages.length;
      if (whole === 0) {
        messages.push({
          ...m,
          body: m.body.slice(0, Math.max(0, maxChars - (size - m.body.length))),
        });
      }
      return { messages, total: parts.length, stopped: 'text', whole };
    }
    chars += size;
    messages.push(m);
  }
  return { messages, total: parts.length, stopped: null, whole: messages.length };
}

/** The characters a message takes in the text (its headers and body). */
function messageChars(m: MailMessage): number {
  return m.from.length + m.to.length + m.cc.length + m.subject.length + m.body.length + 64;
}

// ─── mbox ──────────────────────────────────────────────────────────────

const FROM_LINE = Buffer.from('\nFrom ');

/**
 * The messages of a mailbox: each starts at a line `From ` (at the start of
 * the file or after a line feed); that line is the mailbox's, not the
 * message's, and is dropped. A body line `>From ` (mboxrd, any number of
 * `>`) loses one `>`. A file that does not start with `From ` is one
 * message (an `.eml` named `.mbox`). An empty file has none.
 */
export function splitMbox(bytes: Buffer): Buffer[] {
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

/** One RFC 822 message. mailparser reads any bytes: a file with no headers
 *  gives a message with empty fields. */
async function readEml(bytes: Buffer): Promise<MailMessage> {
  const mail = await simpleParser(bytes, {
    skipHtmlToText: true,
    skipTextToHtml: true,
    skipTextLinks: true,
    skipImageLinks: true,
    checksumAlgo: false,
  });
  const html = typeof mail.html === 'string' ? mail.html : '';
  const body = (mail.text ?? '').trim() || (html ? htmlToText(html).trim() : '');
  return {
    from: addressText(mail.from),
    to: addressText(mail.to),
    cc: addressText(mail.cc),
    date: isoOf(mail.date),
    subject: mail.subject ?? '',
    body,
    attachments: mail.attachments.map((a, i) => ({
      name: a.filename ?? `attachment-${i + 1}`,
      type: a.contentType ?? '',
      bytes: a.size ?? null,
    })),
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
  const recipients = (kind: 'to' | 'cc') =>
    (f.recipients ?? [])
      .filter((r) => (r.recipType ?? 'to') === kind)
      .map((r) => person(r.name, r.smtpAddress ?? r.email))
      .filter(Boolean)
      .join(', ');
  const body = await msgBody(f);
  return {
    from: person(f.senderName, f.senderSmtpAddress ?? f.senderEmail),
    to: recipients('to'),
    cc: recipients('cc'),
    date: isoOf(dateOf(f.clientSubmitTime ?? f.messageDeliveryTime ?? f.creationTime)),
    subject: f.subject ?? '',
    body,
    attachments: (f.attachments ?? []).map((a, i) => ({
      name: msgAttachmentName(a, i),
      type: a.attachMimeTag ?? (a.innerMsgContent ? 'application/vnd.ms-outlook' : ''),
      bytes: typeof a.contentLength === 'number' ? a.contentLength : null,
    })),
  };
}

function dateOf(s: string | undefined): Date | null {
  return s ? new Date(s) : null;
}

/** The name of a `.msg` attachment: its long file name, its short one, or,
 *  for an embedded message, its display name with `.msg`. */
function msgAttachmentName(a: FieldsData, i: number): string {
  const name = (a.fileName ?? a.fileNameShort ?? '').trim();
  if (name) return name;
  const shown = (a.name ?? '').trim();
  if (a.innerMsgContent) return `${shown || `message-${i + 1}`}.msg`;
  return shown || `attachment-${i + 1}`;
}

async function msgBody(f: FieldsData): Promise<string> {
  const plain = (f.body ?? '').trim();
  if (plain) return plain;
  const html = f.bodyHtml ?? (f.html ? Buffer.from(f.html).toString('utf8') : '');
  if (html.trim()) return htmlToText(html).trim();
  if (f.compressedRtf && f.compressedRtf.length > 0) {
    const rtf = Buffer.from(decompressRTF([...f.compressedRtf]));
    return (await parseAnydocBytes(rtf, 'rtf')).trim();
  }
  return '';
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
      { name: 'Date', type: 'datetime' as const },
      { name: 'Subject', type: 'text' as const },
      { name: 'Attachments', type: 'text' as const },
    ],
    rows: read.messages.map((m, i) => [
      i + 1,
      m.from,
      m.to,
      m.cc,
      m.date || null,
      m.subject,
      m.attachments.map((a) => a.name).join('; '),
    ]),
  };
}
