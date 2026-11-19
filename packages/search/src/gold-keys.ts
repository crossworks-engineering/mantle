/**
 * Stable gold keys for the recall eval (docs/recall-eval.md). A gold item is
 * named by its type plus a hash of its title and/or the start of its body, so
 * a case still matches after the item is made again with a new id. The
 * manual harness (server/web/scripts/eval-recall.ts) and the in-brain
 * `recall_eval` tool both resolve gold here, so the two cannot drift.
 */
import { db } from '@mantle/db';
import { sql, type SQL } from 'drizzle-orm';

/** A stable key for one gold item. Holds no content: the keys are hashes. */
export type GoldKey = { type: string; titleKey?: string | null; bodyKey?: string | null };

/** The keys of one node, as the SQL below computes them. */
export type GoldKeyRow = {
  id: string;
  type: string;
  title_key: string | null;
  body_key: string | null;
};

/** What a case names as gold. Any one live match counts. */
export type GoldSpec = {
  id: string;
  expect?: GoldKey[];
  expectNodeIds?: string[];
  /** Case-insensitive title substrings. */
  expectTitleIncludes?: string[];
};

// Writing a case (eval-recall --keys) and resolving it at run time use these
// same SQL expressions. Text is lower-cased and every run of characters
// outside [a-z0-9] becomes one space; a key is the first 16 hex characters of
// the sha256 of that. The body key reads the first 400 normalised characters
// of the item's main text (a page's doc_text, else data body / content / text
// / agent_text) and is null when there is too little text to tell items
// apart. Both read `nodes n left join pages p on p.node_id = n.id`.
const NORM = (e: SQL) => sql`btrim(regexp_replace(lower(${e}), '[^a-z0-9]+', ' ', 'g'))`;
const HASH = (e: SQL) => sql`left(encode(sha256(convert_to(${e}, 'UTF8')), 'hex'), 16)`;
const TITLE_NORM = NORM(sql`coalesce(n.title, '')`);
const BODY_NORM = sql`left(${NORM(
  sql`left(coalesce(p.doc_text, n.data->>'body', n.data->>'content', n.data->>'text', n.data->>'agent_text', ''), 4000)`,
)}, 400)`;
export const GOLD_TITLE_KEY = sql`case when length(${TITLE_NORM}) >= 3 then ${HASH(TITLE_NORM)} end`;
export const GOLD_BODY_KEY = sql`case when length(${BODY_NORM}) >= 40 then ${HASH(BODY_NORM)} end`;

/** Keys of the owner's nodes: of the given ids, or of every node of the given types. */
export async function goldNodeKeys(
  ownerId: string,
  by: { ids: string[] } | { types: string[] },
): Promise<GoldKeyRow[]> {
  const xs = 'ids' in by ? by.ids : by.types;
  if (xs.length === 0) return [];
  const list = sql.join(
    xs.map((x) => sql`${x}`),
    sql`, `,
  );
  const filter = 'ids' in by ? sql`n.id::text in (${list})` : sql`n.type::text in (${list})`;
  return (await db.execute<GoldKeyRow>(sql`
    select n.id::text as id, n.type::text as type,
           ${GOLD_TITLE_KEY} as title_key, ${GOLD_BODY_KEY} as body_key
    from nodes n left join pages p on p.node_id = n.id
    where n.owner_id = ${ownerId} and ${filter}
  `)) as unknown as GoldKeyRow[];
}

/** Ids of the rows a case's keys name: same type, and the title key or the
 *  body key equal. A key with neither hash names nothing. */
export function matchGoldKeys(keys: readonly GoldKey[], rows: readonly GoldKeyRow[]): string[] {
  const out: string[] = [];
  for (const k of keys)
    for (const r of rows)
      if (
        r.type === k.type &&
        ((!!k.titleKey && r.title_key === k.titleKey) || (!!k.bodyKey && r.body_key === k.bodyKey))
      )
        out.push(r.id);
  return out;
}

/** The node ids on this brain that count as gold for each case: its keys,
 *  its ids that still exist, and the nodes whose title holds an expected
 *  substring. An empty set means the case is stale here. */
export async function resolveGold(
  ownerId: string,
  cases: readonly GoldSpec[],
): Promise<Map<string, Set<string>>> {
  const types = [...new Set(cases.flatMap((c) => (c.expect ?? []).map((k) => k.type)))];
  const keyed = await goldNodeKeys(ownerId, { types });
  const ids = [...new Set(cases.flatMap((c) => c.expectNodeIds ?? []))];
  const live = new Set((await goldNodeKeys(ownerId, { ids })).map((r) => r.id));
  const out = new Map<string, Set<string>>();
  for (const c of cases) {
    const gold = new Set(matchGoldKeys(c.expect ?? [], keyed));
    for (const id of c.expectNodeIds ?? []) if (live.has(id)) gold.add(id);
    for (const s of c.expectTitleIncludes ?? []) {
      const rows = (await db.execute<{ id: string }>(sql`
        select id::text as id from nodes
        where owner_id = ${ownerId} and strpos(lower(title), lower(${s})) > 0
      `)) as unknown as Array<{ id: string }>;
      for (const r of rows) gold.add(r.id);
    }
    out.set(c.id, gold);
  }
  return out;
}
