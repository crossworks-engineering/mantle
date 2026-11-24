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
 * Rows rank by the rarity (IDF, `ln(1/df)`) of the kept terms they hold,
 * each term's weight halved per rank behind the rarest (`RANK_DECAY`), then
 * `ts_rank`. A plain IDF sum let a question's frame outvote its one rare
 * word: "how does the author of the commentary describe the behavior of a
 * nautilus" ranked rows holding "author", "describ", "commentari" and
 * "behavior" above the only rows that mention a nautilus. With the decay the
 * rarest term outweighs every rarer-ranked term together, so a row holding it
 * always ranks first; the other terms only order rows among themselves.
 * Question-frame words (`QUESTION_FRAME`) are dropped like chat filler: in an
 * old corpus "perspective" or "specific" can be as rare as a real name.
 *
 * `gateRareTerms` is the passage arm's precision gate: the arm only returns
 * rows holding a term that names a small set of passages (no more rows than
 * the arm's pool). Without it, a question with no rare literal still filled
 * the pool with rows that merely shared ordinary words, and fusion let those
 * displace better vector hits (single-topic corpus, docs/recall-eval.md:
 * hybrid exact-passage R@10 34% vs vector-only 38%, R@1 1% vs 8%). With it,
 * the arm stays silent unless the query carries a literal worth rescuing.
 *
 * Fallbacks keep the old behaviour, never worse: a failed lookup, or only
 * common terms → the original `plainto_tsquery` AND. Deterministic, no model
 * call. Pure selection is split out so it unit-tests without a DB.
 */
import { sql, type AnyColumn, type SQL } from 'drizzle-orm';
import { db } from '@mantle/db';
import { translateQuery } from './query-translate';
import { loadSearchLanguages } from './search-languages';

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

/** Weight multiplier per rarity rank: the k-th rarest term weighs
 *  `idf * RANK_DECAY^k`. At 0.5 the rarest term outweighs all the others
 *  together (their IDFs are no larger and the series sums below 1). */
export const RANK_DECAY = 0.5;

/**
 * Chat glue that Postgres's `english` stopwords keep, as `english` stems.
 * These are rare in documents, so rarity alone would rank them like a part
 * number ("hey, quick one, what about task <id>" put the task's passage
 * third behind rows holding "hey", "quick" and "got"). Only words that carry
 * no content in a question; the vector arm still sees the whole message.
 */
const CHAT_FILLER: ReadonlySet<string> = new Set(
  (
    'actual anyway awesom btw cool forget get got great hello hey hi hmm lol mayb nice ok ' +
    'okay pleas quick realli rememb remind sorri sure tell thank wonder yeah yep yes'
  ).split(' '),
);

/**
 * Words that frame a question about a text rather than say what it is about,
 * as `english` stems ("describe", "according to", "the author's perspective").
 * Only meta words: a word that can be a topic ("version", "statement",
 * "impact") stays. The vector arm still sees the whole question.
 */
const QUESTION_FRAME: ReadonlySet<string> = new Set(
  (
    'accord analog anecdot author compar comparison context depict describ discuss emphas ' +
    'emphasis exampl explain highlight illustr impli indic mention metaphor opinion passag ' +
    'perspect portray primari regard speaker specif suggest summar summari viewpoint writer'
  ).split(' '),
);

export type KeywordTerm = {
  lexeme: string;
  weight: number;
  /** Rows holding the lexeme (an estimate for very common ones), null when
   *  unknown. Read by `gateRareTerms`. */
  rows: number | null;
};

export type KeywordQuery =
  /** The original behaviour: every stem ANDed. */
  | { mode: 'and'; text: string }
  /** The rarest lexemes (already stemmed by the `english` config), ORed,
   *  each with its rarity weight for ranking. `match`, when set, narrows
   *  which lexemes a row must hold to be returned (see `gateRareTerms`);
   *  ranking still weighs every term. */
  | { mode: 'or'; terms: KeywordTerm[]; match?: string[] };

export type LexemeDf = { lexeme: string; df: number; rows?: number | null };

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
  const rare = rareRows(rows, opts);
  if (rare.length === 0) return { mode: 'and', text };
  return { mode: 'or', terms: weighTerms(rare) };
}

/** The rows worth searching for, rarest first, at most `maxTerms` (pure). */
function rareRows(
  rows: readonly LexemeDf[],
  opts: { maxTerms?: number; dfCeiling?: number },
): LexemeDf[] {
  const maxTerms = opts.maxTerms ?? KEYWORD_MAX_TERMS;
  const dfCeiling = opts.dfCeiling ?? KEYWORD_DF_CEILING;
  return (
    rows
      .filter(
        (r) =>
          r.lexeme.length > 0 &&
          !CHAT_FILLER.has(r.lexeme) &&
          !QUESTION_FRAME.has(r.lexeme) &&
          Number.isFinite(r.df) &&
          r.df > 0 &&
          r.df <= dfCeiling,
      )
      // Rarest first; ties by lexeme so the pick is stable across runs.
      .sort((a, b) => a.df - b.df || byLexeme(a, b))
      .slice(0, Math.max(0, maxTerms))
  );
}

/** Rows (rarest first) as weighted terms, sorted by lexeme (pure). */
function weighTerms(rare: readonly LexemeDf[]): KeywordTerm[] {
  return rare
    .map((r, rank) => ({
      lexeme: r.lexeme,
      weight: idfWeight(r.df, rank),
      rows: r.rows ?? null,
    }))
    .sort(byLexeme);
}

/**
 * The keyword query with the query's translations' terms added (pure;
 * search-languages.ts). `rows` are the original text's lexemes, `translated`
 * each translation's. Each text's rare terms are picked by the same rule
 * (`maxTerms` each, so a translation never pushes an original term out);
 * a lexeme two texts share is one term. The union is weighed by today's
 * rarity rule, the original's terms first (today's ranks and weights),
 * then the translations' terms, rarest first.
 *
 * Today's query stands when no translation adds a rare term, and when the
 * original falls back to AND while that AND can match a row (every lexeme
 * is in some row: its words are only common). An AND that holds a word no
 * row holds matches nothing (an English query on Spanish documents), so
 * the translations' terms take its place. A text with no searchable lexeme
 * at all stays null.
 */
export function pickTranslatedKeywordTerms(
  text: string,
  rows: readonly LexemeDf[],
  translated: readonly (readonly LexemeDf[])[],
  opts: { maxTerms?: number; dfCeiling?: number } = {},
): KeywordQuery | null {
  const original = pickKeywordTerms(text, rows, opts);
  if (original === null) return null;
  const extra = translated.flatMap((t) => rareRows(t, opts));
  if (extra.length === 0) return original;
  if (original.mode === 'and' && rows.every((r) => r.df > 0)) return original;
  // The original's terms first, with today's weights; the translations'
  // after them, rarest first, each weighing at most RANK_DECAY of the term
  // before it. So every term outweighs all after it together, and a row
  // holding the original's rarest term outranks every row that holds only
  // translated terms: the person's own words lead as before.
  const first = original.mode === 'or' ? original.terms : [];
  const seen = new Set(first.map((t) => t.lexeme));
  let last = first.reduce((m, t) => Math.min(m, t.weight), Infinity);
  const after: KeywordTerm[] = [];
  const ranked = [...extra].sort((a, b) => a.df - b.df || byLexeme(a, b));
  for (const r of ranked) {
    if (seen.has(r.lexeme)) continue;
    seen.add(r.lexeme);
    const own = idfWeight(r.df, first.length + after.length);
    const weight = Number.isFinite(last) ? Math.min(own, idfCap(last)) : own;
    after.push({ lexeme: r.lexeme, weight, rows: r.rows ?? null });
    last = weight;
  }
  return { mode: 'or', terms: [...first, ...after].sort(byLexeme) };
}

/** Rarity weight `ln(1/df) * RANK_DECAY^rank` (rank 0 = the rarest kept
 *  term), rounded so the SQL text is stable (pure). */
export function idfWeight(df: number, rank = 0): number {
  return Math.round(Math.log(1 / Math.max(df, MIN_DF)) * Math.pow(RANK_DECAY, rank) * 1000) / 1000;
}

/** A weight at most RANK_DECAY of `w`, rounded down as idfWeight rounds. */
function idfCap(w: number): number {
  return Math.floor(w * RANK_DECAY * 1000) / 1000;
}

/**
 * The passage arm's precision gate (pure): keep only rows holding a term that
 * at most `maxRows` rows hold, so the arm returns a literal's passages and
 * nothing else. Null when no term qualifies (the arm stays silent). The AND
 * fallback passes through: every-word matches are already precise.
 */
export function gateRareTerms(kq: KeywordQuery, maxRows: number): KeywordQuery | null {
  if (kq.mode === 'and') return kq;
  const match = kq.terms.filter((t) => t.rows !== null && t.rows <= maxRows).map((t) => t.lexeme);
  return match.length > 0 ? { ...kq, match } : null;
}

/**
 * Lexemes → tsquery input text, ORed (pure). Each lexeme is quoted so the
 * tsquery parser takes it verbatim (no re-parsing of `-`, `:`, `.`); inside
 * quotes a backslash escapes and a quote doubles.
 */
export function lexemesToTsqueryText(lexemes: readonly string[]): string {
  return lexemes.map((l) => `'${l.replace(/\\/g, '\\\\').replace(/'/g, "''")}'`).join(' | ');
}

/** Postgres's text search configs by language code (those in every
 *  supported Postgres): a translation's stop words come from its own. */
const STOP_WORD_CONFIGS: Readonly<Record<string, string>> = {
  ar: 'arabic',
  da: 'danish',
  de: 'german',
  el: 'greek',
  en: 'english',
  es: 'spanish',
  fi: 'finnish',
  fr: 'french',
  ga: 'irish',
  hu: 'hungarian',
  id: 'indonesian',
  it: 'italian',
  lt: 'lithuanian',
  nb: 'norwegian',
  ne: 'nepali',
  nl: 'dutch',
  nn: 'norwegian',
  no: 'norwegian',
  pt: 'portuguese',
  ro: 'romanian',
  ru: 'russian',
  sv: 'swedish',
  ta: 'tamil',
  tr: 'turkish',
};

/** The config for a language code (`pt-BR` → portuguese), or null (pure). */
export function stopWordConfig(lang: string): string | null {
  return STOP_WORD_CONFIGS[lang.split('-')[0]!.toLowerCase()] ?? null;
}

/**
 * The table's per-lexeme document frequency for the query text, in one round
 * trip. Tracked lexemes read ANALYZE's `most_common_elems` (two `unnest`s in
 * one select list zip element-wise; the freqs array carries trailing
 * min/max/null values, so it is cut to the elems' length; `::text::text[]`
 * unnests the view's `anyarray`). Untracked lexemes are counted, capped; any
 * left uncounted take the least tracked frequency (rare, lowest priority).
 * Frequencies are table-wide, not per owner: rarity is a property of the
 * vocabulary, and the match itself stays owner-scoped. `rows` is the count
 * (exact below `COUNT_CAP`), the tracked frequency times the table size, or
 * null for the uncounted. A lexeme holding a backslash is left uncounted: the
 * in-SQL quoting below only doubles quotes.
 *
 * Table-wide in any scope, by a definer: the frequencies are the
 * vocabulary's, table-wide by design, and Postgres hides `pg_stats` of a
 * table under row security from every role that does not bypass it, so in a
 * workspace scope every lexeme would read as untracked and be counted under
 * the row rule (tens of milliseconds per query). The
 * definer returns numbers for the caller's own query terms only, never a
 * row; the search itself runs in the caller's scope.
 */
async function lexemeFrequencies(
  text: string,
  table: 'content_chunks' | 'nodes',
  lang?: string,
): Promise<LexemeDf[]> {
  // A translation's own stop words ("de", "la", "y") are no stop words to
  // the `english` rules, and a brain with few documents in that language
  // would count them rare: its words go through Postgres's stop list for
  // that language first (ts_debug: a stop word has no lexeme), the words
  // themselves kept as written for the `english` lookup.
  const config = lang ? stopWordConfig(lang) : null;
  const input = config
    ? sql`(select coalesce(string_agg(d.token, ' '), '')
             from ts_debug(${config}::regconfig, ${text}) d
            where d.lexemes is not null and cardinality(d.lexemes) > 0)`
    : sql`${text}`;
  // Residual signal (accepted): the document frequencies are
  // the whole table's, so which of the caller's terms the keyword arm ORs
  // can shift with what other workspaces hold: a faint existence signal by
  // count for the caller's own terms, never a row. By its definer
  // (mantle_lexeme_df, 0293: pg_stats and the capped counts, numbers only).
  const rows = (await db.execute(
    sql`select lexeme, rows, df
          from "public"."mantle_lexeme_df"(${input}, ${table}, ${COUNT_LEXEMES}::int,
                                            ${COUNT_CAP}::int, ${KEYWORD_DF_CEILING}::float8)`,
  )) as unknown as Array<{ lexeme: string; df: number | string; rows: number | string | null }>;
  return rows.map((r) => ({
    lexeme: r.lexeme,
    df: Number(r.df),
    rows: r.rows === null ? null : Number(r.rows),
  }));
}

/**
 * Resolve the keyword query for `text` against `table`. Never throws: a failed
 * lookup falls back to the original AND query.
 *
 * With `ownerId` and the brain's search languages set (search-languages.ts),
 * the query's translations add their terms (pickTranslatedKeywordTerms),
 * within the translation's time budget (query-translate.ts). With the list
 * empty it is today's query, the same lookup and the same answer (one more
 * read: the setting). With no `ownerId` (the caller may not spend on a
 * translation) it is today's query exactly.
 */
export async function resolveKeywordQuery(
  text: string,
  table: 'content_chunks' | 'nodes',
  ownerId?: string,
): Promise<KeywordQuery | null> {
  const languages = ownerId ? await loadSearchLanguages(ownerId) : [];
  if (languages.length === 0) {
    try {
      return pickKeywordTerms(text, await lexemeFrequencies(text, table));
    } catch {
      return { mode: 'and', text };
    }
  }
  const [rows, translations] = await Promise.all([
    lexemeFrequencies(text, table).catch(() => null),
    translateQuery(ownerId!, text, languages),
  ]);
  if (rows === null) return { mode: 'and', text };
  // A translation's lookup that fails only leaves its terms out.
  const translated = await Promise.all(
    translations.map((t) => lexemeFrequencies(t.text, table, t.lang).catch(() => [] as LexemeDf[])),
  );
  return pickTranslatedKeywordTerms(text, rows, translated);
}

/** The WHERE predicate and ORDER BY terms for a `search_tsv` column. */
export function keywordSql(column: AnyColumn, kq: KeywordQuery): { match: SQL; order: SQL[] } {
  if (kq.mode === 'and') {
    const tsq = sql`plainto_tsquery('english', ${kq.text})`;
    return { match: sql`${column} @@ ${tsq}`, order: [sql`ts_rank(${column}, ${tsq}) desc`] };
  }
  const anyTerm = sql`${lexemesToTsqueryText(kq.terms.map((t) => t.lexeme))}::tsquery`;
  const matchTerm = kq.match ? sql`${lexemesToTsqueryText(kq.match)}::tsquery` : anyTerm;
  const rarity = sql.join(
    kq.terms.map(
      (t) =>
        sql`(case when ${column} @@ ${lexemesToTsqueryText([t.lexeme])}::tsquery then ${t.weight}::float8 else 0 end)`,
    ),
    sql` + `,
  );
  return {
    match: sql`${column} @@ ${matchTerm}`,
    order: [sql`(${rarity}) desc`, sql`ts_rank(${column}, ${anyTerm}) desc`],
  };
}
