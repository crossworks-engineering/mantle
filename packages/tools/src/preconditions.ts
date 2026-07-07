/**
 * Declarative per-tool preconditions, checked centrally before a builtin's
 * handler runs (see dispatch.ts).
 *
 * The biggest wrong-usage class after schema violations is referential: an
 * operation aimed at an id that doesn't exist, or that names a node of the
 * WRONG TYPE (a note id passed to a page tool). Handlers catch the first
 * case with scattered, inconsistently-worded checks and rarely catch the
 * second at all — the query just misses and the error says "not found",
 * hiding the real mistake. Declaring the requirement on the tool def gives
 * every flagged tool the same three teaching errors:
 *
 *   · malformed id  → "'page_id' must be a node id (UUID), got 'Overview'
 *                      — pass the id, not the title (find it with …)"
 *   · missing node  → the standard notFound() teaching error
 *   · wrong type    → "id … is a note, not a page — pass a page id …"
 *
 * One indexed PK lookup per flagged param — sub-ms; handlers keep their own
 * checks as backstops (the precondition read isn't transactional with the
 * handler's work).
 */

import { and, eq } from 'drizzle-orm';
import { db, nodes } from '@mantle/db';
import { notFound } from './errors';
import type { ToolHandlerResult, ToolPrecondition } from './types';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Injectable for tests: resolve a node's type by (ownerId, id); null when
 *  the node doesn't exist (or isn't the owner's). */
export type NodeTypeLookup = (ownerId: string, id: string) => Promise<string | null>;

async function defaultNodeTypeLookup(ownerId: string, id: string): Promise<string | null> {
  const [row] = await db
    .select({ type: nodes.type })
    .from(nodes)
    .where(and(eq(nodes.id, id), eq(nodes.ownerId, ownerId)))
    .limit(1);
  return row?.type ?? null;
}

/**
 * Check a tool's declared preconditions against the (already coerced) input.
 * Returns a teaching-error result to send back to the model, or null when
 * all preconditions hold and the handler may run.
 */
export async function checkToolPreconditions(
  preconditions: readonly ToolPrecondition[],
  input: Record<string, unknown>,
  ownerId: string,
  lookup: NodeTypeLookup = defaultNodeTypeLookup,
): Promise<ToolHandlerResult | null> {
  for (const pre of preconditions) {
    const raw = input[pre.param];
    if (raw === undefined || raw === null || raw === '') {
      // Presence is the schema's job (required/validate-args) — a missing
      // optional param is not a precondition failure.
      continue;
    }
    const id = typeof raw === 'string' ? raw.trim() : '';
    const kindName = pre.nodeType ?? 'node';
    if (!UUID_RE.test(id)) {
      return {
        ok: false,
        error:
          `'${pre.param}' must be a ${kindName} id (UUID), got '${String(raw).slice(0, 60)}' — ` +
          `pass the id, not a title or name. Find it with ${pre.lookup}.`,
      };
    }
    const actualType = await lookup(ownerId, id);
    if (actualType === null) {
      return notFound(kindName, id, pre.lookup);
    }
    if (pre.nodeType && actualType !== pre.nodeType) {
      return {
        ok: false,
        error:
          `'${pre.param}' ${id} is a ${actualType}, not a ${pre.nodeType} — ` +
          `pass a ${pre.nodeType} id (find it with ${pre.lookup}).`,
      };
    }
  }
  return null;
}
