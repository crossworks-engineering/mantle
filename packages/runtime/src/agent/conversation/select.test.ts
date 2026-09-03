import { describe, expect, it } from 'vitest';
import {
  buildCorpusMap,
  buildDigests,
  buildHistory,
  mergePreferences,
  patchSuperseded,
  selectChunkHits,
  selectContentHits,
  selectFacts,
  staleNodeIds,
  type ChunkSearchHit,
  type ContentRow,
  type CorpusRow,
  type FactRow,
  type HistoryRow,
} from './select';

/**
 * The retrieval judgement inside loadConversationContext.
 *
 * Until these came out of that function they had NO test of any kind: the only
 * way to reach a cutoff was to stand up a database, an embedder and a chunk
 * index, so nobody did. That matters more here than in most places, because
 * every failure mode is silent. A cutoff moved the wrong way does not throw;
 * the model just answers with less, or with junk, and the turn still succeeds.
 */

const fact = (o: Partial<FactRow> = {}): FactRow => ({
  content: 'c',
  kind: 'factual',
  entityId: null,
  entityName: null,
  dist: 0.1,
  ...o,
});

describe('selectFacts', () => {
  it('admits a fact below the 0.85 mismatch guard and drops one at or above it', () => {
    const { facts, sent, dropped } = selectFacts([
      fact({ content: 'near', dist: 0.84 }),
      fact({ content: 'far', dist: 0.85 }),
    ]);
    expect(facts.map((f) => f.content)).toEqual(['near']);
    expect(sent.map((s) => s.text)).toEqual(['near']);
    expect(dropped.map((s) => s.text)).toEqual(['far']);
  });

  it('treats a missing distance as a mismatch, not as a perfect match', () => {
    // A null distance means the ranking said nothing; admitting it would put an
    // unranked row in the prompt as though it had matched.
    expect(selectFacts([fact({ dist: null })]).facts).toEqual([]);
  });

  it('caps the dropped near-misses so a snapshot cannot blow the trace ceiling', () => {
    const rows = Array.from({ length: 12 }, (_, i) => fact({ content: `f${i}`, dist: 0.9 }));
    expect(selectFacts(rows).dropped).toHaveLength(5);
    expect(selectFacts(rows).sent).toEqual([]);
  });

  it('anchors on the entities of admitted facts, in rank order, without repeats', () => {
    const { anchorEntityIds } = selectFacts([
      fact({ entityId: 'e1', dist: 0.1 }),
      fact({ entityId: 'e2', dist: 0.2 }),
      fact({ entityId: 'e1', dist: 0.3 }),
    ]);
    expect(anchorEntityIds).toEqual(['e1', 'e2']);
  });

  it('never anchors on a fact the guard dropped', () => {
    // Expanding the graph around a garbage-space match would spread the
    // mismatch instead of containing it.
    const { anchorEntityIds } = selectFacts([
      fact({ entityId: 'good', dist: 0.2 }),
      fact({ entityId: 'bad', dist: 0.95 }),
    ]);
    expect(anchorEntityIds).toEqual(['good']);
  });

  it('caps anchors at five', () => {
    const rows = Array.from({ length: 9 }, (_, i) => fact({ entityId: `e${i}`, dist: 0.1 }));
    expect(selectFacts(rows).anchorEntityIds).toHaveLength(5);
  });

  it('skips a fact with no entity rather than anchoring on nothing', () => {
    const { anchorEntityIds } = selectFacts([fact({ entityId: null }), fact({ entityId: 'e1' })]);
    expect(anchorEntityIds).toEqual(['e1']);
  });
});

describe('mergePreferences', () => {
  const pref = (content: string) => ({ content, kind: 'preference', entityName: null });

  it('prepends preferences so they lead the prefix', () => {
    const { facts } = mergePreferences(
      [{ content: 'v', kind: 'factual', entityName: null }],
      [],
      [pref('terse replies')],
    );
    expect(facts.map((f) => f.content)).toEqual(['terse replies', 'v']);
  });

  it('does not repeat a preference the vector search already returned', () => {
    const { facts } = mergePreferences(
      [{ content: 'terse replies', kind: 'preference', entityName: null }],
      [],
      [pref('terse replies')],
    );
    expect(facts.map((f) => f.content)).toEqual(['terse replies']);
  });

  it('records an injected preference with no distance, because it was not ranked', () => {
    const { sent } = mergePreferences([], [], [pref('terse replies')]);
    expect(sent).toEqual([{ text: 'terse replies', dist: null, kind: 'preference', entity: null }]);
  });

  it('leaves both lists alone when there is nothing new to add', () => {
    const facts = [{ content: 'v', kind: 'factual', entityName: null }];
    const sent = [{ text: 'v', dist: 0.1, kind: 'factual', entity: null }];
    expect(mergePreferences(facts, sent, [])).toEqual({ facts, sent });
  });
});

describe('selectContentHits', () => {
  const row = (o: Partial<ContentRow> = {}): ContentRow => ({
    nodeId: 'n1',
    title: 'T',
    type: 'page',
    data: { summary: 's' },
    supersededBy: null,
    dist: 0.1,
    ...o,
  });

  it('applies the 0.6 salience-adjusted cutoff', () => {
    const { hits, dropped } = selectContentHits([
      row({ nodeId: 'in', dist: 0.59 }),
      row({ nodeId: 'out', dist: 0.6 }),
    ]);
    expect(hits.map((h) => h.nodeId)).toEqual(['in']);
    expect(dropped.map((d) => d.nodeId)).toEqual(['out']);
  });

  it('gives an image hit an inline reference so showing it is a possible answer', () => {
    const [hit] = selectContentHits([
      row({ nodeId: 'img', title: 'Scan', data: { mime_type: 'image/png' } }),
    ]).hits;
    expect(hit!.inlineRef).toBe('![Scan](media:img)');
  });

  it('reads the stored snake_case mime key, not mimeType', () => {
    // `mimeType` is the shape the rest of the app uses; the stored key is
    // `mime_type`, and reading the wrong one makes every picture invisible.
    const [hit] = selectContentHits([row({ data: { mimeType: 'image/png' } })]).hits;
    expect(hit!.inlineRef).toBeUndefined();
  });

  it('carries a supersession pointer through for later resolution', () => {
    const [hit] = selectContentHits([row({ supersededBy: 'newer' })]).hits;
    expect(hit!.supersededBy).toEqual({ id: 'newer', title: '' });
  });

  it('caps the dropped near-misses at five', () => {
    const rows = Array.from({ length: 9 }, (_, i) => row({ nodeId: `n${i}`, dist: 0.9 }));
    expect(selectContentHits(rows).dropped).toHaveLength(5);
  });
});

describe('selectChunkHits', () => {
  const hit = (o: Partial<ChunkSearchHit> = {}): ChunkSearchHit => ({
    nodeId: 'n1',
    nodeTitle: 'T',
    nodeType: 'page',
    headingPath: 'h',
    text: 'passage',
    distance: 0.1,
    ...o,
  });

  it('applies the 0.65 chunk cutoff', () => {
    const { hits } = selectChunkHits(
      [hit({ nodeId: 'in', distance: 0.64 }), hit({ nodeId: 'out', distance: 0.65 })],
      8,
    );
    expect(hits.map((h) => h.nodeId)).toEqual(['in']);
  });

  it('excludes a raw telegram turn: that is the conversation, not a passage', () => {
    const { hits } = selectChunkHits([hit({ nodeId: 'tg', nodeType: 'telegram_message' })], 8);
    expect(hits).toEqual([]);
  });

  it('trims the pool down to the caller limit', () => {
    const rows = Array.from({ length: 6 }, (_, i) => hit({ nodeId: `n${i}` }));
    expect(selectChunkHits(rows, 2).hits.map((h) => h.nodeId)).toEqual(['n0', 'n1']);
  });

  it('counts everything not selected as dropped, capped at five', () => {
    const rows = Array.from({ length: 12 }, (_, i) => hit({ nodeId: `n${i}` }));
    const { hits, dropped } = selectChunkHits(rows, 2);
    expect(hits).toHaveLength(2);
    expect(dropped).toHaveLength(5);
  });
});

describe('supersession', () => {
  const content = (nodeId: string, superseded: boolean) => ({
    nodeId,
    title: 't',
    type: 'page',
    summary: null,
    ...(superseded ? { supersededBy: { id: 'x', title: '' } } : {}),
  });

  it('asks about superseded hits only, so a clean turn issues no query', () => {
    expect(staleNodeIds([content('a', false)], [])).toEqual([]);
  });

  it('collects stale ids from both hit kinds', () => {
    const chunk = {
      nodeId: 'c1',
      title: 't',
      heading: null,
      text: 'x',
      supersededBy: { id: 'y', title: '' },
    };
    expect(staleNodeIds([content('n1', true)], [chunk])).toEqual(['n1', 'c1']);
  });

  it('re-points a superseded hit at its living successor', () => {
    const out = patchSuperseded(
      [content('n1', true)],
      new Map([['n1', { id: 'newer', title: 'The current copy' }]]),
    );
    expect(out[0]!.supersededBy).toEqual({ id: 'newer', title: 'The current copy' });
  });

  it('drops the annotation on a dangling edge rather than naming a ghost', () => {
    // The successor was deleted. Pointing the model at an id it cannot fetch is
    // worse than saying nothing.
    const out = patchSuperseded([content('n1', true)], new Map());
    expect(out[0]!.supersededBy).toBeUndefined();
  });

  it('leaves a current hit untouched', () => {
    const hits = [content('n1', false)];
    expect(patchSuperseded(hits, new Map())).toEqual(hits);
  });
});

describe('buildCorpusMap', () => {
  const row = (o: Partial<CorpusRow> = {}): CorpusRow => ({
    id: 'n1',
    type: 'page',
    title: 'T',
    path: 'work.notes',
    data: {},
    ...o,
  });

  it('reports truncation from the one extra row it was given', () => {
    // The query asks for limit+1 precisely so the extra row proves truncation.
    const rows = [row({ id: 'a' }), row({ id: 'b' }), row({ id: 'c' })];
    const map = buildCorpusMap(rows, 2);
    expect(map.entries.map((e) => e.nodeId)).toEqual(['a', 'b']);
    expect(map.truncated).toBe(true);
  });

  it('is not truncated when the rows fit', () => {
    expect(buildCorpusMap([row()], 2).truncated).toBe(false);
  });

  it('is not truncated when the rows land EXACTLY on the limit', () => {
    // The boundary the limit+1 fetch exists to test. Reading it as >= would
    // claim the map was cut short on every turn that happens to fill it.
    const rows = [row({ id: 'a' }), row({ id: 'b' })];
    expect(buildCorpusMap(rows, 2).truncated).toBe(false);
    expect(buildCorpusMap(rows, 2).entries).toHaveLength(2);
  });

  it('takes the branch from the first ltree label, defaulting to content', () => {
    expect(buildCorpusMap([row({ path: 'work.notes' })], 5).entries[0]!.branch).toBe('work');
    expect(buildCorpusMap([row({ path: null })], 5).entries[0]!.branch).toBe('content');
  });

  it('carries a summary for pages and tables only', () => {
    const data = { summary: 's' };
    expect(buildCorpusMap([row({ type: 'page', data })], 5).entries[0]!.summary).toBe('s');
    expect(buildCorpusMap([row({ type: 'file', data })], 5).entries[0]!.summary).toBeNull();
  });

  it('carries the schema digest for tables only, so the model can query without a tool call', () => {
    const data = { schemaDigest: 'tab: a,b' };
    expect(buildCorpusMap([row({ type: 'table', data })], 5).entries[0]!.schema).toBe('tab: a,b');
    expect(buildCorpusMap([row({ type: 'page', data })], 5).entries[0]!.schema).toBeNull();
  });
});

describe('buildDigests', () => {
  it('flips newest-first rows into oldest-first reading order', () => {
    const out = buildDigests([{ data: { summary: 'newer' } }, { data: { summary: 'older' } }]);
    expect(out.map((d) => d.summary)).toEqual(['older', 'newer']);
  });

  it('drops a digest with no summary text', () => {
    expect(buildDigests([{ data: { topic: 'x' } }])).toEqual([]);
  });

  it('trims a topic and nulls a blank one', () => {
    expect(buildDigests([{ data: { summary: 's', topic: '  x  ' } }])[0]!.topic).toBe('x');
    expect(buildDigests([{ data: { summary: 's', topic: '   ' } }])[0]!.topic).toBeNull();
  });
});

describe('buildHistory', () => {
  const row = (o: Partial<HistoryRow> = {}): HistoryRow => ({
    direction: 'inbound',
    text: 'hello',
    data: null,
    attachments: null,
    ...o,
  });

  it('flips newest-first rows into oldest-first prompt order', () => {
    const { history } = buildHistory([row({ text: 'second' }), row({ text: 'first' })]);
    expect(history.map((h) => h.text)).toEqual(['first', 'second']);
  });

  it('maps direction onto role', () => {
    const { history } = buildHistory([row({ direction: 'outbound', text: 'a' })]);
    expect(history[0]!.role).toBe('assistant');
    expect(buildHistory([row()]).history[0]!.role).toBe('user');
  });

  it('appends the tool record to an assistant turn and counts it', () => {
    const data = { toolStats: { calls: 1, failed: 1, failures: [{ slug: 'x', error: 'boom' }] } };
    const { history, toolRecords } = buildHistory([row({ direction: 'outbound', data })]);
    expect(history[0]!.text).toContain('tool record');
    expect(toolRecords).toBe(1);
  });

  it('never appends a tool record to a user turn', () => {
    const data = { toolStats: { calls: 1, failed: 1, failures: [{ slug: 'x', error: 'boom' }] } };
    const { history, toolRecords } = buildHistory([row({ direction: 'inbound', data })]);
    expect(history[0]!.text).toBe('hello');
    expect(toolRecords).toBe(0);
  });

  it('reads media back on BOTH directions', () => {
    // A picture the user uploaded is as re-referenceable as one a tool made.
    const attachments = [{ nodeId: 'f1', kind: 'image', caption: 'a cat' }];
    const inbound = buildHistory([row({ attachments })]);
    const outbound = buildHistory([row({ direction: 'outbound', attachments })]);
    expect(inbound.history[0]!.text).toContain('media record');
    expect(outbound.history[0]!.text).toContain('media record');
    expect(inbound.mediaRecords).toBe(1);
  });

  it('stays byte-identical for a plain chat turn', () => {
    const { history, toolRecords, mediaRecords } = buildHistory([row({ text: 'just talking' })]);
    expect(history).toEqual([{ role: 'user', text: 'just talking' }]);
    expect(toolRecords).toBe(0);
    expect(mediaRecords).toBe(0);
  });
});
