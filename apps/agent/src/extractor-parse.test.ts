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
  isValidEntity,
  isValidFact,
  parseExtractorOutput,
  sanitiseFactEntities,
  type ExtractedFact,
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
    });
  });
});

describe('parseExtractorOutput — error path', () => {
  it('returns an empty result on malformed JSON', () => {
    const out = parseExtractorOutput('not json {');
    expect(out).toEqual({ summary: '', facts: [], entities: [] });
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
