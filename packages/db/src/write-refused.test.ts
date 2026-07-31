import { describe, expect, it } from 'vitest';
import { isWriteRefused } from './write-refused';

/**
 * Read paths that perform an opportunistic write — the traces self-heal, the
 * docs collection seed — used to 500 against a database that will not accept
 * writes. These are the two codes that mean "refused", and just as importantly
 * the ones that must still throw: laundering a broken query into a silent
 * success is a worse bug than the 500 this replaces.
 */
describe('isWriteRefused', () => {
  it('recognises a role without write privilege', () => {
    expect(isWriteRefused({ code: '42501' })).toBe(true);
  });

  it('recognises a read-only transaction', () => {
    expect(isWriteRefused({ code: '25006' })).toBe(true);
  });

  it('unwraps the driver error through a wrapper cause', () => {
    expect(isWriteRefused(new Error('Failed query', { cause: { code: '42501' } }))).toBe(true);
  });

  it('does NOT swallow other database errors', () => {
    expect(isWriteRefused({ code: '23505' })).toBe(false); // unique_violation
    expect(isWriteRefused({ code: '23503' })).toBe(false); // foreign_key_violation
    expect(isWriteRefused({ code: '08006' })).toBe(false); // connection_failure
    expect(isWriteRefused(new Error('boom'))).toBe(false);
    expect(isWriteRefused(null)).toBe(false);
  });
});
