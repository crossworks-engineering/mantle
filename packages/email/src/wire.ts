/**
 * What crosses between the Sync sidecar and the brain for mail (Sync service
 * plan M2; docs/email-ingest.md). Pure: no database, no network, so the
 * sidecar imports it (`@mantle/email/wire`) without the brain's stack.
 *
 * The sidecar reads a mailbox (IMAP), asks the brain which messages it
 * wants (`/api/sidecar/mail/gate`: the contacts gate, Message-ID dedup, the
 * client-code filter), fetches those only, and posts each as a WireMessage
 * (`/api/sidecar/mail/ingest`). The brain stores it as the old sync did.
 */
import type { DeliveryKind } from './classify';

/** The most envelopes one gate call takes. */
export const MAIL_GATE_BATCH_MAX = 200;
/** The largest message the sidecar posts (bodies plus attachment bytes,
 *  before base64). A bigger message is skipped by the sidecar, as the old
 *  sync skipped one over its IMAP fetch cap. */
export const MAIL_MESSAGE_MAX_BYTES = 40 * 1024 * 1024;
/** The ingest route's body ceiling: the message above in base64, plus the
 *  JSON around it. */
export const MAIL_INGEST_BODY_BYTES = 64 * 1024 * 1024;

/** One message's envelope, as the gate needs it. */
export type WireEnvelope = {
  providerMsgId: string;
  rfcMessageId?: string;
  fromAddr: string;
  inReplyTo?: string;
  references?: string;
  clientCodeHeader?: boolean;
};

export type WireAttachment = {
  filename: string;
  mimeType?: string;
  sizeBytes?: number;
  /** The bytes, base64. */
  contentB64: string;
};

/** One allowed message, fetched in full. The old RawMessage plus the
 *  FullMessage, with dates as ISO strings and bytes as base64. */
export type WireMessage = WireEnvelope & {
  threadId?: string;
  fromName?: string;
  toAddrs: string[];
  ccAddrs?: string[];
  bccAddrs?: string[];
  subject?: string;
  snippet?: string;
  internalDate: string;
  labels?: string[];
  folder?: string;
  isRead?: boolean;
  isStarred?: boolean;
  sizeBytes?: number;
  deliveryKind?: DeliveryKind;
  bodyText?: string;
  bodyHtml?: string;
  attachments: WireAttachment[];
  /** The full message's headers show a client sign-in code mail. */
  clientCodeMail?: boolean;
};

/** A run of one account, as the sidecar reports it. */
export type WireRun = {
  /** When the run started (ISO); the brain stamps its end. */
  startedAt?: string;
  scanned: number;
  ingested: number;
  /** Set when the run failed; the text the account's status shows. */
  error?: string;
};

/** The bound of each field the brain takes (its schema, server/web
 *  lib/sidecar-schemas.ts). The sidecar clips CONTENT to them before it posts
 *  (clipEnvelope, clipMessage), so one odd message from anyone can never
 *  make a batch a 400 and stop a mailbox. An IDENTITY field is never clipped
 *  (a cut sender could pass another domain's contact, a cut Message-ID could
 *  match another message): a message whose sender or id is over its bound
 *  is never fetched at all (envelopeFits), and an over-long Message-ID is
 *  left out. */
export const WIRE_LIMITS = {
  id: 500,
  messageId: 998,
  references: 16_000,
  address: 320,
  addresses: 1000,
  name: 500,
  subject: 10_000,
  labels: 200,
  label: 500,
  folder: 1000,
  attachments: 500,
  filename: 1000,
  mimeType: 255,
} as const;

const cut = (s: string | undefined, n: number) => (s === undefined ? undefined : s.slice(0, n));
const cutList = (l: string[] | undefined, n: number, each: number) =>
  l === undefined ? undefined : l.slice(0, n).map((s) => s.slice(0, each));

/** Whether an envelope's identity fits the brain's bounds: its sender and
 *  its id. One that does not is skipped, never fetched. */
export function envelopeFits(e: Pick<WireEnvelope, 'providerMsgId' | 'fromAddr'>): boolean {
  return e.fromAddr.length <= WIRE_LIMITS.address && e.providerMsgId.length <= WIRE_LIMITS.id;
}

/** An envelope within WIRE_LIMITS (call envelopeFits first: the sender and
 *  the id pass as they are). A Message-ID over its bound is left out, not
 *  cut. The caller has already judged the client-code headers on the whole
 *  values (touchesClientCodeMail), so cutting References loses nothing. */
export function clipEnvelope(e: WireEnvelope): WireEnvelope {
  const L = WIRE_LIMITS;
  const id = (v: string | undefined) => (v !== undefined && v.length > L.messageId ? undefined : v);
  return {
    providerMsgId: e.providerMsgId,
    rfcMessageId: id(e.rfcMessageId),
    fromAddr: e.fromAddr,
    inReplyTo: id(e.inReplyTo),
    references: cut(e.references, L.references),
    clientCodeHeader: e.clientCodeHeader,
  };
}

/** A message within WIRE_LIMITS. */
export function clipMessage(m: WireMessage): WireMessage {
  const L = WIRE_LIMITS;
  return {
    ...m,
    ...clipEnvelope(m),
    threadId: cut(m.threadId, L.id),
    fromName: cut(m.fromName, L.name),
    toAddrs: cutList(m.toAddrs, L.addresses, L.address)!,
    ccAddrs: cutList(m.ccAddrs, L.addresses, L.address),
    bccAddrs: cutList(m.bccAddrs, L.addresses, L.address),
    subject: cut(m.subject, L.subject),
    snippet: cut(m.snippet, L.subject),
    labels: cutList(m.labels, L.labels, L.label),
    folder: cut(m.folder, L.folder),
    attachments: m.attachments.slice(0, L.attachments).map((a) => ({
      ...a,
      filename: a.filename.slice(0, L.filename),
      mimeType: cut(a.mimeType, L.mimeType),
    })),
  };
}
