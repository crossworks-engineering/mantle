/**
 * The extract-exempt rule's two forms (extract-exempt.ts): the gate's
 * `isExtractExempt` and the drain, sweep and re-embed's `extractExemptSql`.
 * The SQL form is proven on Postgres in extract-exempt.db.test.ts; here the
 * loaded-node form, the one the extractor's gate asks.
 */
import { describe, expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import {
  CLIENT_REQUEST_SOURCE,
  FORUM_ARCHIVE_SOURCE,
  TEAM_REQUEST_SOURCE,
  extractExemptSql,
  isExtractExempt,
} from './extract-exempt';

describe('isExtractExempt', () => {
  it('holds a Forum archive page for good', () => {
    expect(isExtractExempt({ data: { source: FORUM_ARCHIVE_SOURCE } })).toBe(true);
    expect(
      isExtractExempt({ data: { source: FORUM_ARCHIVE_SOURCE, reviewed_at: '2026-09-28' } }),
    ).toBe(true);
  });

  it('holds a team request until an admin has acted on it', () => {
    expect(isExtractExempt({ data: { source: TEAM_REQUEST_SOURCE } })).toBe(true);
    expect(isExtractExempt({ data: { source: TEAM_REQUEST_SOURCE, reviewed_at: '' } })).toBe(true);
    expect(
      isExtractExempt({
        data: { source: TEAM_REQUEST_SOURCE, reviewed_at: '2026-09-28T10:00:00.000Z' },
      }),
    ).toBe(false);
  });

  it('holds a CLIENT request the same way (client logins C4)', () => {
    expect(isExtractExempt({ data: { source: CLIENT_REQUEST_SOURCE } })).toBe(true);
    expect(
      isExtractExempt({ data: { source: CLIENT_REQUEST_SOURCE, reviewed_at: '2026-09-29' } }),
    ).toBe(false);
  });

  it('leaves every other node alone', () => {
    expect(isExtractExempt({ data: null })).toBe(false);
    expect(isExtractExempt({ data: {} })).toBe(false);
    expect(isExtractExempt({ data: { source: 'editor' } })).toBe(false);
  });
});

describe('extractExemptSql', () => {
  it('names both sources and the review stamp', () => {
    const q = new PgDialect().sqlToQuery(extractExemptSql());
    expect(q.params).toContain(FORUM_ARCHIVE_SOURCE);
    expect(q.params).toContain(TEAM_REQUEST_SOURCE);
    expect(q.params).toContain(CLIENT_REQUEST_SOURCE);
    expect(q.sql).toContain(`'reviewed_at'`);
  });
});
