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
