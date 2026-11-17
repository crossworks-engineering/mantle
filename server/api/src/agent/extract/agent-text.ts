/**
 * The fields in the file's text (docs/pipelines.md, "Agents"): after an
 * Agent's run wrote its tabs, the text of those tabs goes on the file node,
 * `data.agent_text`, one text for each Agent by its id. `search_tsv` is
 * generated over the whole data blob, so a plain search finds a drawing by
 * its line number, its tags or its title block. `file_sql` reads the same
 * values from the tabs. The same text goes into the file's passages
 * (`content_chunks`, ./index-writes.ts writeRetrievalChunks), so a search
 * of the passages finds them too: the extract adds it, and a run that
 * changed it builds the passages again from the stored text.
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
 *  take that Agent's text out when `text` is ''. Only while the node still
 *  holds the bytes `sha256` the tabs were read from: new bytes in between
 *  get no text of the old ones. True when a row changed. */
export async function writeAgentText(
  ownerId: string,
  nodeId: string,
  sha256: string,
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
          sql`${nodes.data}->>'sha256' = ${sha256}`,
          // The name-only mode keeps no text of the file's content.
          sql`coalesce(${nodes.data}->>'indexing_applied', '') <> 'metadata'`,
        ),
      )
      .returning({ id: nodes.id });
    return rows.length > 0;
  });
}

/** The text of every Agent on the file node now, by Agent id, for the
 *  file's passages: '' when it has none. Read at the write of the
 *  passages, so a run that ended during an extract is in them. */
export async function agentTextNow(nodeId: string): Promise<string> {
  const [row] = await db
    .select({ text: sql<unknown>`${nodes.data}->'agent_text'` })
    .from(nodes)
    .where(eq(nodes.id, nodeId));
  const all = row?.text;
  if (typeof all !== 'object' || all === null || Array.isArray(all)) return '';
  return Object.keys(all)
    .sort()
    .map((id) => (all as Record<string, unknown>)[id])
    .filter((t): t is string => typeof t === 'string' && t !== '')
    .join('\n\n');
}
