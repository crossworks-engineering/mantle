/**
 * What a member or a client login is told about on its phone (migration
 * mobile_roles_push, docs/mobile-companion-backend.md "Three roles on the phone"): a reply
 * in its own chat thread, a review result on its own item, a new comment.
 *
 * The `login_notice` NOTIFY (raised by triggers) carries ids only. This
 * module turns one into the message for the ONE login it concerns: who is
 * told, and words that login could read by opening the app. The rule for
 * every teaser: never text its reader could not open.
 *
 *  - chat: the reply as the reader's own chat route returns it (pictures of
 *    items above the reader's level are already out, chat-images.ts).
 *  - review: the author's own item. Its title while an admin holds it is
 *    the title it had when it was taken, never the admin's working title.
 *  - comment: on a personal item, its author (the item is in the author's
 *    own space, where the author reads every comment on it). On a brain
 *    item's client thread, every active client login, and only while the
 *    item is at client level (the rule the thread's own reads hold).
 *
 * Nothing here sends: the push worker applies the login's toggles, finds its
 * live devices and seals the message (server/web/lib/push/login-notify.ts).
 * Reads run on the admin pool (the worker has no viewer scope); `asSystem`
 * makes that hold wherever this is called from. Nothing here starts LLM
 * work.
 */
import { and, eq, gt, inArray, isNull, ne, sql } from 'drizzle-orm';
import {
  acceptedSnapshots,
  agents,
  asSystem,
  authUsers,
  db,
  nodeComments,
  nodes,
  spaceItems,
  spaces,
  teamMessages,
} from '@mantle/db';
import { markdownPreview } from '@mantle/content-core/markdown-to-text';
import { chatTextsForReader } from './chat-images';
import { readAtSql } from './item-level';
import { loadPreferencesFor } from './profile-preferences';

export const LOGIN_NOTICE_CHANNEL = 'login_notice';

/** An event older than this is not news: a backfill or a bulk repair that
 *  touches old rows must never page anyone. */
export const LOGIN_NOTICE_FRESH_MS = 30 * 60 * 1000;

/** How many logins one read of the client list takes (a comment on a
 *  client-level item tells every client): the list is read in pages. */
export const MAX_LOGINS_PER_NOTICE = 100;

/** The most clients one comment tells: far above one client company's
 *  logins, and the bound that keeps one event from holding the send chain
 *  (each login holds at most ten devices). */
export const MAX_CLIENTS_PER_NOTICE = 2000;

/** "Is this row news?", asked of the DATABASE: the rows are stamped on its
 *  clock, so the worker's clock never decides. */
const freshSql = (column: unknown) =>
  sql<boolean>`(now() - ${column} <= make_interval(secs => ${LOGIN_NOTICE_FRESH_MS / 1000}))`;

export type LoginNoticeRole = 'member' | 'client';
type ReviewNoticeState = 'accepted' | 'returned' | 'taken';

export type LoginNotice =
  | { kind: 'chat'; loginId: string; id: string }
  | { kind: 'review'; loginId: string; id: string; state: ReviewNoticeState }
  | { kind: 'comment'; id: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isId = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);

/** Parse a NOTIFY payload; null when it is not one of ours. */
export function parseLoginNotice(payload: string): LoginNotice | null {
  let p: Record<string, unknown>;
  try {
    p = JSON.parse(payload) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!p || typeof p !== 'object' || !isId(p.id)) return null;
  if (p.kind === 'comment') return { kind: 'comment', id: p.id };
  if (!isId(p.loginId)) return null;
  if (p.kind === 'chat') return { kind: 'chat', loginId: p.loginId, id: p.id };
  if (
    p.kind === 'review' &&
    (p.state === 'accepted' || p.state === 'returned' || p.state === 'taken')
  ) {
    return { kind: 'review', loginId: p.loginId, id: p.id, state: p.state };
  }
  return null;
}

/** One message for one login: what the push worker seals and sends. */
export type LoginNoticeMessage = {
  /** The ONE login this is for. */
  loginId: string;
  role: LoginNoticeRole;
  ownerId: string;
  kind: 'chat' | 'review' | 'comment';
  title: string;
  body: string;
  deepLink: string;
  itemId?: string;
  state?: ReviewNoticeState;
  collapseKey: string;
};

function clip(s: string, max: number): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length <= max ? one : `${one.slice(0, max - 1)}…`;
}

/** The login, when it is an active member or client (else null: an admin,
 *  a disabled login and a role this code does not know are told nothing). */
async function noticeLogin(loginId: string): Promise<{ id: string; role: LoginNoticeRole } | null> {
  const [row] = await db
    .select({ id: authUsers.id, role: authUsers.role, disabledAt: authUsers.disabledAt })
    .from(authUsers)
    .where(eq(authUsers.id, loginId))
    .limit(1);
  const role: string | undefined = row?.role;
  if (!row || row.disabledAt || (role !== 'member' && role !== 'client')) return null;
  return { id: row.id, role };
}

/** How much of a reply a teaser reads (markdownPreview reads no more). */
const TEASER_READ_MAX = 4000;

/**
 * A chat reply as a lock-screen line: plain words, one line, clipped. A reply
 * is markdown and a notification renders none of it, so the marks go
 * (markdownPreview). Pictures go whole, alt text too, BEFORE that: the
 * reader's chat route already took out every picture the reader may not see
 * and escaped what it could not read, and neither may come back as words.
 * Never empty: a reply with no words says "New message".
 */
export function chatTeaser(text: string, max = 140): string {
  // Cut first: the picture pattern is slow on a long run of `![`, and a
  // preview reads only the start (markdownPreview reads 4000 characters).
  // A picture the cut splits loses its tail too, so its alt text never
  // becomes words.
  const noPictures = text
    .slice(0, TEASER_READ_MAX)
    .replace(/!\\?\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/!\\?\[[^\]]*(\]\([^)]*)?$/, ' ');
  return markdownPreview(noPictures, max) || 'New message';
}

/**
 * A finished reply in a login's own chat thread. Null when the row is not a
 * finished outbound row of that login's thread, is old, or the login is not
 * an active member or client.
 */
export function chatReplyNotice(n: {
  loginId: string;
  id: string;
}): Promise<LoginNoticeMessage | null> {
  return asSystem(async () => {
    const [msg] = await db
      .select({
        ownerId: teamMessages.ownerId,
        loginId: teamMessages.loginId,
        direction: teamMessages.direction,
        status: teamMessages.status,
        text: teamMessages.text,
        agentId: teamMessages.agentId,
        fresh: freshSql(teamMessages.createdAt),
      })
      .from(teamMessages)
      .where(eq(teamMessages.id, n.id))
      .limit(1);
    if (!msg || msg.loginId !== n.loginId) return null;
    if (msg.direction !== 'outbound' || msg.status !== 'complete') return null;
    if (!msg.fresh) return null;
    const login = await noticeLogin(n.loginId);
    if (!login) return null;

    // The text exactly as the reader's chat route returns it.
    const reader = login.role === 'client' ? 'client' : 'team';
    const [text] = await chatTextsForReader(msg.ownerId, reader, [msg.text]);
    let title: string | null = null;
    if (msg.agentId) {
      const [agent] = await db
        .select({ name: agents.name })
        .from(agents)
        .where(and(eq(agents.id, msg.agentId), eq(agents.ownerId, msg.ownerId)))
        .limit(1);
      title = agent?.name ?? null;
    }
    // An admin's note (no agent): the brain's own name, never the admin's.
    title ??= (await loadPreferencesFor(msg.ownerId)).siteName ?? null;
    return {
      loginId: login.id,
      role: login.role,
      ownerId: msg.ownerId,
      kind: 'chat',
      title: title?.trim() || 'New message',
      body: chatTeaser(text ?? ''),
      deepLink: '/portal/chat',
      collapseKey: 'chat',
    };
  });
}

/** Which of a bundle's items names it: a page before a note, a table, a
 *  drawing, a file (the parts a page embeds come last). */
const TYPE_RANK = ['page', 'note', 'table', 'draw', 'file'];
const rank = (type: string) => {
  const i = TYPE_RANK.indexOf(type);
  return i < 0 ? TYPE_RANK.length : i;
};

/**
 * A review result for an author: its item (or its bundle, `nodeIds`: Accept
 * and Take over change every item of a bundle in one transaction) was
 * accepted, returned or taken over. ONE message, naming the bundle's main
 * item. Null when no row is the author's in that state now, the change is
 * old, or the author is not an active member or client.
 */
export function reviewResultNotice(
  loginId: string,
  state: ReviewNoticeState,
  nodeIds: readonly string[],
): Promise<LoginNoticeMessage | null> {
  return asSystem(async () => {
    if (!nodeIds.length) return null;
    const login = await noticeLogin(loginId);
    if (!login) return null;
    const rows = await db
      .select({
        id: nodes.id,
        type: nodes.type,
        title: nodes.title,
        takenTitle: spaceItems.takenTitle,
        // The title as accepted (the snapshot taken at Accept): after Accept
        // the item is the brain's, and an admin's later rename is not the
        // author's to read.
        acceptedTitle: acceptedSnapshots.title,
        takenRoot: spaceItems.takenRoot,
        fresh: freshSql(spaceItems.updatedAt),
      })
      .from(spaceItems)
      .innerJoin(nodes, eq(nodes.id, spaceItems.nodeId))
      .leftJoin(acceptedSnapshots, eq(acceptedSnapshots.nodeId, spaceItems.nodeId))
      .where(
        and(
          inArray(spaceItems.nodeId, [...nodeIds]),
          eq(spaceItems.authorLoginId, loginId),
          eq(spaceItems.reviewState, state),
        ),
      );
    const live = rows.filter((r) => r.fresh);
    if (!live.length) return null;
    const main = [...live].sort(
      (a, b) =>
        Number(!!a.takenRoot) - Number(!!b.takenRoot) ||
        rank(a.type) - rank(b.type) ||
        a.id.localeCompare(b.id),
    )[0]!;
    const [anchor] = await db
      .select({ id: spaces.id })
      .from(spaces)
      .where(eq(spaces.kind, 'brain'))
      .limit(1);
    if (!anchor) return null;

    // The author's own title for it: while an admin holds it, the title it
    // had when taken; once accepted, the title it was accepted with; never
    // an admin's working title or later rename.
    const known =
      state === 'taken' ? main.takenTitle : state === 'accepted' ? main.acceptedTitle : null;
    const name = `"${clip(known || main.title || 'Untitled', 80)}"`;

    // No reviewer text: review flows carry no messages (2026-10-09).
    const words =
      state === 'accepted'
        ? { title: 'Accepted', body: `${name} was accepted.` }
        : state === 'returned'
          ? { title: 'Returned', body: `${name} was returned.` }
          : { title: 'With an admin', body: `An admin is working on ${name}.` };
    return {
      loginId: login.id,
      role: login.role,
      ownerId: anchor.id,
      kind: 'review',
      ...words,
      // A taken item is in the admin's space: the author has its row in the
      // list, not a page to open.
      deepLink: state === 'taken' ? '/portal/items' : `/portal/items/${main.id}`,
      itemId: main.id,
      state,
      collapseKey: `review:${main.id}`,
    };
  });
}

/**
 * A new comment: who is told. On a personal item in its author's own space,
 * the author (unless the author wrote it). On a brain item's client thread,
 * every active client login but the writer, while the item is at client
 * level. Every other comment (an admin's talk on a brain item, a thread on
 * an item an admin holds) tells nobody.
 */
export function commentNotices(commentId: string): Promise<LoginNoticeMessage[]> {
  return asSystem(async () => {
    const [c] = await db
      .select({
        nodeId: nodeComments.nodeId,
        ownerId: nodeComments.ownerId,
        writer: nodeComments.loginId,
        authorName: nodeComments.authorName,
        body: nodeComments.body,
        scope: nodeComments.threadScope,
        fresh: freshSql(nodeComments.createdAt),
        title: nodes.title,
        space: nodes.ownerId,
        spaceKind: spaces.kind,
        spaceLogin: spaces.loginId,
        itemAuthor: spaceItems.authorLoginId,
      })
      .from(nodeComments)
      .innerJoin(nodes, eq(nodes.id, nodeComments.nodeId))
      .innerJoin(spaces, eq(spaces.id, nodes.ownerId))
      .leftJoin(spaceItems, eq(spaceItems.nodeId, nodes.id))
      .where(eq(nodeComments.id, commentId))
      .limit(1);
    if (!c || !c.fresh) return [];
    // The comment as plain words; one with no words (a picture) still says
    // who commented on what. Names and titles are names, not markdown: they
    // are shown as they are.
    const said = markdownPreview(c.body, 100);
    const where = `${clip(c.authorName, 40)} on "${clip(c.title || 'Untitled', 60)}"`;
    const words = {
      kind: 'comment' as const,
      ownerId: c.ownerId,
      title: 'New comment',
      body: said ? `${where}: ${said}` : where,
      itemId: c.nodeId,
      collapseKey: `comment:${c.nodeId}`,
    };

    if (c.spaceKind === 'personal') {
      // The item is in its author's own space (not one an admin took over).
      if (!c.itemAuthor || c.spaceLogin !== c.itemAuthor || c.writer === c.itemAuthor) return [];
      const login = await noticeLogin(c.itemAuthor);
      if (!login) return [];
      return [
        {
          ...words,
          loginId: login.id,
          role: login.role,
          deepLink: `/portal/items/${c.nodeId}`,
        },
      ];
    }

    if (c.spaceKind !== 'brain' || c.scope !== 'client') return [];
    // The thread's own rule (client-thread.ts): a brain item at client level.
    const [open] = await db
      .select({ id: nodes.id })
      .from(nodes)
      .where(
        and(
          eq(nodes.id, c.nodeId),
          eq(nodes.ownerId, c.ownerId),
          readAtSql(['client'], { embeds: false }),
          sql`mantle_workspace_kind(${nodes.type})`,
        ),
      )
      .limit(1);
    if (!open) return [];
    // Every active client, read in pages of MAX_LOGINS_PER_NOTICE (by id),
    // up to MAX_CLIENTS_PER_NOTICE: a brain with more than one page of
    // clients tells them all, not the same first page every time.
    const clients: Array<{ id: string }> = [];
    let after: string | null = null;
    while (clients.length < MAX_CLIENTS_PER_NOTICE) {
      const page: Array<{ id: string }> = await db
        .select({ id: authUsers.id })
        .from(authUsers)
        .where(
          and(
            eq(authUsers.role, 'client'),
            isNull(authUsers.disabledAt),
            ...(c.writer ? [ne(authUsers.id, c.writer)] : []),
            ...(after ? [gt(authUsers.id, after)] : []),
          ),
        )
        .orderBy(authUsers.id)
        .limit(MAX_LOGINS_PER_NOTICE);
      clients.push(...page);
      if (page.length < MAX_LOGINS_PER_NOTICE) break;
      after = page[page.length - 1]!.id;
    }
    // On a thread every client reads, the lock screen says who commented on
    // what and not what they wrote: one client's words do not appear on
    // every other client's phone. The app shows the comment.
    return clients.map((login) => ({
      ...words,
      body: `${clip(c.authorName, 40)} commented on "${clip(c.title || 'Untitled', 60)}"`,
      loginId: login.id,
      role: 'client' as const,
      deepLink: `/portal/shared/${c.nodeId}`,
    }));
  });
}
