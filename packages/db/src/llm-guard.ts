/**
 * The LLM-work cost guard (workspaces plan 5.3, phase W2): model work derived
 * from an item (a summary, facts, a vision or OCR read) runs only for an item
 * that at least one workspace with an assistant reads. Chunks and embeddings
 * (the local embedder) run for every item, so search works everywhere, and a
 * private workspace without an assistant costs nothing in LLM work, as a
 * personal space does today.
 *
 * Works under today's levels too: until grants are written (W4) an item's
 * read_ws is empty, and the brain's items keep today's rule (they are the
 * Admin assistant's). Personal-space items never reach the extractor (its
 * owner check).
 */
import { sql } from 'drizzle-orm';
import { systemDb } from './client';

export async function llmWorkAllowed(nodeId: string): Promise<boolean> {
  const rows = (await systemDb.execute(sql`
    SELECT cardinality(n.read_ws) = 0 AS legacy,
           EXISTS (SELECT 1 FROM workspace_resources r
                     JOIN workspaces w ON w.id = r.workspace_id
                    WHERE r.type = 'assistant' AND w.archived_at IS NULL
                      AND r.workspace_id = ANY (n.read_ws)) AS assistant
      FROM nodes n
     WHERE n.id = ${nodeId}`)) as unknown as { legacy: boolean; assistant: boolean }[];
  const r = rows[0];
  return !!r && (r.legacy || r.assistant);
}
