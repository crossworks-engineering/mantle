/**
 * The keyword arm's query: which terms of the user's text to search for.
 *
 * The hybrid arms used to bind the raw text to `plainto_tsquery`, which ANDs
 * every stem. That works for a short keyword query ("invoice 4471") and fails
 * for everything the responder actually sends it: the whole user message. A
 * chat turn needs a passage that holds EVERY word, so the arm came back empty
 * on nearly every turn (dev, 2026-09-29: 4 of the last 35 inbound turns got a
 * single keyword hit; one realistic question matched 0 chunks where its three
 * key terms, ORed, matched 925), and the exact-term rescue floor never fired.
 *
 * The fix, after Hindsight's `bm25_term_selection.py`: keep the RAREST terms
 * and OR them. Common terms' frequency comes free from
 * `pg_stats.most_common_elems` on the `search_tsv` column (ANALYZE keeps it).
 * A lexeme absent from those stats is rarer than the least common tracked
 * one, but the stats cannot tell "got" (2% of rows) from an error code
 * (0.2%), and treating them alike let chat filler outvote the code. So up to
 * `COUNT_LEXEMES` untracked lexemes get a real count, capped at `COUNT_CAP`
 * rows each through the GIN index, which keeps the lookup cheap at any table
 * size. A term that matches no row is dropped (a typo cannot take a slot);
 * one in more than `dfCeiling` of the rows carries no signal and would fan
 * the match set out, so it is dropped too.
 *
 * Rows rank by the summed rarity (IDF, `ln(1/df)`) of the kept terms they
 * hold, then `ts_rank`: a row with every term ranks first (the old AND result,
 * as the head), and a rare literal outranks a pile of ordinary words.
 *
 * Fallbacks keep the old behaviour, never worse: a failed lookup, or only
 * common terms → the original `plainto_tsquery` AND. Deterministic, no model
 * call. Pure selection is split out so it unit-tests without a DB.
 */
import { sql, type AnyColumn, type SQL } from 'drizzle-orm';
import { db } from '@mantle/db';

/** Most terms kept for the OR query. Long enough to cover a paragraph's
 *  distinctive words; short enough that the match set stays small. */
export const KEYWORD_MAX_TERMS = 8;

/** A lexeme in more than this fraction of rows is too common to search for. */
export const KEYWORD_DF_CEILING = 0.05;

/** Untracked lexemes counted per query (codes and long words first), and the
 *  row cap on each count. Past the cap a term is common enough that its exact
 *  rarity no longer matters. */
const COUNT_LEXEMES = 32;
const COUNT_CAP = 500;

/** Floor for the rarity weight's df, so the weight stays finite. */
const MIN_DF = 1e-6;

/**
 * Chat glue that Postgres's `english` stopwords keep, as `english` stems.
 * These are rare in documents, so rarity alone would rank them like a part
 * number ("hey, quick one, what about task 0634cb44" put the task's passage
 * third behind rows holding "hey", "quick" and "got"). Only words that carry
 * no content in a question; the vector arm still sees the whole message.
 */
const CHAT_FILLER: ReadonlySet<string> = new Set(
  (
    'actual anyway awesom btw cool forget get got great hello hey hi hmm lol mayb nice ok ' +
    'okay pleas quick realli rememb remind sorri sure tell thank wonder yeah yep yes'
  ).split(' '),
);

export type KeywordTerm = { lexeme: string; weight: number };

export type KeywordQuery =
  /** The original behaviour: every stem ANDed. */
  | { mode: 'and'; text: string }
  /** The rarest lexemes (already stemmed by the `english` config), ORed,
   *  each with its rarity weight for ranking. */
  | { mode: 'or'; terms: KeywordTerm[] };

export type LexemeDf = { lexeme: string; df: number };

const byLexeme = (a: { lexeme: string }, b: { lexeme: string }) =>
  a.lexeme < b.lexeme ? -1 : a.lexeme > b.lexeme ? 1 : 0;

/**
 * Pick the terms to search for (pure). `rows` are the query's lexemes with the
 * fraction of table rows each appears in (0 = in no row). Returns null when
 * the text has no searchable lexeme at all (stopwords only).
 */
export function pickKeywordTerms(
  text: string,
  rows: readonly LexemeDf[],
  opts: { maxTerms?: number; dfCeiling?: number } = {},
): KeywordQuery | null {
  if (rows.length === 0) return null;
  const maxTerms = opts.maxTerms ?? KEYWORD_MAX_TERMS;
  const dfCeiling = opts.dfCeiling ?? KEYWORD_DF_CEILING;
  const rare = rows
    .filter(
      (r) =>
        r.lexeme.length > 0 &&
        !CHAT_FILLER.has(r.lexeme) &&
        Number.isFinite(r.df) &&
        r.df > 0 &&
        r.df <= dfCeiling,
    )
    // Rarest first; ties by lexeme so the pick is stable across runs.
    .sort((a, b) => a.df - b.df || byLexeme(a, b))
    .slice(0, Math.max(0, maxTerms));
  if (rare.length === 0) return { mode: 'and', text };
  return {
    mode: 'or',
    terms: rare.map((r) => ({ lexeme: r.lexeme, weight: idfWeight(r.df) })).sort(byLexeme),
  };
}

/** Rarity weight `ln(1/df)`, rounded so the SQL text is stable (pure). */
export function idfWeight(df: number): number {
  return Math.round(Math.log(1 / Math.max(df, MIN_DF)) * 1000) / 1000;
}

/**
 * Lexemes → tsquery input text, ORed (pure). Each lexeme is quoted so the
 * tsquery parser takes it verbatim (no re-parsing of `-`, `:`, `.`); inside
 * quotes a backslash escapes and a quote doubles.
 */
export function lexemesToTsqueryText(lexemes: readonly string[]): string {
  return lexemes.map((l) => `'${l.replace(/\\/g, '\\\\').replace(/'/g, "''")}'`).join(' | ');
}

/**
 * The table's per-lexeme document frequency for the query text, in one round
 * trip. Tracked lexemes read ANALYZE's `most_common_elems` (two `unnest`s in
 * one select list zip element-wise; the freqs array carries trailing
 * min/max/null values, so it is cut to the elems' length; `::text::text[]`
 * unnests the view's `anyarray`). Untracked lexemes are counted, capped; any
 * left uncounted take the least tracked frequency (rare, lowest priority).
 * Frequencies are table-wide, not per owner: rarity is a property of the
 * vocabulary, and the match itself stays owner-scoped. A lexeme holding a
 * backslash is left uncounted: the in-SQL quoting below only doubles quotes.
 */
async function lexemeFrequencies(
  text: string,
  table: 'content_chunks' | 'nodes',
): Promise<LexemeDf[]> {
  // `table` is one of two literals (the type), so raw is safe here.
  const tbl = sql.raw(`"${table}"`);
  const rows = (await db.execute(sql`
    with lex as (
      select distinct unnest(tsvector_to_array(to_tsvector('english', ${text}))) as lexeme
    ),
    col as (
      select most_common_elems::text::text[] as elems, most_common_elem_freqs as freqs
      from pg_stats
      where schemaname = current_schema() and tablename = ${table} and attname = 'search_tsv'
    ),
    stats as (
      select unnest(elems) as lexeme, unnest(freqs[1:array_length(elems, 1)]) as freq from col
    ),
    tracked as (
      select lex.lexeme, max(s.freq)::float8 as freq
      from lex left join stats s on s.lexeme = lex.lexeme
      group by lex.lexeme
    ),
    todo as (
      select lexeme,
             row_number() over (order by (lexeme ~ '[0-9]') desc, length(lexeme) desc, lexeme) as rn
      from tracked where freq is null and strpos(lexeme, chr(92)) = 0
    ),
    total as (
      select greatest(reltuples, 1)::float8 as n from pg_class
      where oid = to_regclass(quote_ident(current_schema()) || '.' || ${table})
    )
    select t.lexeme as lexeme,
      case
        when t.freq is not null then t.freq
        when d.rn <= ${COUNT_LEXEMES} then (
          select count(*)::float8 from (
            select 1 from ${tbl} c
            where c.search_tsv @@ (chr(39) || replace(t.lexeme, chr(39), chr(39) || chr(39)) || chr(39))::tsquery
            limit ${COUNT_CAP}
          ) hits
        ) / coalesce((select n from total), 1)
        else coalesce((select freqs[array_length(elems, 1) + 1] from col), ${KEYWORD_DF_CEILING})::float8
      end as df
    from tracked t left join todo d on d.lexeme = t.lexeme
  `)) as unknown as Array<{ lexeme: string; df: number | string }>;
  return rows.map((r) => ({ lexeme: r.lexeme, df: Number(r.df) }));
}

/**
 * Resolve the keyword query for `text` against `table`. Never throws: a failed
 * lookup falls back to the original AND query.
 */
export async function resolveKeywordQuery(
  text: string,
  table: 'content_chunks' | 'nodes',
): Promise<KeywordQuery | null> {
  try {
    return pickKeywordTerms(text, await lexemeFrequencies(text, table));
  } catch {
    return { mode: 'and', text };
  }
}

/** The WHERE predicate and ORDER BY terms for a `search_tsv` column. */
export function keywordSql(column: AnyColumn, kq: KeywordQuery): { match: SQL; order: SQL[] } {
  if (kq.mode === 'and') {
    const tsq = sql`plainto_tsquery('english', ${kq.text})`;
    return { match: sql`${column} @@ ${tsq}`, order: [sql`ts_rank(${column}, ${tsq}) desc`] };
  }
  const anyTerm = sql`${lexemesToTsqueryText(kq.terms.map((t) => t.lexeme))}::tsquery`;
  const rarity = sql.join(
    kq.terms.map(
      (t) =>
        sql`(case when ${column} @@ ${lexemesToTsqueryText([t.lexeme])}::tsquery then ${t.weight}::float8 else 0 end)`,
    ),
    sql` + `,
  );
  return {
    match: sql`${column} @@ ${anyTerm}`,
    order: [sql`(${rarity}) desc`, sql`ts_rank(${column}, ${anyTerm}) desc`],
  };
}
