/**
 * A made-up Outlook message (.msg) for the tests: an OLE2 compound file
 * written by msgreader's own writer (its `burn`), with the property streams
 * of [MS-OXMSG] that a reader needs. No client file, nothing downloaded.
 *
 * Root: the subject, sender, body (plain, HTML or compressed RTF) as
 * `__substg1.0_<tag><type>` streams, and the submit time in the root
 * property stream. Each recipient and attachment is a storage of its own,
 * with its strings and (for a recipient) its type in its property stream.
 */
import { burn, type Entry } from '@kenjiuno/msgreader/lib/Burner';

const DIRECTORY = 1;
const DOCUMENT = 2;
const ROOT = 5;

export type MadeUpMsg = {
  subject?: string;
  senderName?: string;
  senderSmtp?: string;
  body?: string;
  bodyHtml?: string;
  /** An RTF body, stored as compressed RTF of the uncompressed kind (MELA). */
  rtf?: string;
  /** A made-up size in the RTF header, past the bytes it holds. */
  rtfHeaderSize?: number;
  /** Unix ms. */
  submitted?: number;
  recipients?: { name: string; smtp: string; type: 'to' | 'cc' | 'bcc' }[];
  attachments?: { name: string; mime?: string; data: Buffer }[];
};

const utf16 = (s: string) => Buffer.from(s, 'utf16le');

/** One fixed-length property of a property stream: tag, flags, 8 bytes. */
function prop(tag: number, value: Buffer): Buffer {
  const b = Buffer.alloc(16);
  b.writeUInt32LE(tag >>> 0, 0);
  b.writeUInt32LE(0x6, 4); // readable, writable
  value.copy(b, 8, 0, 8);
  return b;
}

function int32(n: number): Buffer {
  const b = Buffer.alloc(8);
  b.writeInt32LE(n, 0);
  return b;
}

function fileTime(ms: number): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(ms) * 10_000n + 116_444_736_000_000_000n, 0);
  return b;
}

/** Compressed RTF of the uncompressed kind: the 16-byte header, then the
 *  RTF as it is. */
function melaRtf(rtf: string, claimed?: number): Buffer {
  const raw = Buffer.from(rtf, 'latin1');
  const head = Buffer.alloc(16);
  head.writeUInt32LE(claimed ?? raw.length + 12, 0);
  head.writeUInt32LE(raw.length, 4);
  head.writeUInt32LE(0x414c454d, 8);
  head.writeUInt32LE(0, 12);
  return Buffer.concat([head, raw]);
}

const name8 = (n: number) => n.toString(16).toUpperCase().padStart(8, '0');

export function madeUpMsg(m: MadeUpMsg): Buffer {
  const entries: Entry[] = [{ name: 'Root Entry', type: ROOT, children: [], length: 0 }];
  const add = (parent: number, entry: Entry): number => {
    entries.push(entry);
    const at = entries.length - 1;
    entries[parent]!.children!.push(at);
    return at;
  };
  const stream = (parent: number, name: string, data: Uint8Array) =>
    add(parent, {
      name,
      type: DOCUMENT,
      length: data.length,
      // A copy: a small Buffer shares a pool, and the writer reads the
      // whole of its memory.
      binaryProvider: () => new Uint8Array(data),
    });
  const str = (parent: number, tag: string, s: string | undefined) => {
    if (s !== undefined) stream(parent, `__substg1.0_${tag}001F`, utf16(s));
  };

  str(0, '0037', m.subject);
  str(0, '0C1A', m.senderName);
  str(0, '5D01', m.senderSmtp);
  str(0, '1000', m.body);
  str(0, '1013', m.bodyHtml);
  if (m.rtf !== undefined) stream(0, '__substg1.0_10090102', melaRtf(m.rtf, m.rtfHeaderSize));
  const rootProps: Buffer[] = [Buffer.alloc(32)];
  if (m.submitted !== undefined) rootProps.push(prop(0x00390040, fileTime(m.submitted)));
  stream(0, '__properties_version1.0', Buffer.concat(rootProps));

  for (const [i, r] of (m.recipients ?? []).entries()) {
    const dir = add(0, {
      name: `__recip_version1.0_#${name8(i)}`,
      type: DIRECTORY,
      children: [],
      length: 0,
    });
    str(dir, '3001', r.name);
    str(dir, '39FE', r.smtp);
    const type = prop(0x0c150003, int32(r.type === 'bcc' ? 3 : r.type === 'cc' ? 2 : 1));
    stream(dir, '__properties_version1.0', Buffer.concat([Buffer.alloc(8), type]));
  }
  for (const [i, a] of (m.attachments ?? []).entries()) {
    const dir = add(0, {
      name: `__attach_version1.0_#${name8(i)}`,
      type: DIRECTORY,
      children: [],
      length: 0,
    });
    str(dir, '3707', a.name);
    str(dir, '370E', a.mime);
    stream(dir, '__substg1.0_37010102', a.data);
    stream(dir, '__properties_version1.0', Buffer.alloc(8));
  }
  return Buffer.from(burn(entries));
}
