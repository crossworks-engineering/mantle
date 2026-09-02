/**
 * Tests for the tool-call arguments parser. This is the guard that
 * stops the model from spinning forever on a malformed-JSON tool call.
 *
 * The bug we fixed: if the model emitted `{"a": "b}` (missing closing
 * quote) the loop used to silently set `input = {}` and dispatch the
 * tool. The tool would either succeed-with-defaults or fail with a
 * shape error, and the model couldn't tell its JSON was wrong, so it
 * re-issued the same broken call. Now we surface a structured error
 * the model can react to.
 */

import { describe, expect, it } from 'vitest';
import { parseToolArgs } from './tool-args';

describe('parseToolArgs', () => {
  describe('happy path', () => {
    it('parses a valid object', () => {
      expect(parseToolArgs('{"a": 1, "b": "two"}')).toEqual({
        ok: true,
        input: { a: 1, b: 'two' },
      });
    });

    it('parses an empty object', () => {
      expect(parseToolArgs('{}')).toEqual({ ok: true, input: {} });
    });

    it('treats undefined as an empty-object call', () => {
      expect(parseToolArgs(undefined)).toEqual({ ok: true, input: {} });
    });

    it('treats null as an empty-object call', () => {
      expect(parseToolArgs(null)).toEqual({ ok: true, input: {} });
    });

    it('treats "" as an empty-object call', () => {
      expect(parseToolArgs('')).toEqual({ ok: true, input: {} });
    });

    it('preserves nested objects and arrays inside the input', () => {
      const result = parseToolArgs('{"items": [1, 2, 3], "nested": {"deep": true}}');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.input).toEqual({
          items: [1, 2, 3],
          nested: { deep: true },
        });
      }
    });
  });

  describe('error path — malformed JSON', () => {
    it('surfaces a parse error for unterminated strings', () => {
      const r = parseToolArgs('{"a": "b}');
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error).toMatch(/not valid JSON/);
      }
    });

    it('surfaces a parse error for trailing commas', () => {
      const r = parseToolArgs('{"a": 1,}');
      expect(r.ok).toBe(false);
    });

    it('surfaces a parse error for bare identifiers', () => {
      const r = parseToolArgs('{a: 1}');
      expect(r.ok).toBe(false);
    });

    it('surfaces a parse error for plain garbage', () => {
      const r = parseToolArgs('not json at all');
      expect(r.ok).toBe(false);
    });
  });

  describe('error path — valid JSON, wrong shape', () => {
    it('rejects a JSON null', () => {
      const r = parseToolArgs('null');
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/must be a JSON object/);
    });

    it('rejects a JSON array', () => {
      const r = parseToolArgs('[1, 2, 3]');
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/must be a JSON object/);
    });

    it('rejects a bare number', () => {
      const r = parseToolArgs('42');
      expect(r.ok).toBe(false);
    });

    it('rejects a bare string', () => {
      const r = parseToolArgs('"just a string"');
      expect(r.ok).toBe(false);
    });

    it('rejects a bare boolean', () => {
      const r = parseToolArgs('true');
      expect(r.ok).toBe(false);
    });
  });
});
