/**
 * markContentChanged's pure half (A10 #7): which fields a write changed.
 * What the reset and the announcement do on a real database is the db test's
 * (server/web/server/a10-content-changed.db.test.ts).
 */
import { describe, expect, it } from 'vitest';
import { SUMMARY_KEYS, changedFields } from './content-changed';

describe('changedFields', () => {
  it('names the fields whose values differ, by value', () => {
    expect(
      changedFields({
        title: ['Pump', 'Valve'],
        body: ['same', 'same'],
        tags: [['a'], ['a', 'b']],
      }),
    ).toEqual(['title', 'tags']);
  });

  it('reads undefined as null: a field that stays absent did not change', () => {
    expect(changedFields({ due_at: [undefined, null], location: [undefined, 'Plant'] })).toEqual([
      'location',
    ]);
  });

  it('compares objects with their keys in one order (jsonb reorders them)', () => {
    const stored = { name: 'Flow', id: 'f1', vars: [{ symbol: 'a', role: 'input' }] };
    const sent = { id: 'f1', name: 'Flow', vars: [{ role: 'input', symbol: 'a' }] };
    expect(changedFields({ spec: [stored, sent] })).toEqual([]);
    expect(changedFields({ spec: [stored, { ...sent, id: 'f2' }] })).toEqual(['spec']);
  });

  it('leaves out a field given no pair', () => {
    expect(changedFields({ title: undefined })).toEqual([]);
  });
});

describe('the summary keys an extract reset drops', () => {
  it('are the four every content write dropped by hand before A10 #7', () => {
    expect(SUMMARY_KEYS).toEqual(['summary', 'summary_model', 'summary_at', 'entities']);
  });
});
