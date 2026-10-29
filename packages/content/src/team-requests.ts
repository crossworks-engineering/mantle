/**
 * Team change-requests. A team member's change ask is filed by
 * `team_request_create` as a task tagged `team-request` carrying a
 * `data.teamRequest` provenance block (contactId, contactName,
 * threadMessageId, attachments); an admin works it on the Tasks board. This
 * module holds the open count.
 */
import { and, count, eq, sql } from 'drizzle-orm';
import { db, nodes } from '@mantle/db';

export const TEAM_REQUEST_TAG = 'team-request';

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
