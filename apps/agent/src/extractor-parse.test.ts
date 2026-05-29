/**
 * Tests for the extractor's LLM-output parser. These functions decide
 * what facts + entities make it into the DB after every node ingest,
 * so a regression here would either:
 *
 *   - drop valid facts on the floor, or
 *   - let malformed entries through and crash reconcileEntity downstream.
 *
 * We exercise:
 *   - Happy paths for clean JSON, code-fenced JSON, with/without entities.
 *   - The bad-JSON path returns a non-null but empty result + logs.
 *   - isValidFact rejects every shape the model has actually emitted.
 *   - sanitiseFactEntities scrubs entities without breaking the fact.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  canonicaliseRelation,
  extractFirstJsonObject,
  isValidEntity,
  isValidFact,
  isValidRelation,
  parseExtractorOutput,
  sanitiseFactEntities,
  sanitiseRelation,
  type ExtractedFact,
  type ExtractedRelation,
} from './extractor-parse';

// Quiet the [extractor] error log in tests; assert it fired when we
// expect a parse failure.
let errorSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  errorSpy.mockRestore();
});

describe('parseExtractorOutput — happy path', () => {
  it('parses a clean JSON response', () => {
    const raw = JSON.stringify({
      summary: 'A meeting note about the printer project.',
      facts: [
        {
          content: 'Jason is working on the Lister printer project.',
          kind: 'semantic',
          confidence: 0.9,
          entities: [{ name: 'Jason', kind: 'person' }],
        },
      ],
      entities: [{ name: 'Jason', kind: 'person' }],
    });
    const out = parseExtractorOutput(raw);
    expect(out.summary).toBe('A meeting note about the printer project.');
    expect(out.facts).toHaveLength(1);
    expect(out.facts[0]!.entities).toEqual([{ name: 'Jason', kind: 'person' }]);
  });

  it('strips ```json fences', () => {
    const raw = '```json\n' + JSON.stringify({ summary: 'hi', facts: [], entities: [] }) + '\n```';
    expect(parseExtractorOutput(raw).summary).toBe('hi');
  });

  it('strips ``` fences without the language tag', () => {
    const raw = '```\n' + JSON.stringify({ summary: 'hi', facts: [], entities: [] }) + '\n```';
    expect(parseExtractorOutput(raw).summary).toBe('hi');
  });

  it('trims whitespace from summary', () => {
    const raw = JSON.stringify({ summary: '   spaced out   ', facts: [], entities: [] });
    expect(parseExtractorOutput(raw).summary).toBe('spaced out');
  });

  it('defaults missing fields to empty arrays / empty string', () => {
    expect(parseExtractorOutput(JSON.stringify({}))).toEqual({
      summary: '',
      facts: [],
      entities: [],
      relations: [],
    });
  });
});

describe('parseExtractorOutput — trailing-content recovery', () => {
  const obj = {
    summary: 'A car sale contract.',
    facts: [{ content: 'The user has a vehicle purchase contract.', kind: 'factual', confidence: 0.9 }],
    entities: [],
  };

  it('recovers a valid object followed by explanatory prose', () => {
    const raw = JSON.stringify(obj) + '\n\nThese facts capture the key terms of the contract.';
    const out = parseExtractorOutput(raw);
    expect(out.summary).toBe('A car sale contract.');
    expect(out.facts).toHaveLength(1);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('recovers when the model appends a second fenced block / stray fence', () => {
    const raw = JSON.stringify(obj) + '\n```';
    expect(parseExtractorOutput(raw).facts).toHaveLength(1);
  });

  it('does not get fooled by braces inside string values', () => {
    const tricky = {
      summary: 'Contains { and } and "quotes" in the text.',
      facts: [],
      entities: [],
    };
    const raw = JSON.stringify(tricky) + ' trailing junk';
    expect(parseExtractorOutput(raw).summary).toBe('Contains { and } and "quotes" in the text.');
  });

  it('still returns empty + logs on a genuinely truncated object', () => {
    // No closing brace — unbalanced, unrecoverable.
    const out = parseExtractorOutput('{"summary": "half a tho');
    expect(out).toEqual({ summary: '', facts: [], entities: [], relations: [] });
    expect(errorSpy).toHaveBeenCalled();
  });
});

describe('extractFirstJsonObject', () => {
  it('returns the balanced object ignoring trailing text', () => {
    expect(extractFirstJsonObject('{"a":1} and more')).toBe('{"a":1}');
  });
  it('handles nested objects', () => {
    expect(extractFirstJsonObject('prefix {"a":{"b":2}} suffix')).toBe('{"a":{"b":2}}');
  });
  it('ignores braces inside strings', () => {
    expect(extractFirstJsonObject('{"s":"a}b{c"} x')).toBe('{"s":"a}b{c"}');
  });
  it('returns null when no object is present', () => {
    expect(extractFirstJsonObject('no braces here')).toBeNull();
  });
  it('returns null on an unbalanced (truncated) object', () => {
    expect(extractFirstJsonObject('{"a":1')).toBeNull();
  });
});

describe('parseExtractorOutput — error path', () => {
  it('returns an empty result on malformed JSON', () => {
    const out = parseExtractorOutput('not json [[[');
    expect(out).toEqual({ summary: '', facts: [], entities: [], relations: [] });
  });

  it('logs a structured error with the node id and a preview', () => {
    parseExtractorOutput('not json {', { nodeId: 'node-123', model: 'anthropic/claude-haiku-4.5' });
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('LLM returned non-JSON'),
      expect.objectContaining({ nodeId: 'node-123', model: 'anthropic/claude-haiku-4.5' }),
    );
  });

  it('does not log when the JSON is valid (even if facts are empty)', () => {
    parseExtractorOutput(JSON.stringify({ summary: '', facts: [], entities: [] }));
    expect(errorSpy).not.toHaveBeenCalled();
  });
});

describe('parseExtractorOutput — fact filtering', () => {
  it('drops facts with empty content', () => {
    const raw = JSON.stringify({
      summary: '',
      facts: [
        { content: '', kind: 'factual', confidence: 0.9 },
        { content: 'a real fact', kind: 'factual', confidence: 0.9 },
      ],
      entities: [],
    });
    expect(parseExtractorOutput(raw).facts).toHaveLength(1);
  });

  it('drops facts with unknown kinds', () => {
    const raw = JSON.stringify({
      summary: '',
      facts: [
        { content: 'a fact', kind: 'weird-new-kind', confidence: 0.9 },
        { content: 'another', kind: 'factual', confidence: 0.9 },
      ],
      entities: [],
    });
    expect(parseExtractorOutput(raw).facts).toHaveLength(1);
  });

  it('drops entities on facts whose name or kind is blank', () => {
    const raw = JSON.stringify({
      summary: '',
      facts: [
        {
          content: 'a fact',
          kind: 'factual',
          confidence: 0.9,
          entities: [
            { name: 'Jason', kind: 'person' },
            { name: '', kind: 'person' },
            { name: 'Foo', kind: '' },
          ],
        },
      ],
      entities: [],
    });
    const out = parseExtractorOutput(raw);
    expect(out.facts[0]!.entities).toEqual([{ name: 'Jason', kind: 'person' }]);
  });
});

describe('isValidFact', () => {
  it('accepts a complete record', () => {
    expect(
      isValidFact({ content: 'x', kind: 'factual', confidence: 1 } satisfies ExtractedFact),
    ).toBe(true);
  });

  it('rejects null and non-objects', () => {
    expect(isValidFact(null)).toBe(false);
    expect(isValidFact('a string')).toBe(false);
    expect(isValidFact(42)).toBe(false);
  });

  it('rejects whitespace-only content', () => {
    expect(isValidFact({ content: '   ', kind: 'factual', confidence: 1 })).toBe(false);
  });

  it('rejects a missing or unknown kind', () => {
    expect(isValidFact({ content: 'x', confidence: 1 })).toBe(false);
    expect(isValidFact({ content: 'x', kind: 'unknown', confidence: 1 })).toBe(false);
  });
});

describe('isValidEntity', () => {
  it('accepts a complete record', () => {
    expect(isValidEntity({ name: 'Jason', kind: 'person' })).toBe(true);
  });

  it('rejects blank name or kind', () => {
    expect(isValidEntity({ name: '', kind: 'person' })).toBe(false);
    expect(isValidEntity({ name: 'Jason', kind: '' })).toBe(false);
    expect(isValidEntity({ name: '   ', kind: 'person' })).toBe(false);
  });

  it('rejects non-objects', () => {
    expect(isValidEntity(null)).toBe(false);
    expect(isValidEntity('Jason')).toBe(false);
    expect(isValidEntity(undefined)).toBe(false);
  });
});

describe('sanitiseFactEntities', () => {
  it('leaves a fact with no entities untouched', () => {
    const f: ExtractedFact = { content: 'x', kind: 'factual', confidence: 1 };
    expect(sanitiseFactEntities(f)).toEqual(f);
  });

  it('preserves valid entities and drops invalid ones', () => {
    const f: ExtractedFact = {
      content: 'x',
      kind: 'factual',
      confidence: 1,
      entities: [
        { name: 'Jason', kind: 'person' },
        { name: '', kind: 'person' },
      ],
    };
    expect(sanitiseFactEntities(f).entities).toEqual([{ name: 'Jason', kind: 'person' }]);
  });

  it('handles a fact whose `entities` is not an array', () => {
    const f = {
      content: 'x',
      kind: 'factual',
      confidence: 1,
      entities: 'not-an-array' as unknown as { name: string; kind: string }[],
    } as ExtractedFact;
    expect(sanitiseFactEntities(f).entities).toBe('not-an-array');
  });
});

describe('isValidRelation', () => {
  it('accepts a well-formed relation', () => {
    expect(isValidRelation({ subject: 'Sarah', relation: 'works_at', object: 'Lister' })).toBe(true);
  });
  it('rejects missing/blank endpoints', () => {
    expect(isValidRelation({ subject: 'Sarah', relation: 'works_at', object: '' })).toBe(false);
    expect(isValidRelation({ subject: '', relation: 'works_at', object: 'Lister' })).toBe(false);
    expect(isValidRelation({ subject: 'Sarah', relation: '', object: 'Lister' })).toBe(false);
  });
  it('rejects self-loops (subject == object, case-insensitive)', () => {
    expect(isValidRelation({ subject: 'Lister', relation: 'is', object: 'lister' })).toBe(false);
  });
  it('rejects non-objects', () => {
    expect(isValidRelation(null)).toBe(false);
    expect(isValidRelation('Sarah works at Lister')).toBe(false);
  });
});

describe('sanitiseRelation', () => {
  it('snake_cases + lowercases the verb', () => {
    const r = sanitiseRelation({ subject: 'Sarah', relation: 'Reports To', object: 'Lister', confidence: 0.9 });
    expect(r.relation).toBe('reports_to');
  });
  it('strips punctuation from the verb', () => {
    expect(sanitiseRelation({ subject: 'A', relation: 'father-of!', object: 'B', confidence: 1 }).relation).toBe('father_of');
  });
  it('trims endpoints and clamps confidence; defaults missing confidence to 0.8', () => {
    const r = sanitiseRelation({ subject: '  Sarah ', relation: 'owns', object: ' Car ', confidence: 5 } as ExtractedRelation);
    expect(r.subject).toBe('Sarah');
    expect(r.object).toBe('Car');
    expect(r.confidence).toBe(1);
    const d = sanitiseRelation({ subject: 'A', relation: 'owns', object: 'B' } as unknown as ExtractedRelation);
    expect(d.confidence).toBe(0.8);
  });
});

describe('canonicaliseRelation', () => {
  it('collapses employment synonyms to employed_by', () => {
    for (const v of ['works_at', 'works_for', 'employed_at', 'employee_of'])
      expect(canonicaliseRelation(v)).toBe('employed_by');
  });
  it('collapses a few other obvious synonyms', () => {
    expect(canonicaliseRelation('owner_of')).toBe('owns');
    expect(canonicaliseRelation('located_at')).toBe('located_in');
    expect(canonicaliseRelation('spouse_of')).toBe('married_to');
  });
  it('collapses the observed stage-1 drift (banking + salary → canonical)', () => {
    expect(canonicaliseRelation('holds_account_at')).toBe('banks_with');
    expect(canonicaliseRelation('maintains_account_at')).toBe('banks_with');
    expect(canonicaliseRelation('receives_salary_from')).toBe('employed_by');
  });
  it('drops vacuous verbs to empty', () => {
    for (const v of ['is', 'has', 'related_to', 'associated_with', 'of'])
      expect(canonicaliseRelation(v)).toBe('');
  });
  it('leaves distinct senses untouched (no over-merging)', () => {
    expect(canonicaliseRelation('provides')).toBe('provides');
    expect(canonicaliseRelation('provides_services_to')).toBe('provides_services_to');
    expect(canonicaliseRelation('contracts_for')).toBe('contracts_for');
  });
});

describe('sanitiseRelation — canonicalization', () => {
  it('normalises then canonicalises ("Works At" → employed_by)', () => {
    expect(sanitiseRelation({ subject: 'S', relation: 'Works At', object: 'O', confidence: 1 }).relation).toBe('employed_by');
  });
  it('vacuous verb sanitises to empty (so parse drops it)', () => {
    expect(sanitiseRelation({ subject: 'S', relation: 'is', object: 'O', confidence: 1 }).relation).toBe('');
  });
});

describe('parseExtractorOutput — relations', () => {
  it('canonicalises synonyms and drops vacuous verbs end-to-end', () => {
    const out = parseExtractorOutput(
      JSON.stringify({
        summary: 'x', facts: [], entities: [],
        relations: [
          { subject: 'Sarah', relation: 'works at', object: 'Lister' },
          { subject: 'Jason', relation: 'is', object: 'busy' }, // vacuous → dropped
        ],
      }),
    );
    expect(out.relations).toHaveLength(1);
    expect(out.relations[0]).toMatchObject({ subject: 'Sarah', relation: 'employed_by', object: 'Lister' });
  });
});

describe('parseExtractorOutput — relations (basic)', () => {
  it('parses + sanitises a relations array', () => {
    const out = parseExtractorOutput(
      JSON.stringify({
        summary: 'x',
        facts: [],
        entities: [{ name: 'Sarah', kind: 'person' }, { name: 'Lister', kind: 'org' }],
        relations: [{ subject: 'Sarah', relation: 'Reports To', object: 'Lister', confidence: 0.9 }],
      }),
    );
    expect(out.relations).toHaveLength(1);
    expect(out.relations[0]).toMatchObject({ subject: 'Sarah', relation: 'reports_to', object: 'Lister' });
  });
  it('drops invalid relations (self-loop, blank, verb→empty)', () => {
    const out = parseExtractorOutput(
      JSON.stringify({
        summary: 'x',
        facts: [],
        entities: [],
        relations: [
          { subject: 'A', relation: 'is', object: 'a' }, // self-loop
          { subject: 'A', relation: '', object: 'B' }, // blank verb
          { subject: 'A', relation: '!!!', object: 'B' }, // verb sanitises to empty
          { subject: 'A', relation: 'knows', object: 'B' }, // valid
        ],
      }),
    );
    expect(out.relations).toHaveLength(1);
    expect(out.relations[0]!.relation).toBe('knows');
  });
  it('defaults relations to [] when absent (back-compat with old prompt)', () => {
    const out = parseExtractorOutput(JSON.stringify({ summary: 'x', facts: [], entities: [] }));
    expect(out.relations).toEqual([]);
  });
});
