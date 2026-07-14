import { sql, type AnyColumn, type SQL } from 'drizzle-orm';
import { nodes } from '@mantle/db';

/**
 * Serialize a JS string array for a `$n::uuid[]` / `$n::text[]` bind param.
 * Drizzle's postgres-js driver does NOT turn raw JS array params in sql``
 * templates into Postgres array literals (a single-element array arrives as a
 * bare string → `malformed array literal`), so array-valued filters pass one
 * string param in `{"a","b"}` form and cast it server-side. Elements are
 * quoted with `\` escaping, so values containing commas/quotes stay intact.
 */
export function pgArrayLiteral(values: string[]): string {
  return `{${values.map((v) => `"${v.replace(/[\\"]/g, (c) => `\\${c}`)}"`).join(',')}}`;
}

/**
 * The federation grant-union predicate: `(id ∈ ids) OR (node type ∈ types)`.
 * `idColumn` is the node-id column of the queried table (`nodes.id`, or
 * `content_chunks.node_id` when chunks are joined to their node), so both
 * search surfaces share one definition of "covered by a grant". Empty arrays
 * contribute nothing; no grants of either kind ⇒ `false` ⇒ matches nothing.
 */
export function grantUnionFilter(
  idColumn: AnyColumn,
  grants: { ids: string[]; types: string[] },
): SQL {
  const arms: SQL[] = [];
  if (grants.ids.length) arms.push(sql`${idColumn} = any(${pgArrayLiteral(grants.ids)}::uuid[])`);
  if (grants.types.length)
    arms.push(sql`${nodes.type}::text = any(${pgArrayLiteral(grants.types)}::text[])`);
  if (arms.length === 0) return sql`false`;
  return sql`(${sql.join(arms, sql` or `)})`;
}
