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
  envelopeFits,
  type WireEnvelope,
  type WireMessage,
} from '@mantle/email/wire';
import { randomUUID } from 'node:crypto';
import { touchesClientCodeMail } from '@mantle/email/client-code-mail';
import { errorMessage } from '@mantle/std';
import { BrainError, type Brain } from './brain';
import { stagerFor, failuresFor } from './mail-stream';
import { backfillSender, mask, recentSenders, syncMailbox } from './imap';
import { backfillOutlook, recentOutlookSenders, syncOutlook } from './outlook';
import type { BackfillJob, BackfillMark, MailAccount, MsAccount, State } from './state';

/** A backfill run's share per mailbox and target (pacing: the next run
 *  goes on from the mark). IMAP: envelopes; Outlook: pages of 50. */
export const BACKFILL_RUN_ENVELOPES = 2500;
export const BACKFILL_RUN_PAGES = 50;
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

/** The brain refused this one body (400, or 413 too large): skip it and go
 *  on, so one odd message can never stop a mailbox. Any other answer (a 404:
 *  the mailbox was switched off; a 401; a 5xx; a network fault) stops the
 *  run, and the cursor stays where it is. */
const refused = (err: unknown) =>
  err instanceof BrainError && (err.status === 400 || err.status === 413);

type GateEnvelope = Parameters<typeof envelopeOf>[0];

function gateFor(brain: Brain, accountId: string) {
  return async (all: GateEnvelope[]): Promise<string[]> => {
    // Never fetched: a sender or an id past the brain's bounds (never cut: a
    // cut sender could pass another domain's contact), and a client sign-in
    // code mail, judged here on the whole header values.
    const messages = all.filter((m) => envelopeFits(m) && !touchesClientCodeMail(m));
    if (messages.length < all.length) {
      console.warn(`[sync] ${all.length - messages.length} message(s) skipped before the gate`);
    }
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
      stagerFor(brain, account.id),
      failuresFor(state, account.id),
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

/** The Microsoft accounts whose Outlook mail syncs (the mail switch on,
 *  and their mailbox row made). */
export async function outlookAccounts(
  state: State,
): Promise<(MsAccount & { mailboxId: string })[]> {
  return (await state.msAccounts()).filter(
    (a): a is MsAccount & { mailboxId: string } => a.mail && !!a.mailboxId,
  );
}

/** One run of a Microsoft account's Outlook mail folders, reported as a
 *  mailbox's. */
export async function runOutlookMail(
  brain: Brain,
  state: State,
  account: MsAccount & { mailboxId: string },
): Promise<void> {
  const startedAt = new Date().toISOString();
  const counter = { ingested: 0 };
  let scanned = 0;
  let error: string | undefined;
  try {
    const r = await syncOutlook(
      state,
      account,
      gateFor(brain, account.mailboxId),
      ingestFor(brain, account.mailboxId, counter),
      stagerFor(brain, account.mailboxId),
      failuresFor(state, account.mailboxId),
    );
    scanned = r.scanned;
  } catch (err) {
    error = runError(err, { address: account.upn });
    console.warn(`[sync] Outlook ${mask(account.upn)} run failed: ${error}`);
  }
  await brain.post('/api/sidecar/mail/run', {
    accountId: account.mailboxId,
    startedAt,
    scanned,
    ingested: counter.ingested,
    ...(error ? { error } : {}),
  });
  await state.putStatus(account.mailboxId, {
    at: new Date().toISOString(),
    ok: !error,
    ...(error ? { error } : {}),
    count: counter.ingested,
  });
}

/** A new backfill job per target, each kept in the brain until it reaches
 *  the end (each run of it a share: runBackfill). One per target keeps a
 *  job's marks (every mailbox's folders) well under the 256 KB a state
 *  value holds. */
export async function queueBackfill(state: State, targets: string[]): Promise<BackfillJob[]> {
  const jobs: BackfillJob[] = [];
  for (const target of new Set(targets)) {
    const job: BackfillJob = {
      id: randomUUID(),
      targets: [target],
      at: new Date().toISOString(),
      marks: {},
    };
    await state.putBackfill(job);
    jobs.push(job);
  }
  return jobs;
}

/** A mark as small as it can be kept: a done one needs no folders, a done
 *  folder no watermark (an IMAP one keeps its UIDVALIDITY: a new one
 *  reads the folder again). */
export function pruneMark(m: BackfillMark): void {
  if (m.done) {
    delete m.folders;
    return;
  }
  for (const [id, f] of Object.entries(m.folders ?? {})) {
    if (!f.done) continue;
    m.folders![id] =
      f.uidvalidity === undefined ? { done: true } : { uidvalidity: f.uidvalidity, done: true };
  }
}

/**
 * One run of a backfill job: each target across every enabled mailbox and
 * every Outlook account, back to that mailbox's first-scan reach, at most
 * BACKFILL_RUN_ENVELOPES envelopes (IMAP) or BACKFILL_RUN_PAGES pages
 * (Outlook) per mailbox and target this run. Each mark is kept as it moves,
 * so the next run (the scheduler's, or after a restart) goes on; a job whose
 * every mark is done is removed. A mailbox that fails is tried again next
 * run. How many messages it stored.
 */
export async function runBackfill(brain: Brain, state: State, id: string): Promise<number> {
  const job = await state.backfill(id);
  if (!job) return 0;
  const save = () => {
    for (const m of Object.values(job.marks)) pruneMark(m);
    return state.putBackfill(job).then(() => undefined);
  };
  let ingested = 0;
  let open = false;
  const mark = (key: string): BackfillMark => (job.marks[key] ??= {});
  for (const account of await outlookAccounts(state)) {
    for (const target of job.targets) {
      const m = mark(`${account.mailboxId}|${target}`);
      if (m.done) continue;
      const counter = { ingested: 0 };
      try {
        const r = await backfillOutlook(
          state,
          account,
          target,
          m,
          save,
          gateFor(brain, account.mailboxId),
          ingestFor(brain, account.mailboxId, counter),
          stagerFor(brain, account.mailboxId),
          BACKFILL_RUN_PAGES,
          failuresFor(state, account.mailboxId),
        );
        m.done = r.done;
        if (!r.done) open = true;
      } catch (err) {
        open = true;
        console.warn(
          `[sync] backfill on ${mask(account.upn)} failed: ${runError(err, { address: account.upn })}`,
        );
      }
      await save();
      ingested += counter.ingested;
    }
  }
  for (const account of await state.accounts()) {
    if (!account.enabled) continue;
    for (const target of job.targets) {
      const m = mark(`${account.id}|${target}`);
      if (m.done) continue;
      const counter = { ingested: 0 };
      try {
        const r = await backfillSender(
          account,
          target,
          m,
          save,
          gateFor(brain, account.id),
          ingestFor(brain, account.id, counter),
          stagerFor(brain, account.id),
          BACKFILL_RUN_ENVELOPES,
          failuresFor(state, account.id),
        );
        m.done = r.done;
        if (!r.done) open = true;
      } catch (err) {
        open = true;
        console.warn(
          `[sync] backfill on ${mask(account.address)} failed: ${runError(err, account)}`,
        );
      }
      await save();
      ingested += counter.ingested;
    }
  }
  if (!open) await state.deleteBackfill(job.id);
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
  const lists = [];
  for (const account of await state.accounts()) {
    if (account.enabled) lists.push(await recentSenders(account, since));
  }
  for (const account of await outlookAccounts(state)) {
    lists.push(await recentOutlookSenders(state, account, since));
  }
  for (const list of lists) {
    for (const s of list) {
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
