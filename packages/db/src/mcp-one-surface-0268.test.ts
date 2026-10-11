/**
 * Migration 0268 (workspaces W7b), W7 integration fix:
 *  - section 3 locks the credential tables in the order a token exchange
 *    meets them (access_keys, the OAuth code, the OAuth tokens), then the
 *    peers and the login tokens, so the two cannot deadlock;
 *  - its three archive tables are in the access matrix, read by no role.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ACCESS_MATRIX } from './access-matrix';

const SQL = readFileSync(
  path.join(__dirname, '..', 'migrations', '0268_workspaces_mcp_one_surface.sql'),
  'utf8',
);

describe('0268: one MCP surface', () => {
  it('locks the credential tables in the token exchange order', () => {
    const lock = /LOCK TABLE ([^;]+?) IN SHARE ROW EXCLUSIVE MODE;/.exec(SQL);
    expect(lock).not.toBeNull();
    const order = [...lock![1]!.matchAll(/"public"\."(\w+)"/g)].map((m) => m[1]);
    expect(order).toEqual([
      'access_keys',
      'oauth_auth_codes',
      'oauth_access_tokens',
      'mantle_peers',
      'mcp_login_tokens',
    ]);
  });

  it('does not claim reads of access_keys go on under the ALTER', () => {
    expect(SQL).toContain('ACCESS EXCLUSIVE');
    expect(SQL).not.toMatch(/lock_timeout, above\); reads go on\./);
  });

  it('lists its archive tables in the access matrix, read by no role', () => {
    for (const t of ['archive_mcp_cutoff', 'archive_mcp_login_access', 'archive_tool_levels']) {
      const row = ACCESS_MATRIX.find((a) => a.table === `public.${t}`);
      expect(row, t).toBeDefined();
      expect(row).toMatchObject({ read: 'none', rule: 'none' });
    }
  });
});
