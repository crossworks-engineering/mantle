/**
 * What a member login is told about on its phone (migration
 * mobile_roles_push, docs/mobile-companion-backend.md "Every login on the
 * phone"): a reply in its own chat thread, a review result on its own item.
 * There is no client login role, and the brain has no comments.
 *
 * The `login_notice` NOTIFY (raised by triggers) carries ids only. This
 * module turns one into the message for the ONE login it concerns: who is
 * told, and words that login could read by opening the app. The rule for
 * every teaser: never text its reader could not open.
 *
 *  - chat: the reply as the reader's own chat route returns it (pictures of
 *    items the reader may not read are already out, chat-images.ts). A
 *    member's only: the client chat went with the client portal (W5c).
 *    The reply is a row of the member's own thread in assistant_messages
 *    (0269, W7c), with the assistant's name as the title.
 *  - review: the author's own item. Its title while an admin holds it is
 *    the title it had when it was taken, never the admin's working title.
 *  - comment: no longer raised to anyone (a 'comment' payload parses to
 *    nothing).
 *
 * Nothing here sends: the push worker applies the login's toggles, finds its
 * live devices and seals the message (server/web/lib/push/login-notify.ts).
 * Reads run on the admin pool (the worker has no viewer scope); `asSystem`
 * makes that hold wherever this is called from. Nothing here starts LLM
 * work.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  acceptedSnapshots,
  agents,
  systemWork,
  assistantMessages,
  authUsers,
  db,
  nodes,
  spaceItems,
  spaces,
} from '@mantle/db';
import { markdownPreview } from '@mantle/content-core/markdown-to-text';
import { acceptedRank } from '@mantle/client-types/kind-lists';
import { chatTextsForReader } from './chat-images';
import { loadPreferencesFor } from './profile-preferences';
import { UUID_RE } from '@mantle/std';

/**
 * A login's notices are read and written on the system pool by the named
 * reason 'login-notice'. The push worker builds them, never a scope:
 * systemWork runs them on the system pool and refuses a scope.
 */
function loginNoticeSystem<T>(fn: () => Promise<T>): Promise<T> {
  return systemWork(fn, 'login-notice');
}

export const LOGIN_NOTICE_CHANNEL = 'login_notice';

/** An event older than this is not news: a backfill or a bulk repair that
 *  touches old rows must never page anyone. */
export const LOGIN_NOTICE_FRESH_MS = 30 * 60 * 1000;

/** "Is this row news?", asked of the DATABASE: the rows are stamped on its
 *  clock, so the worker's clock never decides. */
const freshSql = (column: unknown) =>
  sql<boolean>`(now() - ${column} <= make_interval(secs => ${LOGIN_NOTICE_FRESH_MS / 1000}))`;

export type LoginNoticeRole = 'member';
type ReviewNoticeState = 'accepted' | 'returned' | 'taken';

export type LoginNotice =
  | { kind: 'chat'; loginId: string; id: string }
  | { kind: 'review'; loginId: string; id: string; state: ReviewNoticeState };

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
  // A 'comment' payload (the node_comments trigger) is not ours: the brain
  // has no comments, so it parses to nothing.
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
  kind: 'chat' | 'review';
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

/**
 * Whether a login row is told login notices: an enabled member, a login
 * that is not an Admin user (`adminMember`: mantle_login_is_admin, read
 * with the row). An Admin user and a disabled login are told nothing. The
 * cells: login-notices-role.test.ts.
 */
export function toldLoginNotices(row: { adminMember: boolean; disabledAt: Date | null }): boolean {
  return !row.disabledAt && row.adminMember !== true;
}

/** The login, when it is told login notices (toldLoginNotices), else null. */
async function noticeLogin(loginId: string): Promise<{ id: string; role: LoginNoticeRole } | null> {
  const [row] = await db
    .select({
      id: authUsers.id,
      adminMember: sql<boolean>`"public"."mantle_login_is_admin"(${authUsers.id})`,
      disabledAt: authUsers.disabledAt,
    })
    .from(authUsers)
    .where(eq(authUsers.id, loginId))
    .limit(1);
  if (!row || !toldLoginNotices(row)) return null;
  return { id: row.id, role: 'member' };
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
  return loginNoticeSystem(async () => {
    const [msg] = await db
      .select({
        ownerId: assistantMessages.ownerId,
        loginId: assistantMessages.loginId,
        direction: assistantMessages.direction,
        status: assistantMessages.status,
        text: assistantMessages.text,
        agentId: assistantMessages.agentId,
        fresh: freshSql(assistantMessages.createdAt),
      })
      .from(assistantMessages)
      .where(eq(assistantMessages.id, n.id))
      .limit(1);
    if (!msg || msg.loginId !== n.loginId) return null;
    if (msg.direction !== 'outbound' || msg.status !== 'complete') return null;
    if (!msg.fresh) return null;
    const login = await noticeLogin(n.loginId);
    if (!login) return null;

    // The text exactly as the reader's chat route returns it.
    const [text] = await chatTextsForReader(msg.ownerId, 'team', n.loginId, [msg.text]);
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
 *  drawing, a file (the parts a page embeds come last). The kind registry's
 *  `accepted.rank`. */
const rank = acceptedRank;

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
  return loginNoticeSystem(async () => {
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

    // No reviewer text: review flows carry no messages.
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
