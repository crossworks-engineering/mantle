/**
 * The bodies the Sync sidecar posts to /api/sidecar/* (lib/sidecar.ts), as
 * zod schemas over the wire types of @mantle/email/wire. A bound on every
 * list and text, so a body the ceiling lets through stays small to judge.
 */
import { z } from 'zod';
import { MAIL_GATE_BATCH_MAX } from '@mantle/email/wire';
import { SERVICE_STATE_KEY_RE } from '@mantle/db';

const id = z.string().min(1).max(500);
const addr = z.string().max(320);
const text = (n: number) => z.string().max(n);

export const StateKey = z.string().regex(SERVICE_STATE_KEY_RE, 'bad key');

export const MailboxBody = z.object({
  address: z.string().email().max(320),
  displayName: text(200).nullish(),
  enabled: z.boolean().optional(),
});

export const Envelope = z.object({
  providerMsgId: id,
  rfcMessageId: text(998).optional(),
  fromAddr: addr,
  inReplyTo: text(998).optional(),
  references: text(16_000).optional(),
  clientCodeHeader: z.boolean().optional(),
});

export const GateBody = z.object({
  accountId: z.string().uuid(),
  envelopes: z.array(Envelope).max(MAIL_GATE_BATCH_MAX),
});

const DELIVERY_KINDS = ['direct', 'list', 'automated', 'marketing'] as const;

export const WireMessageBody = Envelope.extend({
  threadId: text(500).optional(),
  fromName: text(500).optional(),
  toAddrs: z.array(addr).max(1000),
  ccAddrs: z.array(addr).max(1000).optional(),
  bccAddrs: z.array(addr).max(1000).optional(),
  subject: text(10_000).optional(),
  snippet: text(10_000).optional(),
  internalDate: z.string().max(64),
  labels: z.array(text(500)).max(200).optional(),
  folder: text(1000).optional(),
  isRead: z.boolean().optional(),
  isStarred: z.boolean().optional(),
  sizeBytes: z.number().int().nonnegative().optional(),
  deliveryKind: z.enum(DELIVERY_KINDS).optional(),
  bodyText: z.string().optional(),
  bodyHtml: z.string().optional(),
  attachments: z
    .array(
      z.object({
        filename: text(1000),
        mimeType: text(255).optional(),
        sizeBytes: z.number().int().nonnegative().optional(),
        contentB64: z.string(),
      }),
    )
    .max(500),
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

/** The most events one feed may hold (a bigger feed is cut by the sidecar,
 *  newest first, and says so in its status). */
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
