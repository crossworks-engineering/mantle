import { sql, type AnyColumn, type SQL } from 'drizzle-orm';
import { emailAttachmentSql, nodes } from '@mantle/db';

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
 * What a standing CATEGORY grant never covers, though the node has the
 * granted type (access matrix H1): the notes Mantle writes about the owner's
 * own chats (conversation digests and chat archives, in Notes / Auto-filed or
 * at the legacy `assistant` path) and the files that are email attachments.
 * Both are the owner's private corpus, like email and journal, which a
 * category grant cannot name at all. A per-node grant still reaches one of
 * them when the owner picks it.
 */
export function peerCategoryExcluded(): SQL {
  // coalesce: a node with no `kind` gives NULL here, and `not NULL` would
  // hide every node of the category. The digest is known three ways, as the
  // extractor's gate knows it (extract/gates.ts): its kind, its tag, and
  // where the summarizer writes it (Notes / Auto-filed, or `assistant`
  // before that folder existed).
  return sql`coalesce(${nodes.path} <@ 'notes.auto_filed'::ltree
    or (${nodes.type}::text = 'note' and ${nodes.path} <@ 'assistant'::ltree)
    or (${nodes.data}->>'kind') in ('conversation_digest', 'chat_archive')
    or ${nodes.tags} && ARRAY['conversation-digest', 'chat-archive']::text[]
    or ${emailAttachmentSql()}, false)`;
}

/**
 * The federation grant-union predicate: `(id ∈ ids) OR (node type ∈ types,
 * less what a category never covers)`. `idColumn` is the node-id column of
 * the queried table (`nodes.id`, or `content_chunks.node_id` when chunks are
 * joined to their node), so every peer read shares one definition of
 * "covered by a grant". Empty arrays contribute nothing; no grants of either
 * kind ⇒ `false` ⇒ matches nothing.
 */
export function grantUnionFilter(
  idColumn: AnyColumn,
  grants: { ids: string[]; types: string[] },
): SQL {
  const arms: SQL[] = [];
  if (grants.ids.length) arms.push(sql`${idColumn} = any(${pgArrayLiteral(grants.ids)}::uuid[])`);
  if (grants.types.length)
    arms.push(
      sql`(${nodes.type}::text = any(${pgArrayLiteral(grants.types)}::text[]) and not ${peerCategoryExcluded()})`,
    );
  if (arms.length === 0) return sql`false`;
  return sql`(${sql.join(arms, sql` or `)})`;
}
