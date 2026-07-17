/**
 * Tests for the seed-time schema closer. The invariant under test: every
 * builtin ships to the DB (and therefore to the model AND the central
 * validator) with a CLOSED top level — unknown keys become teaching errors
 * in enforce mode — while schemas that took an explicit position, nested
 * dynamic-key props, and zero-arg tools are left exactly as authored.
 */

import { describe, expect, it, vi } from 'vitest';

// seed.ts imports @mantle/db at module scope; the pure function under test
// never touches it. Spread the REAL module (its `db` export is a lazy proxy —
// importing it opens no connection) so transitive schema imports keep
// resolving as tables are added; only `db` and `tools` stay stubbed.
vi.mock('@mantle/db', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  db: {},
  tools: {},
}));

import { closeToolInputSchema } from './seed';

describe('closeToolInputSchema', () => {
  it('closes a plain object schema with properties', () => {
    const schema = {
      type: 'object',
      properties: { q: { type: 'string' } },
      required: ['q'],
    };
    const closed = closeToolInputSchema(schema);
    expect(closed.additionalProperties).toBe(false);
    // Original untouched (defs are shared module state).
    expect('additionalProperties' in schema).toBe(false);
  });

  it('respects an explicit additionalProperties: true (opt-out)', () => {
    const schema = {
      type: 'object',
      properties: { anything: { type: 'string' } },
      additionalProperties: true,
    };
    expect(closeToolInputSchema(schema)).toBe(schema);
  });

  it('respects an explicit additionalProperties: false (already closed)', () => {
    const schema = {
      type: 'object',
      properties: { cmd: { type: 'string' } },
      additionalProperties: false,
    };
    expect(closeToolInputSchema(schema)).toBe(schema);
  });

  it('leaves zero-arg tools open (nothing to protect, no noise for the model)', () => {
    const schema = { type: 'object', properties: {} };
    expect(closeToolInputSchema(schema)).toBe(schema);
  });

  it('leaves non-object schemas untouched', () => {
    const schema = { type: 'string' } as Record<string, unknown>;
    expect(closeToolInputSchema(schema)).toBe(schema);
  });

  it('does not descend into nested dynamic-key props (table cells, app files)', () => {
    const schema = {
      type: 'object',
      properties: {
        id: { type: 'string' },
        cells: { type: 'object', additionalProperties: true },
        files: { type: 'object', additionalProperties: { type: 'string' } },
      },
      required: ['id'],
    };
    const closed = closeToolInputSchema(schema);
    expect(closed.additionalProperties).toBe(false);
    const props = closed.properties as Record<string, Record<string, unknown>>;
    expect(props.cells!.additionalProperties).toBe(true);
    expect(props.files!.additionalProperties).toEqual({ type: 'string' });
  });
});
