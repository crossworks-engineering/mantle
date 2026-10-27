/**
 * The parser's failure count for one node, kept on the node:
 * `data.parser_failures`, `{ "<job>:<sha256>": { n, code } }`
 * (packages/files/src/parser-client.ts, `ParserFailureLedger`).
 *
 * A file whose bytes time out, crash or are refused as too large by the
 * parser twice in the same job is terminal for that job; a refusal the
 * parser marks final (a fixed cap) is terminal the first time. In memory, a
 * restart or a roll between the two failures forgot the first, and a bomb
 * got a fresh pair of tries on every roll. On the node, the second real
 * failure is terminal whatever happened in between; the extractor then
 * records the `document_unreadable` skip and the drain leaves the node
 * alone until its bytes change (a content change drops this key with the
 * other byte keys, BYTE_DERIVED_DATA_KEYS).
 *
 * A counter only: nothing reads it to schedule work, and an UPDATE of a
 * node's data fires no extract (node_ingested is an INSERT notify).
 */
import { and, eq, sql } from 'drizzle-orm';
import { db, nodes } from '@mantle/db';
import type { ParserErrorCode, ParserFailureCount, ParserFailureLedger } from '@mantle/files';

/** The ledger of one node, for `withParserScope` around its extract. */
export function nodeParserFailures(nodeId: string, ownerId: string): ParserFailureLedger {
  const mine = and(eq(nodes.id, nodeId), eq(nodes.ownerId, ownerId));
  return {
    async get(key) {
      const [row] = await db
        .select({ f: sql<unknown>`${nodes.data}->'parser_failures'->(${key}::text)` })
        .from(nodes)
        .where(mine)
        .limit(1);
      const f = row?.f as { n?: unknown; code?: unknown } | null | undefined;
      if (!f || typeof f.n !== 'number' || typeof f.code !== 'string') return null;
      return { n: f.n, code: f.code as ParserErrorCode } satisfies ParserFailureCount;
    },
    async add(key, code, opts) {
      const prior = sql`${nodes.data}->'parser_failures'->(${key}::text)->>'n'`;
      // A final refusal (a fixed cap) is terminal at once: 2, or more.
      const floor = opts?.final === true ? 2 : 0;
      const [row] = await db
        .update(nodes)
        .set({
          data: sql`jsonb_set(
            coalesce(${nodes.data}, '{}'::jsonb),
            '{parser_failures}',
            coalesce(${nodes.data}->'parser_failures', '{}'::jsonb) || jsonb_build_object(
              ${key}::text,
              jsonb_build_object(
                'n', greatest(coalesce((${prior})::int, 0) + 1, ${floor}::int),
                'code', ${code}::text
              )
            )
          )`,
        })
        .where(mine)
        .returning({
          n: sql<number>`(${nodes.data}->'parser_failures'->(${key}::text)->>'n')::int`,
        });
      // A node that is gone counts as a first failure: retried, and the
      // retry finds no node.
      return Number(row?.n ?? 1);
    },
  };
}
