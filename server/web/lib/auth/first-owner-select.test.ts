/**
 * The first owner's insert is a typed insert-select: drizzle names every
 * column of auth.users in the table's order, and firstOwnerSelect gives the
 * values by position. A column added, dropped or moved in the schema would
 * make the signup fail (a count) or fill the wrong column (an order): this
 * holds the pairs, with no database (drizzle.mock renders the statement).
 */
import { authUsers } from '@mantle/db';
import { getTableColumns } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import { describe, expect, it } from 'vitest';
import { insertSelectPairs } from '@mantle/db/sql-text';
import { firstOwnerSelect } from './first-owner';

describe('firstOwnerSelect', () => {
  it('gives every auth.users column its value, in the table order', () => {
    const { sql } = drizzle
      .mock()
      .insert(authUsers)
      .select(firstOwnerSelect('00000000-0000-4000-8000-000000000001', 'a@example.invalid', 'h'))
      .toSQL();
    const pairs = insertSelectPairs(sql);
    expect(pairs?.length).toBe(Object.keys(getTableColumns(authUsers)).length);
    expect(pairs).toEqual([
      ['id', '$1::uuid'],
      ['email', '$2'],
      ['password_hash', '$3'],
      ['created_at', 'now()'],
      ['is_owner', 'true'],
      ['display_name', 'null'],
      ['last_login_at', 'null'],
      ['role', "'admin'"],
      ['contact_id', 'null'],
      ['disabled_at', 'null'],
      ['session_epoch', '0'],
      ['must_change_password', 'false'],
    ]);
    expect(sql).toMatch(/WHERE NOT EXISTS \(SELECT 1 FROM auth\.users\)\s*$/);
  });
});
