/**
 * Mail runs of the Sync sidecar (Sync service plan M2; docs/email-ingest.md):
 * a mailbox's IMAP run, a new contact's backfill, and the discover scan,
 * each through the brain's one gate (POST /api/sidecar/mail/gate) and store
 * (POST /api/sidecar/mail/ingest).
 */
import {
  MAIL_GATE_BATCH_MAX,
  clipEnvelope,
  clipMessage,
  type WireEnvelope,
  type WireMessage,
} from '@mantle/email/wire';
import { errorMessage } from '@mantle/std';
import { BrainError, type Brain } from './brain';
import { backfillSender, mask, recentSenders, syncMailbox, type WantedOf } from './imap';
import type { MailAccount, State } from './state';

/** How far a new contact's backfill reaches. */
const BACKFILL_DAYS = 90;
/** How far the discover scan reaches, and how many senders it shows. */
const DISCOVER_DAYS = 30;
const DISCOVER_LIMIT = 50;
/** The longest error text a status keeps. */
const ERROR_MAX = 300;

const envelopeOf = (m: {
  providerMsgId: string;
  rfcMessageId?: string;
  fromAddr: string;
  inReplyTo?: string;
  references?: string;
  clientCodeHeader?: boolean;
}): WireEnvelope =>
  clipEnvelope({
    providerMsgId: m.providerMsgId,
    rfcMessageId: m.rfcMessageId,
    fromAddr: m.fromAddr,
    inReplyTo: m.inReplyTo,
    references: m.references,
    clientCodeHeader: m.clientCodeHeader,
  });

/** The brain refused this one request (a 4xx): skip it and go on, so one odd
 *  message can never stop a mailbox. A 5xx or a network fault stops the run
 *  (the cursor stays, the next run tries again). */
const refused = (err: unknown) =>
  err instanceof BrainError && err.status >= 400 && err.status < 500;

function gateFor(brain: Brain, accountId: string): WantedOf {
  return async (messages) => {
    const wanted: string[] = [];
    for (let i = 0; i < messages.length; i += MAIL_GATE_BATCH_MAX) {
      try {
        const r = await brain.post<{ wanted: string[] }>('/api/sidecar/mail/gate', {
          accountId,
          envelopes: messages.slice(i, i + MAIL_GATE_BATCH_MAX).map(envelopeOf),
        });
        wanted.push(...r.wanted);
      } catch (err) {
        if (!refused(err)) throw err;
        console.warn(
          `[sync] the brain refused a batch of envelopes (skipped): ${(err as Error).message}`,
        );
      }
    }
    return wanted;
  };
}

function ingestFor(brain: Brain, accountId: string, counter: { ingested: number }) {
  return async (message: WireMessage) => {
    try {
      const r = await brain.post<{ stored: boolean }>('/api/sidecar/mail/ingest', {
        accountId,
        message: clipMessage(message),
      });
      if (r.stored) counter.ingested += 1;
    } catch (err) {
      if (!refused(err)) throw err;
      console.warn(`[sync] the brain refused a message (skipped): ${(err as Error).message}`);
    }
  };
}

/** A short text for a failed run, with no address or password in it. */
export function runError(err: unknown, hide?: { address?: string; password?: string }): string {
  let text = errorMessage(err);
  if (hide?.password) text = text.split(hide.password).join('***');
  if (hide?.address) text = text.split(hide.address).join(mask(hide.address));
  return text.slice(0, ERROR_MAX);
}

/** One run of a mailbox, reported to the brain and kept as its status. */
export async function runMailbox(brain: Brain, state: State, account: MailAccount): Promise<void> {
  const startedAt = new Date().toISOString();
  const counter = { ingested: 0 };
  let scanned = 0;
  let error: string | undefined;
  try {
    const cursor = await state.cursor(account.id);
    const r = await syncMailbox(
      account,
      cursor,
      gateFor(brain, account.id),
      ingestFor(brain, account.id, counter),
      (c) => state.putCursor(account.id, c).then(() => undefined),
    );
    scanned = r.scanned;
  } catch (err) {
    error = runError(err, account);
    console.warn(`[sync] mailbox ${mask(account.address)} run failed: ${error}`);
  }
  await brain.post('/api/sidecar/mail/run', {
    accountId: account.id,
    startedAt,
    scanned,
    ingested: counter.ingested,
    ...(error ? { error } : {}),
  });
  await state.putStatus(account.id, {
    at: new Date().toISOString(),
    ok: !error,
    ...(error ? { error } : {}),
    count: counter.ingested,
  });
}

/** Each target's last 90 days across every enabled mailbox. */
export async function backfill(brain: Brain, state: State, targets: string[]): Promise<number> {
  const since = new Date(Date.now() - BACKFILL_DAYS * 86_400_000);
  let ingested = 0;
  for (const account of await state.accounts()) {
    if (!account.enabled) continue;
    for (const target of targets) {
      const counter = { ingested: 0 };
      try {
        await backfillSender(
          account,
          target,
          since,
          gateFor(brain, account.id),
          ingestFor(brain, account.id, counter),
        );
      } catch (err) {
        console.warn(
          `[sync] backfill on ${mask(account.address)} failed: ${runError(err, account)}`,
        );
      }
      ingested += counter.ingested;
    }
  }
  return ingested;
}

export type DiscoveredSender = {
  fromAddr: string;
  fromName?: string;
  count: number;
  lastDate: string;
  subject?: string;
};

/** The recent senders across every enabled mailbox who are no contact
 *  yet, newest first. */
export async function discover(brain: Brain, state: State): Promise<DiscoveredSender[]> {
  const since = new Date(Date.now() - DISCOVER_DAYS * 86_400_000);
  const merged = new Map<string, DiscoveredSender & { at: number }>();
  for (const account of await state.accounts()) {
    if (!account.enabled) continue;
    for (const s of await recentSenders(account, since)) {
      const at = s.lastDate.getTime();
      const prev = merged.get(s.fromAddr);
      if (prev) {
        prev.count += s.count;
        if (at > prev.at)
          Object.assign(prev, { at, lastDate: s.lastDate.toISOString(), subject: s.subject });
      } else {
        merged.set(s.fromAddr, {
          fromAddr: s.fromAddr,
          fromName: s.fromName,
          count: s.count,
          lastDate: s.lastDate.toISOString(),
          subject: s.subject,
          at,
        });
      }
    }
  }
  const addresses = [...merged.keys()];
  const unknown = new Set<string>();
  for (let i = 0; i < addresses.length; i += 1000) {
    const r = await brain.post<{ unknown: string[] }>('/api/sidecar/contacts/unknown', {
      addresses: addresses.slice(i, i + 1000),
    });
    for (const a of r.unknown) unknown.add(a);
  }
  return [...merged.values()]
    .filter((s) => unknown.has(s.fromAddr))
    .sort((a, b) => b.at - a.at)
    .slice(0, DISCOVER_LIMIT)
    .map(({ at: _at, ...s }) => s);
}
