/**
 * Outlook mail for the Sync sidecar (Sync service plan M3;
 * docs/email-ingest.md): a connected Microsoft account's mail folders
 * through Microsoft Graph. Every folder the account chose (as an IMAP
 * mailbox's folder choice: all but Deleted Items, Junk Email, Drafts,
 * Outbox and Sync Issues unless the account says otherwise), each from its
 * own lastModifiedDateTime watermark (no delta; a move changes it). Each page's envelopes go
 * through the brain's one gate first, and only the wanted messages are
 * fetched in full and posted (mail.ts gateFor and ingestFor, the IMAP
 * path's own).
 *
 * A message is taken in whole: its file attachments, its item attachments
 * (an attached email as .eml, an event as .ics, a contact as .vcf, each
 * Graph's own MIME of the item) and its reference attachments (a OneDrive
 * or SharePoint link: the linked file is fetched through the share). Past
 * MAIL_MESSAGE_MAX_BYTES each attachment streams to the brain on its own
 * (mail-stream.ts), so a message of any size keeps memory flat. Only what
 * Microsoft will not hand out is left, and the message says which.
 */
import { Readable } from 'node:stream';
import { classifyDelivery } from '@mantle/email/classify';
import { MAIL_MESSAGE_MAX_BYTES, type WireAttachment, type WireMessage } from '@mantle/email/wire';
import { NET_TIMEOUTS, errorMessage } from '@mantle/std';
import { egressFetch } from '@mantle/std/egress';
import { BrainError, MessageFault } from './brain';
import {
  fitBody,
  notesText,
  stageOne,
  unreadStub,
  type Stager,
  type Failures,
} from './mail-stream';
import { GRAPH_ORIGIN, GraphError, accessToken, graph, graphAll, graphJson } from './microsoft';

/** Graph's beta endpoint: a reference attachment's link is read there only. */
const GRAPH_BETA = `${GRAPH_ORIGIN}/beta`;
import type { BackfillMark, MsAccount, MsCursor, State } from './state';

export const MAIL_SELECT =
  'id,internetMessageId,conversationId,subject,bodyPreview,from,sender,toRecipients,ccRecipients,bccRecipients,receivedDateTime,lastModifiedDateTime,isRead,hasAttachments,categories,flag,internetMessageHeaders';
const PAGE = 50;
/** Pages one run reads at most across the folders (2 500 messages): pacing,
 *  the next run goes on from each folder's watermark. */
export const RUN_PAGES = 50;
/** How far a first run of a folder reaches when the account names none. */
export const FIRST_SCAN_DAYS = 365;
/** The folders left out when the account names none (Graph's well-known
 *  names), and everything below them. */
export const DEFAULT_EXCLUDED_WELL_KNOWN = [
  'deleteditems',
  'junkemail',
  'drafts',
  'outbox',
  'syncissues',
];

type Addr = { emailAddress?: { address?: string; name?: string } };
export type GraphMessage = {
  id: string;
  internetMessageId?: string;
  conversationId?: string;
  subject?: string;
  bodyPreview?: string;
  from?: Addr;
  sender?: Addr;
  toRecipients?: Addr[];
  ccRecipients?: Addr[];
  bccRecipients?: Addr[];
  receivedDateTime?: string;
  lastModifiedDateTime?: string;
  isRead?: boolean;
  hasAttachments?: boolean;
  categories?: string[];
  flag?: { flagStatus?: string };
  internetMessageHeaders?: { name: string; value: string }[];
};

const lower = (a: Addr | undefined) => a?.emailAddress?.address?.trim().toLowerCase() ?? '';
const addrs = (l: Addr[] | undefined) => (l ?? []).map(lower).filter(Boolean);
const stripAngles = (v: string | undefined) => v?.trim().replace(/^<|>$/g, '') || undefined;

/** A Graph message's envelope and summary in the wire shape (no body yet). */
export function normalize(m: GraphMessage, folder = 'Inbox'): Omit<WireMessage, 'attachments'> {
  const headers: Record<string, string> = {};
  for (const h of m.internetMessageHeaders ?? []) headers[h.name.toLowerCase()] = h.value;
  const fromAddr = lower(m.from ?? m.sender);
  const labels = m.categories ?? [];
  return {
    providerMsgId: m.id,
    rfcMessageId: stripAngles(m.internetMessageId),
    threadId: m.conversationId,
    fromAddr,
    fromName: (m.from ?? m.sender)?.emailAddress?.name,
    toAddrs: addrs(m.toRecipients),
    ccAddrs: addrs(m.ccRecipients),
    bccAddrs: addrs(m.bccRecipients),
    subject: m.subject,
    snippet: m.bodyPreview,
    internalDate: m.receivedDateTime ?? new Date().toISOString(),
    labels,
    folder,
    isRead: m.isRead,
    isStarred: m.flag?.flagStatus === 'flagged',
    inReplyTo: headers['in-reply-to'],
    references: headers['references'],
    clientCodeHeader: 'x-mantle-client-code' in headers,
    deliveryKind: classifyDelivery({ headers, fromAddr, labels }),
  };
}

// ── folders ────────────────────────────────────────────────────────────────

export type MailFolder = { id: string; path: string };
type GraphFolder = { id: string; displayName?: string; childFolderCount?: number };

/** Every mail folder of the account, with its path (`Inbox/Projects`),
 *  parents first. */
export async function allMailFolders(token: string): Promise<MailFolder[]> {
  const out: MailFolder[] = [];
  const walk = async (path: string, parent: string | null, depth: number) => {
    const list = await graphAll<GraphFolder>(
      token,
      `${parent ? `/me/mailFolders/${encodeURIComponent(parent)}/childFolders` : '/me/mailFolders'}?$top=100&$select=id,displayName,childFolderCount`,
      1000,
    );
    for (const f of list) {
      const p = path ? `${path}/${f.displayName ?? f.id}` : (f.displayName ?? f.id);
      out.push({ id: f.id, path: p });
      if ((f.childFolderCount ?? 0) > 0 && depth < 32) await walk(p, f.id, depth + 1);
    }
  };
  await walk('', null, 0);
  return out;
}

/** The ids of Graph's well-known folders (absent ones left out). */
async function wellKnownIds(token: string, names: string[]): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  for (const name of names) {
    try {
      const f = await graphJson<{ id: string }>(token, `/me/mailFolders/${name}?$select=id`);
      if (f.id) ids.set(name, f.id);
    } catch (err) {
      if (!(err instanceof GraphError && (err.status === 404 || err.status === 400))) throw err;
    }
  }
  return ids;
}

/** The folders a run reads: the account's choice, as IMAP's
 *  (scanFolders): only the included ones when that list is set, else all
 *  but the excluded ones (by default the well-known left-out folders and
 *  everything below them). */
export async function chosenFolders(
  token: string,
  account: Pick<MsAccount, 'excludedFolders' | 'includedFolders'>,
): Promise<{ folders: MailFolder[]; inboxId: string | null }> {
  const all = await allMailFolders(token);
  const known = await wellKnownIds(token, ['inbox', ...DEFAULT_EXCLUDED_WELL_KNOWN]);
  const inboxId = known.get('inbox') ?? null;
  const included = account.includedFolders?.length ? new Set(account.includedFolders) : null;
  if (included) return { folders: all.filter((f) => included.has(f.path)), inboxId };
  const excludedPaths = account.excludedFolders
    ? new Set(account.excludedFolders)
    : new Set(
        all
          .filter((f) => DEFAULT_EXCLUDED_WELL_KNOWN.some((n) => known.get(n) === f.id))
          .map((f) => f.path),
      );
  const out = all.filter(
    (f) => ![...excludedPaths].some((x) => f.path === x || f.path.startsWith(`${x}/`)),
  );
  return { folders: out, inboxId };
}

// ── one message in full ────────────────────────────────────────────────────

type AttachmentMeta = {
  '@odata.type'?: string;
  id: string;
  name?: string;
  contentType?: string;
  size?: number;
  isInline?: boolean;
};

const FILE = '#microsoft.graph.fileAttachment';
const ITEM = '#microsoft.graph.itemAttachment';
const REFERENCE = '#microsoft.graph.referenceAttachment';

/** An item attachment's file name, from the MIME type Graph answers. */
function itemName(name: string, type: string): string {
  const ext = /calendar/i.test(type) ? 'ics' : /vcard|directory/i.test(type) ? 'vcf' : 'eml';
  return /\.[a-z0-9]{2,4}$/i.test(name) ? name : `${name}.${ext}`;
}

/** A OneDrive or SharePoint sharing link as Graph's share id. */
export function shareIdOf(url: string): string {
  return `u!${Buffer.from(url, 'utf8').toString('base64url')}`;
}

/** The bytes of one attachment as a response to read or stream, with its
 *  file name and type, or a note when Microsoft will not hand it out. */
async function attachmentBody(
  token: string,
  messageId: string,
  a: AttachmentMeta,
): Promise<{ res: Response; filename: string; mimeType?: string } | { note: string }> {
  const name = a.name || 'attachment';
  const base = `/me/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(a.id)}`;
  const long = { timeoutMs: NET_TIMEOUTS.syncFile };
  try {
    if (a['@odata.type'] === REFERENCE) {
      // A link to a file in OneDrive or SharePoint: the file, through the
      // share. Its link (sourceUrl) is on Graph's beta endpoint only.
      const ref = await graphJson<{ sourceUrl?: string }>(token, `${GRAPH_BETA}${base}`);
      if (!ref.sourceUrl) return { note: `the linked file "${name}" (no link given)` };
      const item = await graphJson<{
        name?: string;
        file?: { mimeType?: string };
        '@microsoft.graph.downloadUrl'?: string;
      }>(token, `/shares/${shareIdOf(ref.sourceUrl)}/driveItem`);
      const url = item['@microsoft.graph.downloadUrl'];
      if (!url)
        return { note: `the linked file "${name}" (a folder, or not shared to this account)` };
      // A pre-signed address on Microsoft's file host: no token goes there.
      const res = await egressFetch(url, {}, { timeoutMs: NET_TIMEOUTS.syncFile });
      if (!res.ok || !res.body) {
        await res.body?.cancel().catch(() => {});
        return { note: `the linked file "${name}" (its host answered ${res.status})` };
      }
      return { res, filename: item.name || name, mimeType: item.file?.mimeType };
    }
    const res = await graph(token, `${base}/$value`, long);
    if (a['@odata.type'] === ITEM) {
      const type = res.headers.get('content-type') ?? 'message/rfc822';
      return { res, filename: itemName(name, type), mimeType: type.split(';')[0] };
    }
    return { res, filename: name, mimeType: a.contentType };
  } catch (err) {
    if (err instanceof GraphError && err.status >= 400 && err.status < 500) {
      return { note: `the attachment "${name}" (Microsoft answered ${err.status})` };
    }
    throw err;
  }
}

/** One wanted message in full: its body and every attachment. */
export async function fetchFull(
  token: string,
  m: GraphMessage,
  folder: string,
  stage: Stager,
  /** The last try of a message that failed for a day: an attachment that
   *  still fails is named in the note, and the rest is kept. */
  lenient = false,
): Promise<WireMessage> {
  const id = encodeURIComponent(m.id);
  const full = await graphJson<{ body?: { contentType?: string; content?: string } }>(
    token,
    `/me/messages/${id}?$select=body`,
  );
  const content = full.body?.content ?? '';
  const html = full.body?.contentType?.toLowerCase() === 'html';
  // An inline picture (cid:) is an attachment Graph does not count in
  // hasAttachments.
  const metas =
    m.hasAttachments || (html && content.includes('cid:'))
      ? await graphAll<AttachmentMeta>(
          token,
          `/me/messages/${id}/attachments?$select=id,name,contentType,size,isInline`,
          1000,
        )
      : [];
  // An item attachment's MIME ($value) runs larger than the size Graph
  // names (about 1.4 times): counted at 1.5, so a message posted inline
  // stays within the ingest ceiling.
  const total =
    Buffer.byteLength(content) +
    metas.reduce((n, a) => n + Math.max(0, a.size ?? 0) * (a['@odata.type'] === ITEM ? 1.5 : 1), 0);
  // Small: each attachment read whole and posted inline. Large: each
  // streams to the brain on its own.
  const inline = total <= MAIL_MESSAGE_MAX_BYTES;
  const attachments: WireAttachment[] = [];
  const notes: string[] = [];
  const takeOne = async (a: AttachmentMeta) => {
    const got = await attachmentBody(token, m.id, a);
    if ('note' in got) {
      notes.push(got.note);
      return;
    }
    if (inline && a['@odata.type'] !== REFERENCE) {
      const bytes = Buffer.from(await got.res.arrayBuffer());
      attachments.push({
        filename: got.filename,
        mimeType: got.mimeType,
        sizeBytes: bytes.byteLength,
        contentB64: bytes.toString('base64'),
      });
      return;
    }
    // A linked file's size is unknown before it comes: always streamed.
    const one = await stageOne(stage, Readable.fromWeb(got.res.body as never), {
      filename: got.filename,
      mimeType: got.mimeType,
    });
    if ('attachment' in one) attachments.push(one.attachment);
    else notes.push(one.note);
  };
  for (const a of metas) {
    if (![FILE, ITEM, REFERENCE].includes(a['@odata.type'] ?? FILE)) continue;
    try {
      await takeOne(a);
    } catch (err) {
      if (!lenient || !messageFault(err)) throw err;
      notes.push(`the attachment "${a.name || 'attachment'}" (${errorMessage(err).slice(0, 200)})`);
    }
  }
  const body = await fitBody(stage, html ? { html: content } : { text: content });
  const note = notesText([...notes, ...body.notes]);
  return {
    ...normalize(m, folder),
    ...(body.html !== undefined ? { bodyHtml: body.html } : {}),
    ...(note || body.text !== undefined
      ? { bodyText: [note, body.text].filter(Boolean).join('\n\n') }
      : {}),
    attachments: [...attachments, ...body.attachments],
  };
}

type Page = { value?: GraphMessage[]; '@odata.nextLink'?: string };

export type WantedOf = (envelopes: ReturnType<typeof normalize>[]) => Promise<string[]>;
export type OnMessage = (message: WireMessage) => Promise<void>;

/** Gate one page, fetch and post the wanted ones. How many it read. A
 *  message Microsoft fails on is kept to try again (retryFailed) and the
 *  page goes on; one gone since the listing is let go. */
async function walkPage(
  token: string,
  messages: GraphMessage[],
  folder: string,
  wantedOf: WantedOf,
  onMessage: OnMessage,
  stage: Stager,
  failures?: Failures,
): Promise<number> {
  const normal = messages.filter((m) => m.id).map((m) => ({ m, n: normalize(m, folder) }));
  const wanted = new Set(await wantedOf(normal.map((x) => x.n).filter((n) => n.fromAddr)));
  // One that failed before is the retry's, after its wait (retryFailed).
  const failing = failures && wanted.size > 0 ? await failures.ids() : new Set<string>();
  for (const { m } of normal) {
    if (!wanted.has(m.id) || failing.has(m.id)) continue;
    let full: WireMessage;
    try {
      full = await fetchFull(token, m, folder, stage);
    } catch (err) {
      // The brain's side, the account's token, a throttle or the network
      // stops the run (the watermark stays). A timeout or a broken read of
      // this one message, with Graph answering, is the message's.
      if (!failures || !(await faultOfMessage(token, err))) throw err;
      if (!(err instanceof GraphError && err.status === 404)) await failures.record(m.id, folder);
      continue;
    }
    await onMessage(full);
  }
  return normal.length;
}

/** A timeout or a network error (fetch failed, a body cut off): the
 *  message's or the run's, as a cheap Graph call answers. */
const netError = (err: unknown) => {
  const name = (err as Error | undefined)?.name;
  return err instanceof TypeError || name === 'AbortError' || name === 'TimeoutError';
};

/** Whether `err` is this one message's failure. A network-class error
 *  after a good listing is the message's (a body that always takes past
 *  the deadline, a read that breaks) when Graph still answers a cheap call
 *  at once; when that call fails too, the network is down: the run's. */
async function faultOfMessage(token: string, err: unknown): Promise<boolean> {
  if (!netError(err)) return messageFault(err);
  try {
    await graphJson(token, '/me/mailFolders/inbox?$select=id');
    return true;
  } catch {
    return false;
  }
}

/** A failure of this one message (Graph refused or broke on it, its
 *  source broke, its upload ran past its deadline), not of the run: the
 *  brain, the account's token, a throttle, the network. */
function messageFault(err: unknown): boolean {
  if (err instanceof MessageFault) return true;
  if (err instanceof BrainError) return false;
  if (err instanceof GraphError) return ![401, 403, 429].includes(err.status);
  // A network-class error is judged by faultOfMessage (a probe call).
  return !netError(err);
}

/** The messages that failed to read in earlier runs, tried again: stored
 *  when they read; after a day of tries stored with what could be read
 *  and a note (or as a stub); let go when they are gone. */
async function retryFailed(
  token: string,
  failures: Failures,
  onMessage: OnMessage,
  stage: Stager,
): Promise<void> {
  for (const p of await failures.pending()) {
    let m: GraphMessage;
    try {
      m = await graphJson<GraphMessage>(
        token,
        `/me/messages/${encodeURIComponent(p.id)}?$select=${MAIL_SELECT}`,
      );
    } catch (err) {
      if (err instanceof GraphError && err.status === 404) {
        await failures.clear(p.id);
        continue;
      }
      if (!(await faultOfMessage(token, err))) throw err;
      await failures.record(p.id, p.folder);
      continue;
    }
    let full: WireMessage;
    try {
      full = await fetchFull(token, m, p.folder, stage, p.last);
    } catch (err) {
      if (err instanceof GraphError && err.status === 404) {
        await failures.clear(p.id);
        continue;
      }
      if (!(await faultOfMessage(token, err))) throw err;
      if (!p.last) {
        await failures.record(p.id, p.folder);
        continue;
      }
      full = unreadStub({ ...normalize(m, p.folder), attachments: [] }, err);
    }
    await onMessage(full);
    await failures.clear(p.id);
  }
}

const firstSince = (account: Pick<MsAccount, 'firstScanDays'>) =>
  new Date(Date.now() - (account.firstScanDays ?? FIRST_SCAN_DAYS) * 86_400_000).toISOString();

const folderMessages = (
  folderId: string,
  filter: string,
  orderBy: string = 'receivedDateTime asc',
) =>
  `/me/mailFolders/${encodeURIComponent(folderId)}/messages?$select=${MAIL_SELECT}&$top=${PAGE}` +
  `&$orderby=${encodeURIComponent(orderBy)}&$filter=${encodeURIComponent(filter)}`;

/**
 * One run of an account's chosen folders. Each folder goes on from its own
 * watermark on lastModifiedDateTime, so mail moved into a folder (out of
 * Junk, filed from an excluded folder) is seen too: a move changes it, as
 * an IMAP move gives a new UID.
 *
 * Paging is by key, not by Graph's $skip: each page asks again from the
 * last time read, so a message changed while the run reads (read, flagged,
 * moved) never shifts another past the page. The ids read this run are
 * skipped when they come again.
 *
 * A full page whose every message shares one time (a bulk change: mark
 * all read, a retention stamp, an import) is a group: it is read on the
 * second key, receivedDateTime (`lastModifiedDateTime eq T` ordered by
 * both, as Graph's $orderby asks), and where it got to is kept in the
 * cursor (`ties`), so a group of any size is crossed over as many runs as
 * it takes and the folder never stalls. Once past it, the folder reads on
 * from `gt T`.
 *
 * Every folder gets its first page each run (each folder's oldest change
 * after its watermark); the backlog then shares RUN_PAGES pages, a page a
 * folder in turn, starting each run where the last one stopped. Messages
 * that failed before are tried again after the new mail (retryFailed).
 */
export async function syncOutlook(
  state: State,
  account: MsAccount,
  wantedOf: WantedOf,
  onMessage: OnMessage,
  stage: Stager,
  failures?: Failures,
): Promise<{ scanned: number }> {
  const token = await accessToken(state, account.id);
  const cursor: MsCursor = await state.msCursor(account.id);
  const { folders, inboxId } = await chosenFolders(token, account);
  // Marks of folders no longer chosen (or gone) are let go.
  const chosen = new Set(folders.map((f) => f.id));
  const keep = <T>(r: Record<string, T> | undefined): Record<string, T> =>
    Object.fromEntries(Object.entries(r ?? {}).filter(([id]) => chosen.has(id)));
  const marks = keep(cursor.folders);
  const ties = keep(cursor.ties);
  const past = keep(cursor.past);
  const reach = firstSince(account);
  let scanned = 0;
  let rr = cursor.rr ?? 0;
  const save = () =>
    state.putMsCursor(account.id, { since: cursor.since, folders: marks, ties, past, rr });

  type Walker = {
    f: MailFolder;
    mark: string;
    /** Inside a group at one time: its time and the receivedDateTime read to. */
    tie?: { at: string; after: string };
    /** A group at one receivedDateTime too, past a page: Graph's next link. */
    dtie?: string;
    seen: Set<string>;
    done: boolean;
  };
  const walk = async (w: Walker, all: GraphMessage[]) => {
    const fresh = all.filter((m) => !w.seen.has(m.id));
    for (const m of all) w.seen.add(m.id);
    scanned += await walkPage(token, fresh, w.f.path, wantedOf, onMessage, stage, failures);
    return fresh;
  };
  const step = async (w: Walker) => {
    if (w.tie) {
      const url =
        w.dtie ??
        folderMessages(
          w.f.id,
          `lastModifiedDateTime eq ${w.tie.at} and receivedDateTime ge ${w.tie.after}`,
          'lastModifiedDateTime asc,receivedDateTime asc',
        );
      const page: Page = await graphJson<Page>(token, url);
      const all = (page.value ?? []).filter((m) => m.id);
      const fresh = await walk(w, all);
      const first = all[0]?.receivedDateTime;
      const last = all[all.length - 1]?.receivedDateTime;
      const next = page['@odata.nextLink'];
      if (!next || all.length < PAGE) {
        // Past the group: the folder reads on from after its time.
        past[w.f.id] = w.tie.at;
        marks[w.f.id] = w.tie.at;
        w.mark = w.tie.at;
        delete ties[w.f.id];
        w.tie = undefined;
        w.dtie = undefined;
        await save();
        return;
      }
      if (last && last !== w.tie.after) {
        w.tie.after = last;
        ties[w.f.id] = { ...w.tie };
        await save();
      }
      // A full page at one receivedDateTime too, nothing new on it: the
      // next link crosses it.
      w.dtie = first === last && fresh.length === 0 ? next : undefined;
      return;
    }
    const after = past[w.f.id] === w.mark ? 'gt' : 'ge';
    const page: Page = await graphJson<Page>(
      token,
      folderMessages(
        w.f.id,
        `lastModifiedDateTime ${after} ${w.mark} and receivedDateTime ge ${reach}`,
        'lastModifiedDateTime asc',
      ),
    );
    const all = (page.value ?? []).filter((m) => m.id);
    await walk(w, all);
    const first = all[0]?.lastModifiedDateTime;
    const last = all[all.length - 1]?.lastModifiedDateTime;
    if (!page['@odata.nextLink'] || all.length < PAGE) {
      if (last && last !== w.mark) {
        w.mark = last;
        marks[w.f.id] = last;
        delete past[w.f.id];
        await save();
      }
      w.done = true;
      return;
    }
    if (first && first === last) {
      // A full page all at one time: a group, read on its second key.
      w.tie = { at: first, after: reach };
      ties[w.f.id] = { ...w.tie };
      await save();
      return;
    }
    if (last && last !== w.mark) {
      w.mark = last;
      marks[w.f.id] = last;
      delete past[w.f.id];
      await save();
    }
  };

  const walkers: Walker[] = folders.map((f) => ({
    f,
    // The inbox goes on from the watermark it had before every folder
    // synced (a receivedDateTime: never later than its lastModified, so
    // nothing is skipped; the gate's dedup drops what comes again).
    mark: marks[f.id] ?? (f.id === inboxId && cursor.since ? cursor.since : reach),
    tie: ties[f.id] ? { ...ties[f.id]! } : undefined,
    seen: new Set(),
    done: false,
  }));
  for (const w of walkers) await step(w);
  let pages = 0;
  const backlog = () => walkers.filter((w) => !w.done);
  while (pages < RUN_PAGES && backlog().length > 0) {
    const open = backlog();
    const w = open[rr % open.length]!;
    rr = (rr + 1) % Math.max(1, walkers.length);
    pages += 1;
    await step(w);
    // A folder inside a group goes on with it while the run has pages
    // (where it got to is kept, so the next run goes on from there).
    while (w.tie && !w.done && pages < RUN_PAGES) {
      pages += 1;
      await step(w);
    }
  }
  await save();
  // The messages that failed before, after the new mail.
  if (failures) await retryFailed(token, failures, onMessage, stage);
  return { scanned };
}

const odataString = (v: string) => `'${v.replace(/'/g, "''")}'`;

/**
 * A new contact's mail (an address, or `@domain`) across the chosen
 * folders back to the account's first-scan reach, `budget` pages at most
 * this run: the mark keeps each folder's watermark, so the next run goes on
 * and a backfill always reaches the end. Graph cannot filter by a sender's
 * domain, so a domain reads every message of the reach and matches here.
 */
export async function backfillOutlook(
  state: State,
  account: MsAccount,
  target: string,
  mark: BackfillMark,
  save: (mark: BackfillMark) => Promise<void>,
  wantedOf: WantedOf,
  onMessage: OnMessage,
  stage: Stager,
  budget: number,
  failures?: Failures,
): Promise<{ scanned: number; done: boolean }> {
  const want = target.trim().toLowerCase().replace(/^@/, '');
  if (!want) return { scanned: 0, done: true };
  const token = await accessToken(state, account.id);
  const isDomain = !want.includes('@');
  const { folders } = await chosenFolders(token, account);
  mark.folders ??= {};
  let scanned = 0;
  let pages = 0;
  for (const f of folders) {
    const fm = (mark.folders[f.id] ??= {});
    if (fm.done) continue;
    const since = fm.since ?? firstSince(account);
    const filter = isDomain
      ? `receivedDateTime ge ${since}`
      : `receivedDateTime ge ${since} and from/emailAddress/address eq ${odataString(want)}`;
    let next: string | undefined = folderMessages(f.id, filter);
    while (next) {
      if (pages >= budget) return { scanned, done: false };
      const page: Page = await graphJson<Page>(token, next);
      pages += 1;
      const all = page.value ?? [];
      const messages = all.filter((m) => {
        const from = lower(m.from ?? m.sender);
        return isDomain ? from.endsWith(`@${want}`) : from === want;
      });
      scanned += await walkPage(token, messages, f.path, wantedOf, onMessage, stage, failures);
      const last = all[all.length - 1]?.receivedDateTime;
      if (last) fm.since = last;
      next = page['@odata.nextLink'];
      if (!next) fm.done = true;
      await save(mark);
    }
  }
  return { scanned, done: true };
}

export type OutlookSender = {
  fromAddr: string;
  fromName?: string;
  count: number;
  lastDate: Date;
  subject?: string;
};

/** Pages the discover screen reads (a listing of recent senders, not an
 *  ingest: pacing only). */
const DISCOVER_PAGES = 6;

/** The inbox's recent senders (for discover), newest first. */
export async function recentOutlookSenders(
  state: State,
  account: MsAccount,
  since: Date,
): Promise<OutlookSender[]> {
  const token = await accessToken(state, account.id);
  const by = new Map<string, OutlookSender>();
  let next: string | undefined =
    `/me/mailFolders/inbox/messages?$select=from,sender,subject,receivedDateTime&$top=${PAGE}` +
    `&$orderby=receivedDateTime desc&$filter=receivedDateTime ge ${since.toISOString()}`;
  for (let i = 0; next && i < DISCOVER_PAGES; i++) {
    const page: Page = await graphJson<Page>(token, next);
    for (const m of page.value ?? []) {
      const from = lower(m.from ?? m.sender);
      if (!from) continue;
      const at = new Date(m.receivedDateTime ?? 0);
      const prev = by.get(from);
      if (prev) prev.count += 1;
      else
        by.set(from, {
          fromAddr: from,
          fromName: (m.from ?? m.sender)?.emailAddress?.name,
          count: 1,
          lastDate: at,
          subject: m.subject,
        });
    }
    next = page['@odata.nextLink'];
  }
  return [...by.values()];
}

/** The most attachment bytes Graph takes in one sendMail (no upload
 *  session), as before M4. */
export const GRAPH_SEND_ATTACH_MAX = 2_500_000;

export type GraphSendInput = {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  text?: string;
  html?: string;
  attachments?: { filename?: string; contentType?: string; cid?: string; contentB64: string }[];
};

/** Send from the account through Graph (/me/sendMail). Graph answers 202
 *  with no body: every recipient counts as accepted. */
export async function sendOutlook(
  state: State,
  account: MsAccount,
  input: GraphSendInput,
): Promise<void> {
  const recips = (l: string[] | undefined) =>
    (l ?? []).map((address) => ({ emailAddress: { address } }));
  const attachBytes = (input.attachments ?? []).reduce(
    (n, a) => n + Math.floor((a.contentB64.length * 3) / 4),
    0,
  );
  if (attachBytes > GRAPH_SEND_ATTACH_MAX) {
    throw new Error('Outlook sends at most 2.5 MB of attachments in one message.');
  }
  const token = await accessToken(state, account.id);
  await graph(token, '/me/sendMail', {
    method: 'POST',
    body: {
      saveToSentItems: true,
      message: {
        subject: input.subject,
        body: input.html
          ? { contentType: 'HTML', content: input.html }
          : { contentType: 'Text', content: input.text ?? '' },
        toRecipients: recips(input.to),
        ...(input.cc?.length ? { ccRecipients: recips(input.cc) } : {}),
        ...(input.bcc?.length ? { bccRecipients: recips(input.bcc) } : {}),
        ...(input.attachments?.length
          ? {
              attachments: input.attachments.map((a) => ({
                '@odata.type': '#microsoft.graph.fileAttachment',
                name: a.filename ?? 'attachment',
                contentType: a.contentType ?? 'application/octet-stream',
                contentBytes: a.contentB64,
                ...(a.cid ? { isInline: true, contentId: a.cid } : {}),
              })),
            }
          : {}),
      },
    },
  });
}
