/**
 * The LLM-work cost guard: model work derived
 * from an item (a summary, facts, a vision or OCR read) runs only for an item
 * that at least one workspace with an assistant reads. Chunks and embeddings
 * (the local embedder) run for every item, so search works everywhere, and a
 * private workspace without an assistant costs nothing in LLM work, as a
 * personal space does.
 *
 * An item with an empty read_ws (no grant written) gets LLM work, as the
 * Admin assistant's does. Personal-space items never reach the extractor
 * (its owner check).
 */
import { sql } from 'drizzle-orm';
import { systemDb } from './client';
import { liveWorkspaceSql } from './workspace-live';

export async function llmWorkAllowed(nodeId: string): Promise<boolean> {
  const rows = (await systemDb.execute(sql`
    SELECT cardinality(n.read_ws) = 0 AS legacy,
           EXISTS (SELECT 1 FROM workspace_resources r
                     JOIN workspaces w ON w.id = r.workspace_id
                    WHERE r.type = 'assistant' AND ${liveWorkspaceSql('w')}
                      AND r.workspace_id = ANY (n.read_ws)) AS assistant
      FROM nodes n
     WHERE n.id = ${nodeId}`)) as unknown as { legacy: boolean; assistant: boolean }[];
  const r = rows[0];
  return !!r && (r.legacy || r.assistant);
}
