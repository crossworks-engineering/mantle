import { describe, expect, it } from 'vitest';
import {
  buildConversionPlan,
  duplicateMap,
  journalKindFor,
  journalKindForNote,
  notesTargetOf,
  parseConversionPlan,
  parseLooseJson,
  parseNoteClass,
  planStaleness,
  renderConversionPlanMarkdown,
  type NoteClass,
} from './persona-notes-journal';

const cls = (kind: NoteClass['kind'], scope: NoteClass['scope'], topic = 't'): NoteClass => ({
  kind,
  scope,
  topic,
});

describe('journalKindFor', () => {
  it('general notes land in an always-on kind', () => {
    expect(journalKindFor('style', cls('preference', 'general'))).toEqual({
      kind: 'preference',
      scope: 'general',
    });
    expect(journalKindFor('style', cls('expectation', 'general')).kind).toBe('preference');
    expect(journalKindFor('relationship', cls('identity', 'general')).kind).toBe('identity');
    expect(journalKindFor('relationship', cls('context', 'general')).kind).toBe('identity');
  });

  it('topic notes land in a per-turn kind', () => {
    expect(journalKindFor('style', cls('expectation', 'topic'))).toEqual({
      kind: 'expectation',
      scope: 'topic',
    });
    expect(journalKindFor('style', cls('preference', 'topic')).kind).toBe('expectation');
    expect(journalKindFor('style', cls('lesson', 'topic')).kind).toBe('lesson');
    expect(journalKindFor('style', cls('context', 'topic')).kind).toBe('context');
  });

  it('a correction is always on, whatever the classifier said; an unsorted note goes per turn', () => {
    expect(journalKindFor('correction', cls('expectation', 'topic'))).toEqual({
      kind: 'preference',
      scope: 'general',
    });
    // Always-on is the costly tier: a note the model gave no answer for does
    // not land there by default.
    expect(journalKindFor('style', undefined)).toEqual({ kind: 'expectation', scope: 'topic' });
    expect(journalKindFor('correction', undefined)).toEqual({
      kind: 'preference',
      scope: 'general',
    });
  });
});

describe('parseNoteClass', () => {
  it('forgives case and spacing, rejects anything else', () => {
    expect(parseNoteClass({ kind: ' Lesson ', scope: 'Topic', topic: ' SOP  headers ' })).toEqual({
      kind: 'lesson',
      scope: 'topic',
      topic: 'SOP headers',
    });
    expect(parseNoteClass({ kind: 'rule', scope: 'topic' })).toBeNull();
    expect(parseNoteClass({ kind: 'lesson', scope: 'sometimes' })).toBeNull();
    expect(parseNoteClass('lesson')).toBeNull();
    expect(parseNoteClass(null)).toBeNull();
  });
});

describe('parseLooseJson', () => {
  it('quotes a bare key but never touches the same token inside a value', () => {
    expect(parseLooseJson('Here: {N1: {"topic": "triage of P1 incidents"}, "N2": 3} done')).toEqual(
      {
        N1: { topic: 'triage of P1 incidents' },
        N2: 3,
      },
    );
    expect(parseLooseJson('{"P1": "same", P2: "different"}')).toEqual({
      P1: 'same',
      P2: 'different',
    });
    expect(() => parseLooseJson('no json here')).toThrow(/no JSON/);
  });
});

describe('duplicateMap', () => {
  it('merges same-pairs into groups that keep their earliest note', () => {
    const m = duplicateMap(
      ['a', 'b', 'c', 'd'],
      [
        ['c', 'b'],
        ['d', 'c'],
        ['x', 'a'], // unknown ref: ignored
      ],
    );
    expect(Object.fromEntries(m)).toEqual({ c: 'b', d: 'b' });
  });

  it('keeps the strongest note of a group (a later correction beats an earlier topic note)', () => {
    const rank = (r: string) => (r === 'late-correction' ? 0 : 2);
    const m = duplicateMap(
      ['early-topic', 'late-correction'],
      [['early-topic', 'late-correction']],
      rank,
    );
    expect(Object.fromEntries(m)).toEqual({ 'early-topic': 'late-correction' });
  });
});

describe('parseConversionPlan and planStaleness', () => {
  const ok = {
    version: 1,
    agentId: 'ag1',
    agentSlug: 'assistant',
    createdAt: '2026-09-23T00:00:00Z',
    model: 'm',
    entries: [
      {
        ref: 'a',
        content: 'x',
        noteKind: 'style',
        kind: 'preference',
        scope: 'general',
        topic: '',
      },
      { ref: 'b', content: 'y', noteKind: 'style', kind: 'lesson', scope: 'topic', topic: 't' },
    ],
  };

  it('accepts a good plan and names what is wrong with a bad one', () => {
    expect(parseConversionPlan(ok).entries).toHaveLength(2);
    expect(() => parseConversionPlan({ ...ok, version: 2 })).toThrow(/version 2/);
    expect(() =>
      parseConversionPlan({ ...ok, entries: [{ ...ok.entries[0], kind: 'secret' }] }),
    ).toThrow(/entry 0: kind secret/);
    expect(() => parseConversionPlan(undefined)).toThrow(/missing/);
  });

  it('reports notes retired and learned since the dry run', () => {
    const plan = parseConversionPlan(ok);
    expect(planStaleness(plan, new Set(['a', 'c']))).toEqual({ retired: ['b'], added: ['c'] });
  });
});

describe('buildConversionPlan + render', () => {
  it('plans every note, marks duplicates, and renders the summary', () => {
    const plan = buildConversionPlan({
      agentId: 'ag1',
      agentSlug: 'assistant',
      model: 'openrouter:anthropic/claude-sonnet-5',
      now: new Date('2026-09-23T00:00:00Z'),
      notes: [
        { ref: 'n1', kind: 'style', content: 'Keep replies short.' },
        { ref: 'n2', kind: 'style', content: 'Change-log tiles take one of five tags.' },
        { ref: 'n3', kind: 'style', content: 'Change-log tiles use exactly five tags.' },
      ],
      classes: new Map([
        ['n1', cls('preference', 'general')],
        ['n2', cls('expectation', 'topic', 'change-log app')],
        ['n3', cls('expectation', 'topic', 'change-log app')],
      ]),
      samePairs: [['n2', 'n3']],
    });
    expect(plan.entries.map((e) => [e.ref, e.kind, e.duplicateOf ?? null])).toEqual([
      ['n1', 'preference', null],
      ['n2', 'expectation', null],
      ['n3', 'expectation', 'n2'],
    ]);
    const md = renderConversionPlanMarkdown(plan, 'APPLY');
    expect(md).toContain('Dry run: nothing has changed');
    expect(md).toContain('`APPLY`');
    expect(md).toContain('| Always on (tier 1: identity, preference) | 1 |');
    expect(md).toContain('| Duplicates, not created | 1 |');
    expect(md).toContain(
      '| change-log app | expectation | Change-log tiles take one of five tags. |',
    );
  });
});

describe('notes_target = journal', () => {
  it('defaults to persona; only the literal journal switches', () => {
    expect(notesTargetOf(undefined)).toBe('persona');
    expect(notesTargetOf({})).toBe('persona');
    expect(notesTargetOf({ notes_target: 'journal' })).toBe('journal');
    expect(notesTargetOf({ notes_target: 'JOURNAL' })).toBe('persona');
  });

  it('maps a live-learned note: corrections always on, style by scope, default general', () => {
    expect(journalKindForNote('correction', 'topic')).toBe('preference');
    expect(journalKindForNote('relationship')).toBe('identity');
    expect(journalKindForNote('style', 'topic')).toBe('expectation');
    expect(journalKindForNote('style', 'general')).toBe('preference');
    expect(journalKindForNote('style')).toBe('preference');
  });
});
