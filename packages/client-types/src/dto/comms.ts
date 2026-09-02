/**
 * @mantle/client-types · comms
 *
 * Calendar feeds, Microsoft drives and the email reading pane.
 *
 * Split out of the 2548-line index.ts on 2026-09-02 (audit, tier 3) with the
 * contents unchanged. index.ts re-exports every one of these, so the package's
 * public surface is byte-identical — only the file a symbol lives in moved.
 */

// ── Calendar ────────────────────────────────────────────────────────────────────

/** A subscribed calendar feed as returned by `GET /api/calendar` — the wire
 *  projection of @mantle/db's `CalendarAccount` row. The sealed `feedUrlEnc`
 *  credential, `ownerId`, and `syncState` are server-only and intentionally
 *  omitted; dates are ISO strings. The route maps its rows to this so the wire
 *  shape and the consuming client can't drift. */
export interface CalendarAccountDTO {
  id: string;
  /** 'ics' (future: 'google' | 'microsoft'). */
  provider: string;
  displayName: string;
  /** Optional UI accent (hex) so multiple calendars are distinguishable. */
  color: string | null;
  enabled: boolean;
  lastEventCount: number | null;
  lastSyncAt: string | null;
  lastSyncError: string | null;
}

// ── Microsoft (SharePoint / OneDrive) ───────────────────────────────────────────

/** A discovered drive as returned by `GET/POST /api/microsoft/accounts/[id]/drives`
 *  — the wire projection of @mantle/db's `MsDrive` row. The Graph `deltaLink`
 *  cursor and `accountId` are server-only and omitted; `lastSyncAt` is an ISO
 *  string. The route maps its rows to this so the shapes can't drift. */
export interface MsDriveDTO {
  id: string;
  /** Graph drive id. */
  driveId: string;
  /** `personal` (OneDrive) | `documentLibrary` (SharePoint) | other. */
  driveType: string;
  name: string;
  /** SharePoint site display name; null for OneDrive. */
  siteName: string | null;
  webUrl: string | null;
  enabled: boolean;
  lastSyncAt: string | null;
  lastError: string | null;
  /** How many scope selections the drive has; 0 = syncing everything. */
  scopeCount: number;
}

/** One scope selection on a drive, as stored/returned by
 *  `GET/PUT /api/microsoft/drives/[id]/scopes`. Folder scopes include the
 *  whole subtree (path prefix); file scopes match that one item. */
export interface MsDriveScopeDTO {
  itemId: string;
  /** After-`root:` path, always starting with `/` (e.g. `/Reports/2026`). */
  path: string;
  isFolder: boolean;
  name: string | null;
}

/** One row of a drive-folder listing from
 *  `GET /api/microsoft/drives/[id]/browse` — the scope picker's navigation
 *  unit. Selection state is client-derived by matching against the scope set. */
export interface MsDriveChildDTO {
  itemId: string;
  name: string;
  isFolder: boolean;
  childCount: number | null;
  size: number | null;
  path: string | null;
  webUrl: string | null;
}

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
