import type { EmailAccount } from '@mantle/db';

/**
 * Provider-agnostic shape every adapter yields from the cheap "listSince"
 * path. For IMAP this is headers + body-structure only — the body lives
 * inside `fetchFull` once the orchestrator decides to ingest. For Gmail
 * and Graph, body fields may already be populated (the API gives them away
 * for free).
 */
export interface RawMessage {
  providerMsgId: string;
  threadId?: string;
  fromAddr: string;
  fromName?: string;
  toAddrs: string[];
  ccAddrs?: string[];
  bccAddrs?: string[];
  subject?: string;
  snippet?: string;
  bodyText?: string;
  bodyHtml?: string;
  internalDate: Date;
  labels?: string[];
  folder?: string;
  isRead?: boolean;
  isStarred?: boolean;
  sizeBytes?: number;
  hasAttachments: boolean;
  /** Attachment refs from MIME structure (no content yet). */
  attachments: RawAttachmentRef[];
}

export interface RawAttachmentRef {
  /** Provider-specific id used to later fetch the bytes. */
  providerAttachmentId: string;
  filename: string;
  mimeType?: string;
  sizeBytes?: number;
}

/** Same as RawAttachmentRef but with bytes filled in (returned by fetchFull). */
export interface RawAttachment extends RawAttachmentRef {
  content: Buffer;
}

/** What `fetchFull` returns: body + attachments-with-bytes. */
export interface FullMessage {
  bodyText?: string;
  bodyHtml?: string;
  attachments: RawAttachment[];
}

export interface SyncCursor {
  raw: Record<string, unknown>;
}

export interface EmailProvider {
  /**
   * Stream what's new since the cursor. Cheap path: bodies/attachments may
   * be empty for providers (IMAP) that gate full fetches behind another
   * round trip. The orchestrator decides whether to call `fetchFull` based
   * on the sender decision for `message.fromAddr`.
   */
  listSince(
    account: EmailAccount,
    cursor: SyncCursor | undefined,
  ): AsyncIterable<{ message: RawMessage; nextCursor: SyncCursor }>;

  /** Deep fetch for an approved message — fills body + attachment bytes. */
  fetchFull(account: EmailAccount, providerMsgId: string): Promise<FullMessage>;

  /**
   * Stream every header from a specific sender since a given date. Used by
   * the approve-sender backfill path. No cursor — backfills are bounded
   * and one-shot.
   */
  listFromSender(
    account: EmailAccount,
    senderAddress: string,
    since: Date,
  ): AsyncIterable<RawMessage>;
}
