/**
 * Team change-requests. A team member's change ask is filed by
 * `team_request_create` as a task tagged `team-request` carrying a
 * `data.teamRequest` provenance block (contactId, contactName,
 * threadMessageId, attachments); an admin works it on the Tasks board. This
 * module holds the caps and the counts. The Team admin Requests list and its
 * reply were removed in workspaces W5c.
 */
import { and, count, eq, gte, sql } from 'drizzle-orm';
import { clientRequestFilings, db, nodes } from '@mantle/db';

export const TEAM_REQUEST_TAG = 'team-request';

/**
 * How many requests a member may file through the team agent (audit F08).
 * Each one is an admin task; the caps keep a runaway or
 * injected turn from flooding it. Per turn = per inbound message; per day =
 * the last 24 hours, per member login.
 */
export const TEAM_REQUESTS_PER_TURN = 3;
export const TEAM_REQUESTS_PER_DAY = 20;

/**
 * A CLIENT's request (client logins C4, `client_request_create`) is a team
 * request too: the same task, tag and Requests queue, so an admin's reply
 * reaches the client's thread by login. It also carries this tag, and
 * `data.source = 'client-request'` (client-sourced text, extract-exempt until
 * an admin acts). Lower caps than a member's (plan section 8).
 */
export const CLIENT_REQUEST_TAG = 'client-request';
export const CLIENT_REQUESTS_PER_TURN = 3;
export const CLIENT_REQUESTS_PER_DAY = 10;

/**
 * Team requests already filed: those stamped with this inbound message (the
 * turn), or by this requester since `since`. The tasks are homed in the
 * Admin workspace: a caller in a scope that does not read them must count
 * on the system pool (asSystem with a named reason), or it counts nothing
 * and the cap never closes.
 */
export async function countTeamRequestsFiled(
  ownerId: string,
  by:
    | { threadMessageId: string }
    | { loginId: string; since: Date }
    | { contactId: string; since: Date },
): Promise<number> {
  const conds = [
    eq(nodes.ownerId, ownerId),
    eq(nodes.type, 'task'),
    sql`${TEAM_REQUEST_TAG} = ANY(${nodes.tags})`,
  ];
  if ('threadMessageId' in by) {
    conds.push(sql`${nodes.data}->'teamRequest'->>'threadMessageId' = ${by.threadMessageId}`);
  } else {
    conds.push(gte(nodes.createdAt, by.since));
    conds.push(
      'loginId' in by
        ? sql`${nodes.data}->'teamRequest'->>'loginId' = ${by.loginId}`
        : sql`${nodes.data}->'teamRequest'->>'contactId' = ${by.contactId}`,
    );
  }
  const [row] = await db
    .select({ n: count() })
    .from(nodes)
    .where(and(...conds));
  return row?.n ?? 0;
}

/**
 * Client requests filed, from the ledger (client_request_filings, migration
 * 0197): those of this inbound message (the turn), or by this client login
 * since `since`. A row is written for every request filed and never removed
 * with the task, so deleting a request never gives the quota back (C5 audit
 * fix I12). The ledger is system data: count it on the system pool
 * (asSystem with a named reason inside a scope).
 */
export async function countClientRequestFilings(
  ownerId: string,
  by: { threadMessageId: string } | { loginId: string; since: Date },
): Promise<number> {
  const conds = [eq(clientRequestFilings.ownerId, ownerId)];
  if ('threadMessageId' in by) {
    conds.push(eq(clientRequestFilings.threadMessageId, by.threadMessageId));
  } else {
    conds.push(eq(clientRequestFilings.loginId, by.loginId));
    conds.push(gte(clientRequestFilings.createdAt, by.since));
  }
  const [row] = await db
    .select({ n: count() })
    .from(clientRequestFilings)
    .where(and(...conds));
  return row?.n ?? 0;
}

/** Record one client request filed, in the ledger the caps count. */
export async function recordClientRequestFiling(
  ownerId: string,
  row: { loginId: string; threadMessageId: string | null; taskId: string },
): Promise<void> {
  await db.insert(clientRequestFilings).values({ ownerId, ...row });
}

/** Unresolved team requests, counted (the Team admin badge): a task tagged
 *  team-request that is not done, with no cap. */
export async function countOpenTeamRequests(ownerId: string): Promise<number> {
  const [r] = await db
    .select({ n: count() })
    .from(nodes)
    .where(
      and(
        eq(nodes.ownerId, ownerId),
        eq(nodes.type, 'task'),
        sql`${TEAM_REQUEST_TAG} = ANY(${nodes.tags})`,
        sql`coalesce(${nodes.data}->>'status', 'open') <> 'done'`,
      ),
    );
  return Number(r?.n ?? 0);
}
