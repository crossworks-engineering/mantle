/**
 * @mantle/client-types · comms
 *
 * Calendar feeds, Microsoft drives and the email reading pane.
 *
 * Split out of the 2548-line index.ts on 2026-09-02 (audit, tier 3) with the
 * contents unchanged. index.ts re-exports every one of these, so the package's
 * public surface is byte-identical — only the file a symbol lives in moved.
 */

// ── Email (inbox reading pane) ──────────────────────────────────────────────────

/** One message as returned by `GET /api/email/messages/[id]` — the wire
 *  projection of @mantle/db's `Email` row, trimmed to what the reading pane
 *  renders. Server-only/sensitive columns are dropped: the raw `bodyHtml` (it's
 *  sanitized server-side into `MessageDetailDTO.bodyHtmlSafe` and must never
 *  cross the wire untrusted), plus account/node/provider ids, labels, snippet,
 *  etc. `internalDate` is an ISO string. */
export interface EmailDTO {
  id: string;
  subject: string | null;
  fromAddr: string;
  fromName: string | null;
  toAddrs: string[];
  ccAddrs: string[];
  internalDate: string;
  folder: string | null;
  isRead: boolean;
  isStarred: boolean;
  bodyText: string | null;
}

/** One attachment row returned with a message. */
export interface EmailAttachmentDTO {
  id: string;
  filename: string;
  mimeType: string | null;
  sizeBytes: number | null;
}

/** `GET /api/email/messages/[id]` — a message, its attachments, and the
 *  server-sanitized HTML body (the raw `bodyHtml` never crosses the wire). */
export interface MessageDetailDTO {
  email: EmailDTO;
  attachments: EmailAttachmentDTO[];
  bodyHtmlSafe: string | null;
}
