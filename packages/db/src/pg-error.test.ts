import { describe, expect, it } from 'vitest';
import { isUniqueViolation, pgConstraint, pgErrorCode } from './pg-error';

/** The shape drizzle 0.45 throws from its query builder: no code on top. */
function drizzleQueryError(cause: unknown): Error {
  return Object.assign(
    new Error(
      'Failed query: insert into "auth"."users" ("id", "email") values ($1, $2)\nparams: x,y',
    ),
    { query: 'insert ...', params: [], cause },
  );
}

const pgUnique = Object.assign(
  new Error('duplicate key value violates unique constraint "users_email_key"'),
  { code: '23505', constraint_name: 'users_email_key' },
);

describe('pgErrorCode', () => {
  it('reads the code off a bare driver error', () => {
    expect(pgErrorCode(pgUnique)).toBe('23505');
  });

  it('reads the code off the cause of a drizzle query error', () => {
    expect(pgErrorCode(drizzleQueryError(pgUnique))).toBe('23505');
    expect(pgErrorCode(drizzleQueryError({ code: '23503' }))).toBe('23503');
    expect(pgErrorCode(drizzleQueryError({ code: '40001' }))).toBe('40001');
  });

  it('walks up to three causes, no further', () => {
    const wrap = (cause: unknown) => ({ message: 'wrapper', cause });
    expect(pgErrorCode(wrap(wrap(wrap({ code: '23505' }))))).toBe('23505');
    expect(pgErrorCode(wrap(wrap(wrap(wrap({ code: '23505' })))))).toBeNull();
  });

  it('returns null for errors that carry no SQLSTATE', () => {
    expect(pgErrorCode(new Error('duplicate key value violates unique constraint'))).toBeNull();
    expect(pgErrorCode(Object.assign(new Error('x'), { code: 'ENOENT' }))).toBeNull();
    expect(pgErrorCode({ code: 23505 })).toBeNull();
    expect(pgErrorCode(null)).toBeNull();
    expect(pgErrorCode(undefined)).toBeNull();
    expect(pgErrorCode('23505')).toBeNull();
  });

  it('survives a cause cycle', () => {
    const a: { message: string; cause?: unknown } = { message: 'a' };
    a.cause = a;
    expect(pgErrorCode(a)).toBeNull();
  });
});

describe('isUniqueViolation', () => {
  it('is true for 23505 on the error or its cause', () => {
    expect(isUniqueViolation(pgUnique)).toBe(true);
    expect(isUniqueViolation(drizzleQueryError(pgUnique))).toBe(true);
  });

  it('is false for other codes and for message-only errors', () => {
    expect(isUniqueViolation(drizzleQueryError({ code: '23503' }))).toBe(false);
    expect(isUniqueViolation(new Error('duplicate key value violates unique constraint'))).toBe(
      false,
    );
  });
});

describe('pgConstraint', () => {
  it('names the constraint from the error that carries the code', () => {
    expect(pgConstraint(pgUnique)).toBe('users_email_key');
    expect(pgConstraint(drizzleQueryError(pgUnique))).toBe('users_email_key');
  });

  it('is null when there is no Postgres error or no name', () => {
    expect(pgConstraint(new Error('users_email_key'))).toBeNull();
    expect(pgConstraint(drizzleQueryError({ code: '40001' }))).toBeNull();
  });
});
