import { describe, expect, it } from 'vitest';
import {
  buildConversionPlan,
  duplicateMap,
  journalKindFor,
  journalKindForNote,
  notesTargetOf,
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

  it('a correction is always on, whatever the classifier said; unclassified = general preference', () => {
    expect(journalKindFor('correction', cls('expectation', 'topic'))).toEqual({
      kind: 'preference',
      scope: 'general',
    });
    expect(journalKindFor('style', undefined)).toEqual({ kind: 'preference', scope: 'general' });
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
