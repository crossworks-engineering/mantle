/**
 * Tests for the central coerce-then-validate layer (validate-args.ts).
 *
 * This module is the difference between "the model's near-miss arg becomes a
 * silently wrong call" and "the model gets a teaching error and self-corrects
 * in one retry" — so the properties under test are behavioural guarantees:
 *
 *   1. Safe repairs fix encoding drift WITHOUT changing intent, and every
 *      repair is reported (telemetry is the warn-mode rollout story).
 *   2. Violations carry teaching text: field name, expectation, what arrived,
 *      and a near-miss suggestion where one exists.
 *   3. Unknown keys are reported always, but only VIOLATE on a schema that
 *      opted in with additionalProperties:false — tables/api tools take
 *      dynamic keys and must never be blocked by this layer.
 *   4. Fail open on anything we don't understand: no schema, no properties,
 *      exotic type keywords → passthrough, never invented constraints.
 */

import { describe, expect, it } from 'vitest';
import { closestMatch, validateToolArgs } from './validate-args';

const SCHEMA = {
  type: 'object',
  properties: {
    q: { type: 'string', description: 'free-text query' },
    limit: { type: 'integer', minimum: 1, maximum: 50 },
    score: { type: 'number' },
    exact: { type: 'boolean' },
    tags: { type: 'array', items: { type: 'string' } },
    kind: { type: 'string', enum: ['branch', 'email', 'file', 'note'] },
    filters: { type: 'object' },
  },
  required: ['q'],
};

describe('coercion (safe repairs)', () => {
  it('coerces numeric strings for number/integer params and reports the repair', () => {
    const r = validateToolArgs(SCHEMA, { q: 'x', limit: '25', score: '0.5' }, 't');
    expect(r.error).toBeNull();
    expect(r.input.limit).toBe(25);
    expect(r.input.score).toBe(0.5);
    expect(r.repairs.map((x) => x.kind)).toEqual(['number', 'number']);
  });

  it('coerces "true"/"false" strings for boolean params', () => {
    const r = validateToolArgs(SCHEMA, { q: 'x', exact: 'True' }, 't');
    expect(r.error).toBeNull();
    expect(r.input.exact).toBe(true);
    expect(r.repairs[0]?.kind).toBe('boolean');
  });

  it('stringifies numbers/booleans for string params', () => {
    const r = validateToolArgs(SCHEMA, { q: 42 }, 't');
    expect(r.error).toBeNull();
    expect(r.input.q).toBe('42');
    expect(r.repairs[0]?.kind).toBe('string');
  });

  it('wraps a bare scalar when an array is expected', () => {
    const r = validateToolArgs(SCHEMA, { q: 'x', tags: 'urgent' }, 't');
    expect(r.error).toBeNull();
    expect(r.input.tags).toEqual(['urgent']);
    expect(r.repairs[0]?.kind).toBe('array-wrap');
  });

  it('JSON-parses a stringified object/array for structured params', () => {
    const r = validateToolArgs(SCHEMA, { q: 'x', filters: '{"a":1}', tags: '["a","b"]' }, 't');
    expect(r.error).toBeNull();
    expect(r.input.filters).toEqual({ a: 1 });
    expect(r.input.tags).toEqual(['a', 'b']);
    expect(r.repairs.every((x) => x.kind === 'json-parse')).toBe(true);
  });

  it('drops explicit null on an OPTIONAL param (model saying "unset")', () => {
    const r = validateToolArgs(SCHEMA, { q: 'x', limit: null }, 't');
    expect(r.error).toBeNull();
    expect('limit' in r.input).toBe(false);
    expect(r.repairs[0]?.kind).toBe('null-drop');
  });

  it('does not mutate the caller input object', () => {
    const original = { q: 'x', limit: '25' };
    validateToolArgs(SCHEMA, original, 't');
    expect(original.limit).toBe('25');
  });

  it('leaves already-valid values untouched with zero repairs', () => {
    const r = validateToolArgs(
      SCHEMA,
      { q: 'x', limit: 10, exact: false, tags: ['a'], kind: 'email' },
      't',
    );
    expect(r.repairs).toEqual([]);
    expect(r.violations).toEqual([]);
    expect(r.error).toBeNull();
  });
});

describe('violations (teaching errors)', () => {
  it('flags a missing required param, quoting its description', () => {
    const r = validateToolArgs(SCHEMA, {}, 'search_nodes');
    expect(r.error).toContain("invalid arguments for 'search_nodes'");
    expect(r.error).toContain("'q' is required");
    expect(r.error).toContain('free-text query');
    expect(r.error).toContain('do not retry with the same arguments');
  });

  it('treats null on a REQUIRED param as missing', () => {
    const r = validateToolArgs(SCHEMA, { q: null }, 't');
    expect(r.error).toContain("'q' is required");
  });

  it('flags an uncoercible type with what arrived', () => {
    const r = validateToolArgs(SCHEMA, { q: 'x', limit: 'twenty' }, 't');
    expect(r.error).toContain("'limit' must be an integer");
    expect(r.error).toContain('twenty');
  });

  it('suggests the nearest enum value on a near-miss', () => {
    const r = validateToolArgs(SCHEMA, { q: 'x', kind: 'emial' }, 't');
    expect(r.error).toContain('must be one of: branch, email, file, note');
    expect(r.error).toContain("did you mean 'email'?");
  });

  it('gives no enum suggestion on an unrelated miss', () => {
    const r = validateToolArgs(SCHEMA, { q: 'x', kind: 'zzzzzzz' }, 't');
    expect(r.error).toContain('must be one of');
    expect(r.error).not.toContain('did you mean');
  });

  it('flags out-of-range numbers with the allowed range', () => {
    const r = validateToolArgs(SCHEMA, { q: 'x', limit: 500 }, 't');
    expect(r.error).toContain("'limit' must be between 1 and 50 (got 500)");
  });

  it('flags a non-integral value for an integer param (no silent floor)', () => {
    const r = validateToolArgs(SCHEMA, { q: 'x', limit: 2.5 }, 't');
    expect(r.error).toContain("'limit' must be an integer (got 2.5)");
  });

  it('flags a wrong-typed array element with its index', () => {
    const r = validateToolArgs(SCHEMA, { q: 'x', tags: ['ok', 7] }, 't');
    expect(r.error).toContain("'tags' must be an array of strings");
    expect(r.error).toContain('element 1');
  });

  it('collects multiple violations into one error', () => {
    const r = validateToolArgs(SCHEMA, { limit: 999, kind: 'nope' }, 't');
    expect(r.violations.length).toBe(3); // q missing, limit range, kind enum
    expect(r.error).toContain("'q' is required");
    expect(r.error).toContain("'limit' must be between");
  });
});

describe('unknown keys', () => {
  it('reports unknown keys with a did-you-mean, without violating on an open schema', () => {
    const r = validateToolArgs(SCHEMA, { q: 'x', limt: 5 }, 't');
    expect(r.error).toBeNull(); // open schema: telemetry only
    expect(r.unknownKeys).toEqual([{ key: 'limt', suggestion: 'limit' }]);
  });

  it('violates on unknown keys when additionalProperties is false', () => {
    const closed = { ...SCHEMA, additionalProperties: false };
    const r = validateToolArgs(closed, { q: 'x', limt: 5 }, 't');
    expect(r.error).toContain("'limt' is not a parameter of this tool");
    expect(r.error).toContain("did you mean 'limit'?");
    expect(r.error).toContain('declared parameters:');
  });

  it('offers no suggestion for a key nothing resembles', () => {
    const r = validateToolArgs(SCHEMA, { q: 'x', frobnicate: 1 }, 't');
    expect(r.unknownKeys[0]?.suggestion).toBeNull();
  });
});

describe('fail-open behaviour', () => {
  it('passes through with no schema', () => {
    const input = { anything: 'goes' };
    const r = validateToolArgs(null, input, 't');
    expect(r.input).toBe(input);
    expect(r.error).toBeNull();
  });

  it('passes through with empty properties', () => {
    const r = validateToolArgs({ type: 'object', properties: {} }, { a: 1 }, 't');
    expect(r.error).toBeNull();
    expect(r.unknownKeys).toEqual([]);
  });

  it('skips validation for properties with unknown type keywords', () => {
    const schema = {
      type: 'object',
      properties: { weird: { type: 'unicorn' }, both: { type: ['string', 'number'] } },
    };
    const ok = validateToolArgs(schema, { weird: { deep: true }, both: 3 }, 't');
    expect(ok.error).toBeNull();
  });

  it('accepts any listed type for union-typed properties', () => {
    const schema = {
      type: 'object',
      properties: { v: { type: ['string', 'number'] } },
    };
    expect(validateToolArgs(schema, { v: 'x' }, 't').error).toBeNull();
    expect(validateToolArgs(schema, { v: 3 }, 't').error).toBeNull();
    // An object satisfies neither branch and nothing can safely repair it.
    const r = validateToolArgs(schema, { v: { nested: true } }, 't');
    expect(r.error).toContain("'v' must be a string or a number (got an object)");
  });
});

describe('closestMatch', () => {
  it('matches by containment', () => {
    expect(closestMatch('page', ['page_id', 'title'])).toBe('page_id');
  });
  it('matches small typos by edit distance', () => {
    expect(closestMatch('resercher', ['researcher', 'reader'])).toBe('researcher');
  });
  it('returns null when nothing is close', () => {
    expect(closestMatch('zzz', ['alpha', 'beta'])).toBeNull();
  });
  it('returns null for empty candidates', () => {
    expect(closestMatch('x', [])).toBeNull();
  });
});
