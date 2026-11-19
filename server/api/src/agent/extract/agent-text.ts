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
import { db, FILE_READ_PARTIAL_CHANNEL, nodes } from '@mantle/db';
import { AGENT_TEXT_MAX_CHARS } from '@mantle/content/pipeline-agent';

/** The key of an Agent's cut in `data.read_cut` (@mantle/files read-cut.ts):
 *  `agent_text:<id>`, the id in the characters a key takes. */
export function agentTextCutKey(pipelineId: string): string {
  return `agent_text:${pipelineId.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 80) || '_'}`;
}

/** Put `text` on the file node as the text of the Agent `pipelineId`, or
 *  take that Agent's text out when `text` is ''. Only while the node still
 *  holds the bytes `sha256` the tabs were read from: new bytes in between
 *  get no text of the old ones. True when the text changed: the same text
 *  again (a run that paid nothing) writes no row of it.
 *
 *  The text in the file's text is at most AGENT_TEXT_MAX_CHARS; a longer
 *  one is cut there and the cut is said (`read_cut['agent_text:<id>']`,
 *  docs/files.md, "Read in part"), so the file reads as read in part. Every
 *  row of the tabs stays in the database (file_sql). The cut is written
 *  whenever it differs, the text the same or not. */
export async function writeAgentText(
  ownerId: string,
  nodeId: string,
  sha256: string,
  pipelineId: string,
  fullText: string,
): Promise<boolean> {
  const text = fullText.slice(0, AGENT_TEXT_MAX_CHARS);
  const cutKey = agentTextCutKey(pipelineId);
  const cut =
    fullText.length > text.length
      ? JSON.stringify({
          what: 'characters',
          read: text.length,
          total: fullText.length,
          limit: AGENT_TEXT_MAX_CHARS,
        })
      : null;
  const all = sql`coalesce(${nodes.data}->'agent_text', '{}'::jsonb)`;
  const next =
    text === ''
      ? sql`${all} - ${pipelineId}::text`
      : sql`${all} || jsonb_build_object(${pipelineId}::text, ${text}::text)`;
  const cuts = sql`coalesce(${nodes.data}->'read_cut', '{}'::jsonb)`;
  const nextCuts =
    cut === null
      ? sql`(${cuts} - ${cutKey}::text)`
      : sql`(${cuts} || jsonb_build_object(${cutKey}::text, ${cut}::jsonb))`;
  const textDiffers = sql`coalesce(${nodes.data}->'agent_text'->>${pipelineId}::text, '') <> ${text}::text`;
  const cutDiffers =
    cut === null
      ? sql`${cuts} ? ${cutKey}::text`
      : sql`(${nodes.data}->'read_cut'->${cutKey}::text) is distinct from ${cut}::jsonb`;
  const where = and(
    eq(nodes.id, nodeId),
    eq(nodes.ownerId, ownerId),
    sql`${nodes.data}->>'sha256' = ${sha256}`,
    // The name-only mode keeps no text of the file's content.
    sql`coalesce(${nodes.data}->>'indexing_applied', '') <> 'metadata'`,
  );
  const changed = await db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('mantle.keep_updated_at', 'on', true)`);
    // The row as it is, locked: whether the text and the cut differ.
    const [now] = await tx
      .select({ text: sql<boolean>`${textDiffers}`, cut: sql<boolean>`${cutDiffers}` })
      .from(nodes)
      .where(where)
      .for('update');
    if (!now || (!now.text && !now.cut)) return { text: false, newCut: false };
    await tx
      .update(nodes)
      .set({
        // An empty map is no cut: the key goes.
        data: sql`case when ${nextCuts} = '{}'::jsonb
          then (${nodes.data} - 'read_cut') || jsonb_build_object('agent_text', ${next})
          else ${nodes.data} || jsonb_build_object('agent_text', ${next}, 'read_cut', ${nextCuts}) end`,
      })
      .where(where);
    return { text: now.text, newCut: now.cut && cut !== null };
  });
  // A new cut: the admins' phones hear of it, as at the end of a read
  // (FILE_READ_PARTIAL_CHANNEL; notify only, best effort).
  if (changed.newCut) {
    await db
      .execute(sql`SELECT pg_notify(${FILE_READ_PARTIAL_CHANNEL}, ${ownerId}::text)`)
      .catch(() => undefined);
  }
  return changed.text;
}

/** The heading of the Agents' text in a file's passages: the passages of
 *  it are of this section, not of the body's last heading. */
export const AGENT_TEXT_HEADING = '# Read by the Agents';

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
