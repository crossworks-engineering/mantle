/**
 * The rights counts (rights-counts.mjs): each counter on small inputs, and
 * the repo's numbers that must hold whatever the pins say. The pins
 * themselves are checked by `pnpm arch:check` (scripts/arch-scoreboard.ts).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
// @ts-expect-error: plain-JS module, no types shipped.
import { countedFiles, readRepoFile } from './arch-counts.mjs';
import {
  a8ExemptKeys,
  kindsOutsideGrid,
  legacyPrecheckUndated,
  migrationFunctions,
  requestSystemExits,
  rightsCounts,
  scopeHoldsAdminCalls,
  toolPoliciesUncovered,
  tsAdminRuleSql,
  tsSetAssistantDefs,
  workspaceTableRawWrites,
  writesWorkspaceTable,
  // @ts-expect-error: plain-JS module, no types shipped.
} from './rights-counts.mjs';

const ROOT = join(__dirname, '..');

describe('requestSystemExits', () => {
  it('counts each literal reason, through a wrapper that passes it on', () => {
    const text = `
      function noteSystem(reason: R): null {
        noteRequestSystem(reason);
        return null;
      }
      async function a() { noteRequestSystem('area'); }
      async function b() { noteRequestSystem("login-self"); return noteSystem('admin-write'); }
      // noteRequestSystem('area') in a comment is not an exit
    `;
    expect(requestSystemExits(text)).toEqual({ area: 1, 'login-self': 1, 'admin-write': 1 });
  });

  it('skips the definition and counts a reason it cannot read as unnamed', () => {
    const text = `
      export function noteRequestSystem(why: Why): void { mark(why); }
      const r = pick();
      noteRequestSystem(r);
    `;
    expect(requestSystemExits(text)).toEqual({ unnamed: 1 });
  });
});

describe('scopeHoldsAdminCalls', () => {
  it('counts calls, not the definition or a comment', () => {
    const text = `
      export async function scopeHoldsAdmin(): Promise<boolean> { return x; }
      if (await scopeHoldsAdmin()) go();
      const a = !(await scopeHoldsAdmin ());
      // scopeHoldsAdmin() here is prose
    `;
    expect(scopeHoldsAdminCalls(text)).toBe(2);
  });
});

describe('tsAdminRuleSql', () => {
  it("counts SQL text reading the 'areas' limits or deciding an Admin user", () => {
    expect(tsAdminRuleSql("sql`select coalesce(u.limits -> 'areas' ->> ${area}, '')`")).toBe(1);
    expect(
      tsAdminRuleSql(`sql\`select exists (select 1 from workspaces w
        join workspace_users u on u.workspace_id = w.id and u.login_id = \${loginId}
        join auth.users l on l.id = u.login_id and l.disabled_at is null
        where w.is_admin)\``),
    ).toBe(1);
  });

  it('does not count a list that only shows is_admin', () => {
    expect(
      tsAdminRuleSql(`sql\`select w.id, w.is_admin from workspaces w
        join workspace_users u on u.workspace_id = w.id where u.moderator\``),
    ).toBe(0);
  });
});

describe('workspace table writes', () => {
  it('counts raw and typed writes to the four tables, any quoting', () => {
    const text = `
      sql\`insert into workspace_events (workspace_id) values (\${w})\`;
      sql\`update "public"."workspace_users" set moderator = false\`;
      sql\`delete from workspace_resources where id = \${id}\`;
      sql\`update workspaces set name = \${n}\`;
      await tx.insert(workspaceUsers).values(v);
      sql\`select * from workspace_users for update\`;
      sql\`update workspace_users_archive set x = 1\`;
    `;
    expect(workspaceTableRawWrites(text)).toBe(5);
  });

  it('reads a function body the same way', () => {
    expect(writesWorkspaceTable('INSERT INTO "public"."workspace_events" AS e VALUES (1)')).toBe(
      true,
    );
    expect(writesWorkspaceTable('SELECT 1 FROM "public"."workspaces" FOR UPDATE')).toBe(false);
  });

  it('counts the TypeScript copies of set-the-assistant', () => {
    expect(tsSetAssistantDefs('async function setAssistant(a: A) {}')).toBe(1);
    expect(tsSetAssistantDefs('const setAssistantFor = async (a: A) => {}')).toBe(1);
    expect(tsSetAssistantDefs('await setAssistant(caller, tx, w, null);')).toBe(0);
  });
});

describe('migrationFunctions', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rights-counts-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'packages/db/migrations/meta'), { recursive: true });
  const write = (tag: string, sql: string) =>
    writeFileSync(join(dir, `packages/db/migrations/${tag}.sql`), sql);
  writeFileSync(
    join(dir, 'packages/db/migrations/meta/_journal.json'),
    JSON.stringify({ entries: [{ tag: '0000_a' }, { tag: '0001_b' }] }),
  );
  write(
    '0000_a',
    `CREATE OR REPLACE FUNCTION "public"."f_w"(p uuid, q text DEFAULT null)
       RETURNS void LANGUAGE plpgsql AS $$
     BEGIN INSERT INTO "public"."workspace_events" VALUES (p); END $$;
     --> statement-breakpoint
     -- CREATE FUNCTION commented_out() is not a function
     create function public.g_x() returns int language sql security definer as $f$ select 1 $f$;
     CREATE FUNCTION old_name() RETURNS int LANGUAGE sql AS $$ SELECT 2 $$;
     CREATE FUNCTION gone(a int) RETURNS int LANGUAGE sql AS $$ SELECT a $$;`,
  );
  write(
    '0001_b',
    `ALTER FUNCTION "public"."f_w"(uuid, text) SECURITY DEFINER;
     ALTER FUNCTION old_name() RENAME TO new_name;
     DROP FUNCTION IF EXISTS gone(int);`,
  );

  it('follows create, alter, rename and drop in journal order', () => {
    const fns = migrationFunctions(dir) as { name: string; args: string; definer: boolean }[];
    expect(fns.map((f) => `${f.name}(${f.args}) ${f.definer}`)).toEqual([
      'f_w(uuid,text) true',
      'g_x() true',
      'new_name() false',
    ]);
  });
});

describe('legacyPrecheckUndated', () => {
  it('counts a legacy entry with no owner or no end date', () => {
    expect(
      legacyPrecheckUndated(`
        a: { legacyItemPrecheck: { param: 'id', owner: 'x', until: '2026-12-01' } },
        b: { legacyItemPrecheck: { param: 'id', owner: 'x' } },
        c: { legacyItemPrecheck: { param: 'id' } },
      `),
    ).toBe(2);
  });
});

describe('A8 coverage', () => {
  it('counts write policies and item reads with no matrix declaration', () => {
    const text = `
      a = { slug: 'a_b', policy: { effect: 'write', scope: 'any' } };
      b = { slug: 'b_c', policy: { effect: 'write', matrix: { none: 'no item' } } };
      c = { slug: 'c_d', policy: { effect: 'read', itemArgs: [{ param: 'id' }] } };
      d = { slug: 'd_e', policy: { effect: 'read', scope: 'any' } };
      type P = { effect: 'read' | 'write' };
    `;
    expect(toolPoliciesUncovered(text)).toBe(2);
  });

  it('reads the A8 exemption keys, none when there is no list', () => {
    expect(a8ExemptKeys('const x = 1;')).toBeNull();
    expect(
      a8ExemptKeys(`export const A8_EXEMPT: Record<string, string> = {
        'kind:email': 'admin only, no member right',
        conversation: 'not an item',
      };`),
    ).toEqual(['kind:email', 'conversation']);
  });

  it('finds the registry kinds the grid leaves out', () => {
    const kinds = kindsOutsideGrid(ROOT) as string[];
    expect(kinds.length).toBeGreaterThan(0);
    expect(kinds).not.toContain('page');
    expect(kinds).toContain('email');
  });
});

describe('the repo', () => {
  const texts = (countedFiles(ROOT) as string[]).map((path) => ({
    path,
    text: readRepoFile(ROOT, path) as string,
  }));
  const { numbers } = rightsCounts(ROOT, texts) as { numbers: Record<string, number> };

  it('reads every request system exit reason', () => {
    expect(numbers.requestSystemExits_other).toBe(0);
    expect(numbers.requestSystemExits).toBe(
      numbers.requestSystemExits_area! +
        numbers.requestSystemExits_loginSelf! +
        numbers.requestSystemExits_adminWrite!,
    );
  });

  it('keeps no legacy pre-check without an owner and an end date', () => {
    expect(numbers.legacyPrecheckUndated).toBe(0);
  });
});
