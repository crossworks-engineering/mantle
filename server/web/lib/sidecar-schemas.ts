/**
 * The bodies the Sync sidecar posts to /api/sidecar/* (lib/sidecar.ts), as
 * zod schemas over the wire types of @mantle/email/wire. A bound on every
 * list and text, so a body the ceiling lets through stays small to judge.
 */
import { z } from 'zod';
import { MAIL_GATE_BATCH_MAX, WIRE_LIMITS as L } from '@mantle/email/wire';
import { SERVICE_STATE_KEY_RE } from '@mantle/db';

const id = z.string().min(1).max(L.id);
const addr = z.string().max(L.address);
const text = (n: number) => z.string().max(n);

export const StateKey = z.string().regex(SERVICE_STATE_KEY_RE, 'bad key');

export const MailboxBody = z.object({
  address: z.string().email().max(320),
  displayName: text(200).nullish(),
  enabled: z.boolean().optional(),
  /** Where its mail comes from: an IMAP mailbox (default) or a Microsoft
   *  account's Outlook inbox (Sync plan M3). */
  provider: z.enum(['imap', 'microsoft']).optional(),
  /** An Outlook inbox's mail lands under its account's branch. */
  branchPath: z
    .string()
    .regex(/^[a-z0-9_]{1,64}(\.[a-z0-9_]{1,64}){1,7}$/)
    .optional(),
});

export const Envelope = z.object({
  providerMsgId: id,
  rfcMessageId: text(L.messageId).optional(),
  fromAddr: addr,
  inReplyTo: text(L.messageId).optional(),
  references: text(L.references).optional(),
  clientCodeHeader: z.boolean().optional(),
});

export const GateBody = z.object({
  accountId: z.string().uuid(),
  envelopes: z.array(Envelope).max(MAIL_GATE_BATCH_MAX),
});

const DELIVERY_KINDS = ['direct', 'list', 'automated', 'marketing'] as const;

export const WireMessageBody = Envelope.extend({
  threadId: text(L.id).optional(),
  fromName: text(L.name).optional(),
  toAddrs: z.array(addr).max(L.addresses),
  ccAddrs: z.array(addr).max(L.addresses).optional(),
  bccAddrs: z.array(addr).max(L.addresses).optional(),
  subject: text(L.subject).optional(),
  snippet: text(L.subject).optional(),
  internalDate: z.string().max(64),
  labels: z.array(text(L.label)).max(L.labels).optional(),
  folder: text(L.folder).optional(),
  isRead: z.boolean().optional(),
  isStarred: z.boolean().optional(),
  sizeBytes: z.number().int().nonnegative().optional(),
  deliveryKind: z.enum(DELIVERY_KINDS).optional(),
  bodyText: z.string().optional(),
  bodyHtml: z.string().optional(),
  attachments: z
    .array(
      z.object({
        filename: text(L.filename),
        mimeType: text(L.mimeType).optional(),
        sizeBytes: z.number().int().nonnegative().optional(),
        contentB64: z.string(),
      }),
    )
    .max(L.attachments),
  clientCodeMail: z.boolean().optional(),
});

export const IngestBody = z.object({
  accountId: z.string().uuid(),
  message: WireMessageBody,
});

export const RunBody = z.object({
  accountId: z.string().uuid(),
  startedAt: z.string().max(64).optional(),
  scanned: z.number().int().nonnegative(),
  ingested: z.number().int().nonnegative(),
  error: text(2000).optional(),
});

/** The most events one feed may hold (the sidecar stops there, in the feed's
 *  own order). */
export const FEED_EVENTS_MAX = 5000;

export const FeedEventsBody = z.object({
  /** The feed's id: its events carry it as `data.external_account_id`. */
  feedId: z.string().uuid(),
  /** The feed's name, its events' tag. */
  name: text(200),
  source: z.enum(['ics']),
  /** The feed's complete current set: an event stored before and missing
   *  here is removed. An empty list removes every event of the feed. */
  events: z
    .array(
      z.object({
        uid: text(1000).min(1),
        title: text(1000),
        startsAt: text(64),
        endsAt: text(64).nullish(),
        allDay: z.boolean().optional(),
        location: text(1000).nullish(),
        description: text(20_000).optional(),
        timezone: text(64).optional(),
      }),
    )
    .max(FEED_EVENTS_MAX),
});

export const UnknownSendersBody = z.object({
  addresses: z.array(addr).max(1000),
});

export const AddContactBody = z.object({
  address: z.string().email().max(320),
  name: text(200).optional(),
});

// ── Files (Sync service plan M3; lib/sidecar-files.ts) ─────────────────────
const source = z.string().min(1).max(200);
const itemId = z.string().min(1).max(400);
const hash = z.string().max(200).nullable();
const size = z.number().int().nonnegative().nullable();
const modTime = z.coerce.date().nullable();

/** POST /api/sidecar/files: what a streamed file is, in its query. */
export const FileQuery = z.object({
  source,
  item: itemId,
  path: z.string().max(600),
  name: z.string().min(1).max(400),
  mime: z.string().max(200).optional(),
  hash: z.string().max(200).optional(),
  size: z.coerce.number().int().nonnegative().optional(),
  mod: z.coerce.date().optional(),
});

export const FileRelinkBody = z.object({
  source,
  items: z.array(z.object({ itemId, hash, size, modTime })).max(2000),
});

export const FileRemoveBody = z.object({ source, itemIds: z.array(itemId).max(2000) });

export const FileForgetBody = z.object({ source });
