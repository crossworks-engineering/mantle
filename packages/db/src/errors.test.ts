/**
 * These predicates decide whether a GET is allowed to swallow an error. Too
 * narrow and a read path 500s for something it could have survived; too broad
 * and a genuinely broken query is hidden behind an empty screen. The negative
 * cases below matter more than the positive ones.
 */
import { describe, expect, it } from 'vitest';
import { isSubsystemMissing, isWriteRefused } from './errors';

describe('isWriteRefused', () => {
  it('recognises a role without INSERT privilege', () => {
    expect(isWriteRefused({ code: '42501' })).toBe(true);
  });

  it('recognises a read-only transaction', () => {
    expect(isWriteRefused({ code: '25006' })).toBe(true);
  });

  it('unwraps the driver error through a wrapper cause', () => {
    // Drizzle wraps the postgres error, so the code is not on the top object.
    expect(isWriteRefused(new Error('Failed query', { cause: { code: '42501' } }))).toBe(true);
  });

  it('does NOT swallow other database errors', () => {
    expect(isWriteRefused({ code: '23505' })).toBe(false); // unique_violation
    expect(isWriteRefused({ code: '3F000' })).toBe(false); // invalid_schema_name
    expect(isWriteRefused(new Error('connection refused'))).toBe(false);
    expect(isWriteRefused(undefined)).toBe(false);
  });

  it('gives up rather than walking an unbounded cause chain', () => {
    // A self-referential cause must not hang the predicate.
    const a: { code: string; cause?: unknown } = { code: 'X' };
    a.cause = a;
    expect(isWriteRefused(a)).toBe(false);
  });
});

describe('isSubsystemMissing', () => {
  it('recognises tables that were never created here', () => {
    expect(isSubsystemMissing({ code: '3F000' })).toBe(true); // invalid_schema_name
    expect(isSubsystemMissing({ code: '42P01' })).toBe(true); // undefined_table
  });

  it('treats "not allowed to see it" the same as "not there"', () => {
    // A least-privilege role reports insufficient_privilege for a subsystem it
    // equally cannot read; to a reader those are the same answer.
    expect(isSubsystemMissing({ code: '42501' })).toBe(true);
  });

  it('does NOT swallow a real query failure', () => {
    expect(isSubsystemMissing({ code: '23505' })).toBe(false);
    expect(isSubsystemMissing({ code: '25006' })).toBe(false); // read-only ≠ absent
    expect(isSubsystemMissing(new Error('ECONNREFUSED'))).toBe(false);
    expect(isSubsystemMissing(null)).toBe(false);
  });

  it('unwraps through a wrapper cause', () => {
    expect(isSubsystemMissing(new Error('Failed query', { cause: { code: '42P01' } }))).toBe(true);
  });
});

describe('the two predicates are deliberately different', () => {
  // 25006 means "the database is up and refusing to write" — the subsystem is
  // there. 3F000/42P01 mean "there is nothing here to read". Conflating them
  // would make a read-only deployment report every optional subsystem as absent.
  it('read-only is a write refusal, not a missing subsystem', () => {
    expect(isWriteRefused({ code: '25006' })).toBe(true);
    expect(isSubsystemMissing({ code: '25006' })).toBe(false);
  });

  it('an undefined table is missing, not a write refusal', () => {
    expect(isSubsystemMissing({ code: '42P01' })).toBe(true);
    expect(isWriteRefused({ code: '42P01' })).toBe(false);
  });
});
