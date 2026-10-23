/**
 * The callers of loginDefinerCall, pinned per file: a definer call in a
 * login's scope on the system pool is made only where it is listed (an
 * Admin act's, the member turn ledger's). A new caller fails here first.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..', '..');

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) sources(p, out);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

describe('loginDefinerCall callers', () => {
  it('are the Admin acts and the member turn ledger, each with its count', () => {
    const found: Record<string, number> = {};
    for (const top of ['packages', 'server']) {
      for (const file of sources(join(ROOT, top))) {
        const rel = relative(ROOT, file);
        if (rel === 'packages/db/src/login-definer.ts' || /\/test-support\//.test(rel)) continue;
        const n = (readFileSync(file, 'utf8').match(/\bloginDefinerCall\s*(<[^>]*>)?\s*\(/g) ?? [])
          .length;
        if (n > 0) found[rel] = n;
      }
    }
    expect(found).toEqual({
      // asAdmin, the one wrapper every Admin act goes through.
      'packages/content/src/admin-acts.ts': 1,
      // The claim, the release and the settle.
      'packages/content/src/member-turn-ledger.ts': 3,
    });
  });
});

describe('loginDefinerCall statement shape', () => {
  it('takes one select of one mantle_* function with bound arguments, nothing beside it', async () => {
    const { DEFINER_CALL } = await import('./login-definer');
    // The callers' own shapes, as drizzle renders them.
    for (const ok of [
      'select ok, fresh, reason, used from mantle_member_turn_claim($1::text,\n        $2::uuid, $3::timestamptz, $4::integer,\n        $5::bigint)',
      'select mantle_member_turn_release($1::text)',
      'select mantle_member_turn_settle($1::text, $2::bigint) as hit',
      'select outcome, revoked from mantle_contact_sharing_set($1::uuid, $2::text)',
      'select share_id::text, contact_id::text, token, refused\n            from mantle_share_with_contacts($1::uuid, $2::uuid[],\n                   $3::text[], $4, $5::text[])',
      'select mantle_entity_merge($1::uuid, $2::uuid) as ok',
      'select outcome, contact::text as contact\n          from mantle_share_contact_write_set($1::uuid, $2)',
      'select outcome, seq, code, db_path, schema_version, member_era\n          from mantle_app_trash_act($1::uuid, $2)',
      'select "public"."mantle_share_close_admin"($1::uuid) as outcome',
    ]) {
      expect(DEFINER_CALL.test(ok), ok).toBe(true);
    }
    for (const bad of [
      'select mantle_entity_merge($1::uuid, $2::uuid), mantle_member_turn_release($3)',
      'select mantle_entity_merge($1::uuid, mantle_x($2))',
      'select * from nodes, mantle_entity_merge($1::uuid, $2::uuid)',
      'select mantle_entity_merge($1::uuid, $2::uuid) where pg_sleep(1) is null',
      'select mantle_entity_merge($1::uuid, $2::uuid); delete from nodes',
      'select mantle_entity_merge((select id from nodes limit 1), $1)',
      'select set_config($1, $2, true), mantle_entity_merge($3::uuid, $4::uuid)',
      'update nodes set title = $1 returning mantle_entity_merge($2, $3)',
    ]) {
      expect(DEFINER_CALL.test(bad), bad).toBe(false);
    }
  });
});
