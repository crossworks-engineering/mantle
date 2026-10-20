/**
 * The audit row's insert is a typed insert-select: drizzle names every
 * column of audit_log in the table's order, and auditRowSelect gives the
 * values by position. A column added, dropped or moved in the schema would
 * make the insert fail (a count) or fill the wrong column (an order), and
 * the audit row's failure is only logged: this holds the pairs, with no
 * database (drizzle.mock renders the statement).
 */
import { drizzle } from 'drizzle-orm/postgres-js';
import { getTableColumns } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { auditRowSelect } from './call-audit';
import { auditLog } from './schema/audit-log';
import { insertSelectPairs } from './sql-text';

describe('auditRowSelect', () => {
  it('gives every audit_log column its value, in the table order', () => {
    const row = {
      loginId: '00000000-0000-4000-8000-000000000001',
      actorLabel: 'login',
      method: 'tool',
      path: 'note_create',
      meta: { ip: '127.0.0.1', userAgent: 'test' },
      detail: { tool: 'note_create' },
    };
    const { sql } = drizzle.mock().insert(auditLog).select(auditRowSelect(row)).toSQL();
    const pairs = insertSelectPairs(sql);
    expect(pairs?.length).toBe(Object.keys(getTableColumns(auditLog)).length);
    expect(pairs).toEqual([
      ['id', 'gen_random_uuid()'],
      ['actor_id', 'u.id'],
      ['actor_email', 'coalesce(u.email, $1)'],
      ['action', "'api.write'"],
      ['method', '$2'],
      ['path', '$3'],
      ['ip', '$4'],
      ['user_agent', '$5'],
      ['detail', '$6::jsonb'],
      ['created_at', 'now()'],
    ]);
  });
});
