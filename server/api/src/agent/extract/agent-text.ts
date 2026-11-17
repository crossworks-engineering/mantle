/**
 * The fields in the file's text (docs/pipelines.md, "Agents"): after an
 * Agent's run wrote its tabs, the text of those tabs goes on the file node,
 * `data.agent_text`, one text for each Agent by its id. `search_tsv` is
 * generated over the whole data blob, so a plain search finds a drawing by
 * its line number, its tags or its title block. `file_sql` reads the same
 * values from the tabs.
 *
 * One write, with no model and no announcement: an UPDATE of a node's data
 * fires no extract (node_ingested is an INSERT notify), and `updated_at`
 * stays (mantle.keep_updated_at), so the extractor's safety nets do not read
 * the file as edited. The key is a byte key of the extractor's
 * (BYTE_DERIVED_DATA_KEYS, migration 0377): new bytes drop it, the
 * name-only mode strips it with `text` (gates.ts), and a file in that mode
 * gets none here. A file that is private gets no run at all
 * (runAgentOnFile).
 */
import { and, eq, sql } from 'drizzle-orm';
import { db, nodes } from '@mantle/db';

/** Put `text` on the file node as the text of the Agent `pipelineId`, or
 *  take that Agent's text out when `text` is ''. True when a row changed. */
export async function writeAgentText(
  ownerId: string,
  nodeId: string,
  pipelineId: string,
  text: string,
): Promise<boolean> {
  const all = sql`coalesce(${nodes.data}->'agent_text', '{}'::jsonb)`;
  const next =
    text === ''
      ? sql`${all} - ${pipelineId}::text`
      : sql`${all} || jsonb_build_object(${pipelineId}::text, ${text}::text)`;
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('mantle.keep_updated_at', 'on', true)`);
    const rows = await tx
      .update(nodes)
      .set({ data: sql`${nodes.data} || jsonb_build_object('agent_text', ${next})` })
      .where(
        and(
          eq(nodes.id, nodeId),
          eq(nodes.ownerId, ownerId),
          // The name-only mode keeps no text of the file's content.
          sql`coalesce(${nodes.data}->>'indexing_applied', '') <> 'metadata'`,
        ),
      )
      .returning({ id: nodes.id });
    return rows.length > 0;
  });
}
