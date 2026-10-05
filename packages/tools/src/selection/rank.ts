/**
 * Tool cards + a code-only ranker for `tool_search` (PROTOTYPE, 2026-10-05).
 *
 * A card is the small, brain-authored text a model (or BM25) reads to decide
 * whether a tool fits: slug, flow, group, and the first sentences of the
 * tool's own description. The ranker is BM25 over cards with a small synonym
 * table, a usage prior (how often this brain's agents called the tool), and a
 * co-occurrence boost from tools already used in the turn. No model call: it
 * runs inside a `tool_search` handler, so the cached prompt prefix never
 * changes when it is used.
 */

import { flowForGroup } from './flows';

export type ToolCard = {
  slug: string;
  flow: string;
  group: string;
  /** First sentences of the tool description, capped. */
  summary: string;
  /** Text the ranker indexes (slug words, summary, group text). */
  text: string;
};

export type CardSource = {
  slug: string;
  description: string;
};

export type GroupSource = {
  slug: string;
  name?: string;
  description?: string;
  tools: readonly string[];
};

const SUMMARY_CHARS = 220;
const INDEX_CHARS = 600;

/** First sentence(s) of a description, up to `max` chars, cut on a boundary. */
export function summarize(description: string, max = SUMMARY_CHARS): string {
  const flat = description.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const stop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('; '));
  return (stop > 60 ? cut.slice(0, stop + 1) : cut.replace(/\s+\S*$/, '')).trim();
}

/**
 * Build one card per granted tool. A tool held by several groups takes the
 * flow of the first group that holds it (grant order), which keeps the
 * catalog stable for a given grant.
 */
export function buildToolCards(
  tools: readonly CardSource[],
  groups: readonly GroupSource[],
): ToolCard[] {
  const groupOf = new Map<string, GroupSource>();
  for (const g of groups) for (const s of g.tools) if (!groupOf.has(s)) groupOf.set(s, g);
  return tools.map((t) => {
    const g = groupOf.get(t.slug);
    const groupText = g ? `${g.name ?? g.slug} ${g.description ?? ''}` : '';
    return {
      slug: t.slug,
      flow: g ? flowForGroup(g.slug) : 'other',
      group: g?.slug ?? 'other',
      summary: summarize(t.description),
      text: `${t.slug.replace(/_/g, ' ')} ${t.slug.replace(/_/g, ' ')} ${t.description.slice(0, INDEX_CHARS)} ${groupText.slice(0, 200)}`,
    };
  });
}

/** Words a user says -> words tool cards use. Small on purpose. */
const SYNONYMS: Record<string, readonly string[]> = {
  mail: ['email'],
  emails: ['email'],
  inbox: ['email'],
  reply: ['email', 'send'],
  remind: ['event', 'create'],
  reminder: ['event', 'create'],
  notify: ['event', 'telegram'],
  notification: ['event', 'telegram'],
  meeting: ['event'],
  appointment: ['event'],
  calendar: ['event'],
  schedule: ['event'],
  todo: ['task'],
  todos: ['task'],
  doc: ['page', 'file'],
  document: ['page', 'file'],
  documents: ['file', 'page'],
  pdf: ['file'],
  spreadsheet: ['table', 'sheet', 'xlsx'],
  excel: ['xlsx', 'sheet', 'table'],
  sheet: ['table', 'xlsx'],
  grid: ['table'],
  row: ['table', 'row'],
  rows: ['table', 'row'],
  person: ['contact'],
  phone: ['contact'],
  address: ['contact'],
  people: ['contact'],
  internet: ['web', 'search'],
  online: ['web'],
  google: ['web', 'search'],
  website: ['web', 'crawl'],
  url: ['web', 'fetch'],
  link: ['share', 'web'],
  near: ['nearby', 'location'],
  nearby: ['location'],
  where: ['location'],
  directions: ['route', 'mapbox'],
  route: ['route', 'directions'],
  map: ['route', 'location'],
  picture: ['image'],
  photo: ['image'],
  draw: ['image', 'generate'],
  diagram: ['agent', 'diagrammer'],
  chart: ['agent', 'diagrammer'],
  research: ['agent', 'researcher'],
  app: ['app', 'agent'],
  remember: ['note', 'journal'],
  save: ['create', 'note'],
  write: ['create', 'page', 'draft'],
  edit: ['update', 'block'],
  change: ['update'],
  fix: ['update'],
  delete: ['delete'],
  remove: ['delete'],
  password: ['secret'],
  key: ['secret'],
  token: ['secret'],
  calculate: ['calculate'],
  sum: ['calculate', 'aggregate'],
  total: ['aggregate', 'calculate'],
  average: ['aggregate'],
  video: ['video'],
  youtube: ['video'],
  transcript: ['video'],
  speak: ['speech'],
  voice: ['speech'],
  timezone: ['timezone'],
  share: ['share'],
  public: ['share'],
};

const STOP = new Set(
  'a an and are as at be by can do for from have how i in is it its me my of on or our please the this to us we what when which with you your'.split(
    ' ',
  ),
);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1 && !STOP.has(w))
    .map(stem);
}

/** Very light stemmer: plural and -ing/-ed endings. Enough for card text. */
function stem(w: string): string {
  if (w.length > 4 && w.endsWith('ies')) return `${w.slice(0, -3)}y`;
  if (w.length > 4 && w.endsWith('ing')) return w.slice(0, -3);
  if (w.length > 3 && w.endsWith('ed')) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}

export type RankOptions = {
  /** Calls per tool on this brain (any window). Adds log1p(n) * priorWeight. */
  usage?: Readonly<Record<string, number>>;
  priorWeight?: number;
  /** Tools already called this turn; their frequent companions get a boost. */
  usedThisTurn?: readonly string[];
  /** P(companion | used), from successful traces. */
  coOccurrence?: Readonly<Record<string, Readonly<Record<string, number>>>>;
  coWeight?: number;
  /** Restrict to one flow when the model names it. */
  flow?: string;
  limit?: number;
};

export type RankedTool = { slug: string; score: number; flow: string };

export type CardIndex = {
  cards: readonly ToolCard[];
  docs: readonly Map<string, number>[];
  lengths: readonly number[];
  avgLength: number;
  df: ReadonlyMap<string, number>;
};

export function indexCards(cards: readonly ToolCard[]): CardIndex {
  const docs = cards.map((c) => {
    const tf = new Map<string, number>();
    for (const w of tokenize(c.text)) tf.set(w, (tf.get(w) ?? 0) + 1);
    return tf;
  });
  const lengths = docs.map((d) => [...d.values()].reduce((a, b) => a + b, 0));
  const df = new Map<string, number>();
  for (const d of docs) for (const w of d.keys()) df.set(w, (df.get(w) ?? 0) + 1);
  const avgLength = lengths.reduce((a, b) => a + b, 0) / Math.max(1, lengths.length);
  return { cards, docs, lengths, avgLength, df };
}

export function expandQuery(query: string): string[] {
  const base = tokenize(query);
  const out = [...base];
  for (const w of query.toLowerCase().split(/[^a-z0-9]+/)) {
    const syn = SYNONYMS[w];
    if (syn) out.push(...syn.map(stem));
  }
  return out;
}

/** BM25 (k1 1.2, b 0.75) + usage prior + co-occurrence boost. */
export function rankTools(index: CardIndex, query: string, opts: RankOptions = {}): RankedTool[] {
  const k1 = 1.2;
  const b = 0.75;
  const n = index.cards.length;
  const terms = expandQuery(query);
  const priorWeight = opts.priorWeight ?? 0.35;
  const coWeight = opts.coWeight ?? 1.5;
  const out: RankedTool[] = [];
  index.cards.forEach((card, i) => {
    if (opts.flow && card.flow !== opts.flow) return;
    const tf = index.docs[i]!;
    const len = index.lengths[i]!;
    let score = 0;
    for (const t of terms) {
      const f = tf.get(t);
      if (!f) continue;
      const dfi = index.df.get(t) ?? 0;
      const idf = Math.log(1 + (n - dfi + 0.5) / (dfi + 0.5));
      score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * len) / index.avgLength)));
    }
    if (score === 0) return;
    const used = opts.usage?.[card.slug] ?? 0;
    score += priorWeight * Math.log1p(used);
    for (const u of opts.usedThisTurn ?? []) {
      score += coWeight * (opts.coOccurrence?.[u]?.[card.slug] ?? 0);
    }
    out.push({ slug: card.slug, score, flow: card.flow });
  });
  out.sort((x, y) => y.score - x.score || x.slug.localeCompare(y.slug));
  return out.slice(0, opts.limit ?? 8);
}

/**
 * The names-only catalog the cached system prompt carries: one line per
 * flow, every granted tool by name. Stable for a given grant (flow order is
 * fixed, names sorted), so it never moves the cache.
 */
export function renderCatalog(
  cards: readonly ToolCard[],
  flows: readonly { slug: string; title: string; when: string }[],
  exclude: ReadonlySet<string> = new Set(),
): string {
  const lines: string[] = [];
  for (const f of [
    ...flows,
    { slug: 'other', title: 'Other', when: 'custom and connector tools' },
  ]) {
    const names = cards
      .filter((c) => c.flow === f.slug && !exclude.has(c.slug))
      .map((c) => c.slug)
      .sort();
    if (names.length === 0) continue;
    lines.push(`- ${f.slug} (${f.title}; ${f.when}): ${names.join(', ')}`);
  }
  return lines.join('\n');
}
