/**
 * Client-sourced text and the lowering guard (client logins C4, plan section
 * 8, review 1 R12, review 2 N18).
 *
 * Text a CLIENT wrote reaches staff agents: a client request (a task,
 * `data.source = 'client-request'`) and a client login's chat thread (read by
 * `team_chat_read`). An instruction hidden in it ("make the pricing page
 * public") could steer a staff agent. Fencing it as data helps, but it does
 * not stop an obedient model, so the one class of act that would hand brain
 * content OUT to clients or the public is gated instead: in a turn that has
 * read client-sourced text, a lowering to client or public goes to pending
 * approval (/pending) instead of running.
 *
 * "Read" is decided by ids: every tool call's input and output, and the
 * retrieval context of the turn, are scanned for uuids, and one query asks
 * whether any names a client request task, a client login or an item a
 * client wrote (client logins C5). Tools name the
 * items they return by id, so text that reaches the model from a client
 * request carries its id with it. A false positive only costs a click on
 * /pending; a missed read would cost the guard, so the scan errs wide.
 *
 * What waits once a turn is marked (client logins C5 audit fixes, L2/I1) is
 * decided by the call's TARGET, not by a list of tool names: every built-in
 * write tool is classified in client-sourced-rules.ts, and a write into an
 * item at client or public level, or a lowering to client or public, waits.
 * The mark also outlives the turn: it is kept on the conversation for 24
 * hours after the last client-sourced read (I9), and a node a marked turn
 * creates carries it too (L10, `client_sourced_nodes`).
 *
 * Client apps (client logins C6): a client writes an app's SQLite at client
 * level, and an app-table export copies those rows into an admin-level brain
 * Table. Such a table is client-sourced while its app is at client level, and
 * after a client has written the app, whatever its level
 * (`clientAppExportsAmong`, client tier audit I3).
 */
import { and, eq, inArray, isNotNull, or, sql } from 'drizzle-orm';
import {
  appDatabases,
  appTableExports,
  authUsers,
  CLIENT_REQUEST_SOURCE,
  clientSourcedNodes,
  conversationTaints,
  db,
  nodes,
  spaceItems,
} from '@mantle/db';
import { asSystem } from '@mantle/db/viewer';

/** A turn's taint, shared by reference across the turn (and its delegated
 *  children: a child that reads client text taints the parent too). */
export type TurnTaint = {
  /** The turn has read text a client wrote. */
  clientSourced: boolean;
  /** What tainted it first, for the pending card and the trace. */
  via?: string;
  /** The conversation the mark is kept on (I9): a read in this turn renews
   *  the conversation's mark, so its next turn starts marked. Absent for a
   *  loop with no conversation (a heartbeat, a run worker, a simulation). */
  conversation?: { ownerId: string; key: string };
  /** The mark came from an earlier turn of the conversation and no read in
   *  this turn has renewed it yet. */
  carried?: true;
};

export function newTurnTaint(): TurnTaint {
  return { clientSourced: false };
}

const UUID_G = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
/** Ids one query checks. Every id of a result is checked, in batches of this
 *  many (L8: a cut-off list let a request deep in a big task_list through). */
export const ID_BATCH = 1000;

/** Every distinct uuid in `text`, lower-cased. */
export function uuidsIn(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(UUID_G)) out.add(m[0].toLowerCase());
  return [...out];
}

function batches<T>(list: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += ID_BATCH) out.push(list.slice(i, i + ID_BATCH));
  return out;
}

/**
 * Which of `ids` name a brain Table exported from an app clients write
 * (client logins C6): an app at client level NOW, or one a client login has
 * written (`app_databases.client_written_at`, client tier audit I3). The
 * export copies the app's rows into the table, and the rows a client wrote
 * stay in the app's database, and so in every later export, whatever the
 * app's level becomes. So the mark is set by the level, and once a client
 * has written it holds: raising the app above client does not clear it.
 * The Table itself is also marked in `client_sourced_nodes` once it holds
 * rows clients wrote (app-table-exports.ts), so the mark outlives the link
 * and the app. Call as the system.
 */
function clientAppExportsAmong(ownerId: string, list: readonly string[]) {
  return db
    .select({ id: appTableExports.tableNodeId })
    .from(appTableExports)
    .innerJoin(nodes, eq(nodes.id, appTableExports.appNodeId))
    .leftJoin(appDatabases, eq(appDatabases.appNodeId, appTableExports.appNodeId))
    .where(
      and(
        eq(appTableExports.ownerId, ownerId),
        inArray(appTableExports.tableNodeId, [...list]),
        // At client level by its own level OR through a client-shared folder
        // (the row policy's union rule, item-level.ts).
        or(
          eq(nodes.audience, 'client'),
          eq(nodes.inheritedLevel, 'client'),
          isNotNull(appDatabases.clientWrittenAt),
        ),
      ),
    );
}

/**
 * Whether any of `ids` names client-sourced text: a client request task of
 * this brain, a client login (its chat thread), an item a client wrote
 * (client logins C5): a `space_items` row stamped `author_role` 'client',
 * in any state (submitted, taken over, accepted into the brain), or a node a
 * marked staff turn created (`client_sourced_nodes`, L10), or a Table
 * exported from an app at client level or one a client wrote (C6: clients
 * write its rows). The stamp
 * outlives the client login, so an item accepted from a client's space still
 * counts after that login is deleted. As the system: the tasks
 * are admin level and the check must see them whatever the turn's level. It
 * answers yes or no and returns no content. Every id is checked, in batches.
 */
export async function namesClientSourced(
  ownerId: string,
  ids: readonly string[],
): Promise<boolean> {
  if (ids.length === 0) return false;
  return asSystem(async () => {
    for (const list of batches(ids)) {
      const [task] = await db
        .select({ id: nodes.id })
        .from(nodes)
        .where(
          and(
            eq(nodes.ownerId, ownerId),
            inArray(nodes.id, list),
            sql`${nodes.data}->>'source' = ${CLIENT_REQUEST_SOURCE}`,
          ),
        )
        .limit(1);
      if (task) return true;
      const [login] = await db
        .select({ id: authUsers.id })
        .from(authUsers)
        .where(and(inArray(authUsers.id, list), eq(authUsers.role, 'client')))
        .limit(1);
      if (login) return true;
      const [written] = await db
        .select({ id: spaceItems.nodeId })
        .from(spaceItems)
        .where(and(inArray(spaceItems.nodeId, list), eq(spaceItems.authorRole, 'client')))
        .limit(1);
      if (written) return true;
      const [copied] = await db
        .select({ id: clientSourcedNodes.nodeId })
        .from(clientSourcedNodes)
        .where(
          and(eq(clientSourcedNodes.ownerId, ownerId), inArray(clientSourcedNodes.nodeId, list)),
        )
        .limit(1);
      if (copied) return true;
      const [exported] = await clientAppExportsAmong(ownerId, list).limit(1);
      if (exported) return true;
    }
    return false;
  });
}

/**
 * Which of `ids` (node ids) are client-sourced items: client request tasks,
 * items a client wrote, nodes a marked turn created, tables exported from a
 * client-level or client-written app. For callers that must
 * leave such items out rather than mark a turn (the owner's corpus map, L4).
 * As the system, like namesClientSourced.
 */
export async function clientSourcedAmong(
  ownerId: string,
  ids: readonly string[],
): Promise<Set<string>> {
  const out = new Set<string>();
  if (ids.length === 0) return out;
  await asSystem(async () => {
    for (const list of batches(ids)) {
      const tasks = await db
        .select({ id: nodes.id })
        .from(nodes)
        .where(
          and(
            eq(nodes.ownerId, ownerId),
            inArray(nodes.id, list),
            sql`${nodes.data}->>'source' = ${CLIENT_REQUEST_SOURCE}`,
          ),
        );
      const written = await db
        .select({ id: spaceItems.nodeId })
        .from(spaceItems)
        .where(and(inArray(spaceItems.nodeId, list), eq(spaceItems.authorRole, 'client')));
      const copied = await db
        .select({ id: clientSourcedNodes.nodeId })
        .from(clientSourcedNodes)
        .where(
          and(eq(clientSourcedNodes.ownerId, ownerId), inArray(clientSourcedNodes.nodeId, list)),
        );
      const exported = await clientAppExportsAmong(ownerId, list);
      for (const r of [...tasks, ...written, ...copied, ...exported]) out.add(r.id);
    }
  });
  return out;
}

/**
 * `rows` without the client-sourced items among them (L4). The owner's corpus
 * map (the recent titles every owner prompt carries) uses this rather than
 * marking the turn: a map that held a client request would mark nearly every
 * owner turn, and a guard that always asks trains the owner to approve
 * without reading. Left out, a client's title reaches a staff turn only
 * through a read, and every read is scanned. A failed check leaves out
 * everything (fail closed: no map this turn).
 */
export async function withoutClientSourced<T extends { id: string }>(
  ownerId: string,
  rows: readonly T[],
): Promise<T[]> {
  try {
    const drop = await clientSourcedAmong(
      ownerId,
      rows.map((r) => r.id),
    );
    return rows.filter((r) => !drop.has(r.id));
  } catch (err) {
    console.warn('[client-sourced] corpus map check failed, map left out:', err);
    return [];
  }
}

/** Mark `taint` when `text` names client-sourced text. Never throws: a failed
 *  check marks the turn (fail closed: approval instead of a silent pass). */
export async function taintFromText(
  taint: TurnTaint,
  ownerId: string,
  text: string,
  via: string,
): Promise<void> {
  // A carried mark still looks: a new read renews the conversation's window.
  if (taint.clientSourced && !taint.carried) return;
  const ids = uuidsIn(text);
  if (ids.length === 0) return;
  let hit: boolean;
  try {
    hit = await namesClientSourced(ownerId, ids);
  } catch {
    hit = true;
  }
  if (hit) {
    taint.clientSourced = true;
    taint.via = via;
    delete taint.carried;
    if (taint.conversation) await keepConversationTaint(taint.conversation, via);
  }
}

// ── The conversation's mark (I9) ─────────────────────────────────────────────

/** How long a conversation stays marked after its last client-sourced read. */
export const CONVERSATION_TAINT_HOURS = 24;

/**
 * The conversation a turn belongs to, for its mark: the owner's conversation
 * with an agent is one across channels (web, Telegram, voice share one
 * history), a login's conversation with an agent (a member's or a client's
 * surface names the login) is its own.
 */
export function conversationTaintKey(
  agentId: string,
  surface?: { kind: string; loginId?: string } | null,
): string {
  const loginId = surface?.loginId;
  return loginId ? `login:${loginId}:agent:${agentId}` : `agent:${agentId}`;
}

/**
 * The taint a turn of this conversation starts with: marked (carried) when a
 * turn of it read client-sourced text in the last CONVERSATION_TAINT_HOURS.
 * A failed read marks it (fail closed). SQL only: no trigger, no model.
 */
export async function loadConversationTaint(ownerId: string, key: string): Promise<TurnTaint> {
  const taint: TurnTaint = { clientSourced: false, conversation: { ownerId, key } };
  try {
    const [row] = await asSystem(() =>
      db
        .select({ via: conversationTaints.via })
        .from(conversationTaints)
        .where(
          and(
            eq(conversationTaints.ownerId, ownerId),
            eq(conversationTaints.conversationKey, key),
            sql`${conversationTaints.taintedAt} > now() - make_interval(hours => ${CONVERSATION_TAINT_HOURS})`,
          ),
        )
        .limit(1),
    );
    if (row) {
      taint.clientSourced = true;
      taint.via = `an earlier turn (${row.via})`;
      taint.carried = true;
    }
  } catch {
    taint.clientSourced = true;
    taint.via = 'the conversation check failed';
    taint.carried = true;
  }
  return taint;
}

/** Mark the conversation (or renew its mark) from now. A failed write is
 *  logged: the turn itself is marked either way. */
async function keepConversationTaint(
  conv: { ownerId: string; key: string },
  via: string,
): Promise<void> {
  try {
    await asSystem(() =>
      db
        .insert(conversationTaints)
        .values({ ownerId: conv.ownerId, conversationKey: conv.key, via })
        .onConflictDoUpdate({
          target: [conversationTaints.ownerId, conversationTaints.conversationKey],
          set: { via, taintedAt: sql`now()` },
        }),
    );
  } catch (err) {
    console.warn('[client-sourced] could not keep the conversation mark:', err);
  }
}

// ── Nodes a marked turn creates (L10) ───────────────────────────────────────

/**
 * Mark the nodes a call of a marked turn just created: the ids in its output
 * that name a node of this brain created within the last `withinMs` (the
 * call's own duration, measured on the database clock with a small margin).
 * Written by the tool loop as the system, never by a tool or the model.
 * Returns how many were marked; a failure is logged, never thrown.
 */
export async function markCreatedClientSourced(
  ownerId: string,
  outputText: string,
  withinMs: number,
  via: string,
): Promise<number> {
  const ids = uuidsIn(outputText);
  if (ids.length === 0) return 0;
  const secs = Math.ceil(Math.max(0, withinMs) / 1000) + 2;
  let marked = 0;
  try {
    await asSystem(async () => {
      for (const list of batches(ids)) {
        const created = await db
          .select({ id: nodes.id })
          .from(nodes)
          .where(
            and(
              eq(nodes.ownerId, ownerId),
              inArray(nodes.id, list),
              sql`${nodes.createdAt} >= now() - make_interval(secs => ${secs})`,
            ),
          );
        if (created.length === 0) continue;
        const rows = await db
          .insert(clientSourcedNodes)
          .values(created.map((c) => ({ nodeId: c.id, ownerId, via })))
          .onConflictDoNothing()
          .returning({ id: clientSourcedNodes.nodeId });
        marked += rows.length;
      }
    });
  } catch (err) {
    console.warn('[client-sourced] could not mark created nodes:', err);
  }
  return marked;
}

/** The tools whose whole purpose is to hand brain content to clients or the
 *  public. Writes INTO an item already at client or public level are the
 *  other half of the guard (client-sourced-rules.ts). */
export const LOWERING_TOOL_SLUGS: ReadonlySet<string> = new Set([
  'access_set',
  'node_share',
  'page_share',
  'email_page',
]);

/** A level as `access_set` reads it: trimmed, and lower-cased on top (L9), so
 *  no spelling the tool might accept slips past the check. */
function normalLevel(v: unknown): string {
  return typeof v === 'string' ? v.trim().toLowerCase() : '';
}

/**
 * Whether this call would lower something to client or public: `access_set`
 * to client or public (an item, an agent or a tool group), any share link
 * (public by construction), and `email_page` with a link.
 */
export function isLoweringCall(slug: string, input: Record<string, unknown>): boolean {
  switch (slug) {
    case 'access_set': {
      const level = normalLevel(input.level);
      return level === 'client' || level === 'public';
    }
    case 'node_share':
    case 'page_share':
      return true;
    case 'email_page':
      return input.includeLink === true || input.includeLink === 'true';
    default:
      return false;
  }
}
