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
// @ts-expect-error: plain-JS module, no types shipped.
import { asSystemExits } from './as-system-exits.mjs';
import {
  legacyPrecheckUndated,
  migrationFunctions,
  readsAreaLimits,
  requestSystemExits,
  rightsCounts,
  scopeHoldsAdminCalls,
  tsAdminRuleSql,
  tsSetAssistantDefs,
  workspaceTableRawWrites,
  workspaceTableRowLocks,
  locksWorkspaceTable,
  writesWorkspaceTable,
  // @ts-expect-error: plain-JS module, no types shipped.
} from './rights-counts.mjs';

const ROOT = join(__dirname, '..');

describe('requestSystemExits', () => {
  const exits = (...texts: string[]) =>
    requestSystemExits(texts.map((text, i) => ({ path: `f${i}.ts`, text }))) as {
      byReason: Record<string, number>;
      problems: string[];
    };

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
    expect(exits(text)).toEqual({
      byReason: { area: 1, 'login-self': 1, 'admin-write': 1 },
      problems: [],
    });
  });

  it('skips the definition and counts a reason it cannot read as unnamed', () => {
    const text = `
      export function noteRequestSystem(why: Why): void { mark(why); }
      const r = pick();
      noteRequestSystem(r);
    `;
    expect(exits(text).byReason).toEqual({ unnamed: 1 });
  });

  it('follows an exported wrapper into the files that call it (arrow, method)', () => {
    const lib = `
      export const noteArea = (ctx: C, why: W) => { noteRequestSystem(why); };
      export function noteOther(why: W) { noteRequestSystem(why); }
    `;
    const user = `
      import { noteArea, noteOther } from './lib';
      noteArea(ctx, 'area');
      noteArea(ctx, 'login-self');
      noteOther('admin-write');
    `;
    const obj = `
      const gate = { leave(why: W) { noteRequestSystem(why); } };
      gate.leave('area');
    `;
    expect(exits(lib, user, obj)).toEqual({
      byReason: { area: 2, 'login-self': 1, 'admin-write': 1 },
      problems: [],
    });
  });

  it('counts a function passing a later parameter on, called or not', () => {
    // The earlier counter skipped any call whose argument matched a
    // wrapper's parameter name anywhere in the file: both of these hid.
    const wrapper = `function noteSystem(reason: R) { noteRequestSystem(reason); }`;
    const uncalled = `
      ${wrapper}
      function f(ctx: C, reason: R) { noteRequestSystem(reason); }
    `;
    expect(exits(uncalled).byReason).toEqual({ unnamed: 2 });
    const called = `
      ${wrapper}
      function f(ctx: C, reason: R) { noteRequestSystem(reason); }
      f(ctx, 'area');
      f(ctx, 'login-self');
      noteSystem('admin-write');
    `;
    expect(exits(called).byReason).toEqual({ area: 1, 'login-self': 1, 'admin-write': 1 });
  });

  it('refuses a wrapper of a wrapper, which would hide its own callers', () => {
    const text = `
      function noteSystem(reason: R) { noteRequestSystem(reason); }
      function outer(why: R) { noteSystem(why); }
      outer('area');
    `;
    expect(exits(text)).toEqual({
      byReason: { unnamed: 1 },
      problems: [
        'f0.ts passes a parameter on to the noteRequestSystem wrapper noteSystem: call it with the reason',
      ],
    });
  });
});

describe('requestSystemExits: member calls and aliases (P1a fix round 2)', () => {
  const exits = (...texts: string[]) =>
    requestSystemExits(texts.map((text, i) => ({ path: `f${i}.ts`, text }))) as {
      byReason: Record<string, number>;
      problems: string[];
    };

  it('counts a member call through a namespace import, optional and subscript', () => {
    const text = `
      import * as db from '@mantle/db';
      db.noteRequestSystem('area');
      db?.noteRequestSystem('login-self');
      db['noteRequestSystem']('admin-write');
    `;
    expect(exits(text)).toEqual({
      byReason: { area: 1, 'login-self': 1, 'admin-write': 1 },
      problems: [],
    });
  });

  it('follows a wrapper made of a member call', () => {
    const text = `
      import * as db from '@mantle/db';
      function noteSystem(reason: R) { db.noteRequestSystem(reason); }
      noteSystem('area');
    `;
    expect(exits(text)).toEqual({ byReason: { area: 1 }, problems: [] });
  });

  it('refuses a renamed import of the call', () => {
    const text = `
      import { noteRequestSystem as n } from '@mantle/db';
      n('area');
    `;
    expect(exits(text).problems).toEqual([
      'f0.ts renames noteRequestSystem (as n): call it by its name',
    ]);
  });

  it('refuses an alias of the call, bare or from a namespace', () => {
    expect(exits(`const n = noteRequestSystem; n('area');`).problems).toEqual([
      'f0.ts renames noteRequestSystem (n =): call it by its name',
    ]);
    expect(
      exits(`import * as db from '@mantle/db'; const n = db.noteRequestSystem; n('area');`)
        .problems,
    ).toEqual(['f0.ts renames noteRequestSystem (n =): call it by its name']);
    expect(
      exits(`import * as db from '@mantle/db'; const { noteRequestSystem: n } = db; n('area');`)
        .problems,
    ).toEqual(['f0.ts renames noteRequestSystem (: n): call it by its name']);
    expect(exits(`let n; n = noteRequestSystem; n('area');`).problems).toEqual([
      'f0.ts renames noteRequestSystem (n =): call it by its name',
    ]);
    expect(exits(`const api = { leave: noteRequestSystem }; api.leave('area');`).problems).toEqual([
      'f0.ts renames noteRequestSystem (leave:): call it by its name',
    ]);
  });

  it('refuses a renamed import or an alias of a followed wrapper', () => {
    const lib = `export function noteOther(why: W) { noteRequestSystem(why); }`;
    const renamedImport = `import { noteOther as o } from './lib'; o('area');`;
    expect(exits(lib, renamedImport).problems).toEqual([
      'f1.ts renames the noteRequestSystem holder noteOther (as o): use its name',
    ]);
    const aliasElsewhere = `import { noteOther } from './lib'; const o = noteOther; o('area');`;
    expect(exits(lib, aliasElsewhere).problems).toEqual([
      'f1.ts renames the noteRequestSystem holder noteOther (o =): use its name',
    ]);
    const aliasHome = `
      function noteSystem(reason: R) { noteRequestSystem(reason); }
      const s = noteSystem;
      s('area');
    `;
    expect(exits(aliasHome).problems).toEqual([
      'f0.ts renames the noteRequestSystem holder noteSystem (s =): use its name',
    ]);
    // The same name in a file that does not import it is another function.
    const other = `function noteOther(x: number) { return x; } const o = noteOther;`;
    expect(exits(lib, other).problems).toEqual([]);
  });

  it('refuses a wrapper whose sites pass different parameters on', () => {
    const text = `
      function f(a: R, b: R, c: boolean) {
        if (c) noteRequestSystem(a);
        else noteRequestSystem(b);
      }
      f('area', 'login-self', true);
    `;
    expect(exits(text).problems).toEqual([
      'f0.ts f passes different parameters on to noteRequestSystem: pass one reason parameter',
    ]);
    const same = `
      function g(a: R, c: boolean) {
        if (c) noteRequestSystem(a);
        else noteRequestSystem(a);
      }
      g('area', true);
    `;
    expect(exits(same).problems).toEqual([]);
  });

  it('counts an asSystem member call as the site regex does', () => {
    const r = asSystemExits([
      {
        path: 'f0.ts',
        text: `import * as m from '@mantle/db'; m.asSystem(() => 1, 'test');`,
      },
    ]) as { byReason: Record<string, number>; problems: string[] };
    expect(r).toMatchObject({ byReason: { test: 1 }, problems: [] });
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
      sql\`UPDATE ONLY workspace_users SET moderator = false\`;
      sql\`delete from only public.workspace_events where id = \${id}\`;
      await tx.insert(workspaceUsers).values(v);
      await db.update(schema.workspaces).set(v);
      await tx.delete( s.workspaceResources ).where(w);
      await tx.insert(workspacesArchive).values(v);
      await tx.insert(schema.workspaceUsersOld).values(v);
      sql\`select * from workspace_users for update\`;
      sql\`update workspace_users_archive set x = 1\`;
    `;
    expect(workspaceTableRawWrites(text)).toBe(9);
    // The FOR UPDATE line is a row lock, not a write.
    expect(workspaceTableRowLocks(text)).toBe(1);
  });

  it('counts row locks on the four tables, anywhere in a statement, raw or typed', () => {
    const text = `
      sql\`select id from workspaces where id = \${w} for update\`;
      sql\`select n.id from nodes n join public.workspaces w on w.id = n.ws for no key update\`;
      sql\`SELECT 1 FROM "workspace_users" u FOR SHARE\`;
      sql\`select 1 from workspace_events e for key share\`;
      await tx.select().from(schema.workspaceResources).where(w).for('update');
      await tx.select().from(nodes).innerJoin(workspaces, eq(a, b)).for('share');
      sql\`select id from nodes where id = \${n} for update\`;
      sql\`select id from workspaces where id = \${w}\`;
      await tx.select().from(nodes).for('update');
      // select id from workspaces for update (a comment)
      sql\`select id from workspaces_archive for update\`;
    `;
    expect(workspaceTableRowLocks(text)).toBe(6);
    expect(
      locksWorkspaceTable(
        'SELECT 1 INTO s FROM nodes n JOIN "public"."workspaces" w ON true FOR UPDATE;',
      ),
    ).toBe(true);
    expect(
      locksWorkspaceTable('SELECT 1 FROM "public"."workspaces"; SELECT 1 FROM nodes FOR UPDATE;'),
    ).toBe(false);
  });

  it('reads a function body the same way', () => {
    expect(writesWorkspaceTable('INSERT INTO "public"."workspace_events" AS e VALUES (1)')).toBe(
      true,
    );
    expect(writesWorkspaceTable('SELECT 1 FROM "public"."workspaces" FOR UPDATE')).toBe(false);
  });

  it("reads the 'areas' limits in every form", () => {
    expect(readsAreaLimits("select u.limits -> 'areas' ->> p_area")).toBe(true);
    expect(readsAreaLimits("select u.limits['areas'][p_area]")).toBe(true);
    expect(readsAreaLimits("select u.limits #>> '{areas,users}'")).toBe(true);
    expect(readsAreaLimits('select u.limits #> \'{"areas"}\'')).toBe(true);
    expect(readsAreaLimits("select u.limits ->> 'areas_seen'")).toBe(false);
    expect(readsAreaLimits("select u.limits #>> '{areasx}'")).toBe(false);
  });

  it("reads the 'areas' limits through extract_path, an array path and E'' (fix round 2)", () => {
    expect(readsAreaLimits("select jsonb_extract_path(u.limits, 'areas')")).toBe(true);
    expect(
      readsAreaLimits("select jsonb_extract_path_text(coalesce(u.limits, '{}'), 'areas', p_area)"),
    ).toBe(true);
    expect(readsAreaLimits("select JSON_EXTRACT_PATH_TEXT(u.limits, E'areas')")).toBe(true);
    expect(readsAreaLimits("select u.limits #>> array['areas', p_area]")).toBe(true);
    expect(readsAreaLimits("select u.limits #> ARRAY[E'areas']")).toBe(true);
    expect(readsAreaLimits("select u.limits -> E'areas' ->> p_area")).toBe(true);
    expect(readsAreaLimits("select u.limits['areas']")).toBe(true);
    expect(readsAreaLimits("select jsonb_extract_path(u.limits, 'areas_seen')")).toBe(false);
    expect(readsAreaLimits("select jsonb_extract_path(u.limits, 'x'), 'areas' as label")).toBe(
      false,
    );
    expect(readsAreaLimits("select array['areas_seen']")).toBe(false);
    // In TypeScript SQL text, the same forms are an Admin area rule.
    expect(
      tsAdminRuleSql(
        "const q = sql`select jsonb_extract_path_text(wu.limits, ${k}, 'areas') from x`;",
      ),
    ).toBe(1);
    expect(tsAdminRuleSql("const q = sql`select wu.limits #>> array['areas', ${a}]`;")).toBe(1);
    expect(tsAdminRuleSql("const q = sql`select wu.limits -> E'areas'`;")).toBe(1);
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

describe('migrationFunctions reads the SQL as Postgres does (sql-text.ts)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rights-counts-lexer-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'packages/db/migrations/meta'), { recursive: true });
  writeFileSync(
    join(dir, 'packages/db/migrations/meta/_journal.json'),
    JSON.stringify({ entries: [{ tag: '0000_a' }] }),
  );
  writeFileSync(
    join(dir, 'packages/db/migrations/0000_a.sql'),
    [
      // A `--` comment a carriage return ends: the function after it is code.
      '-- a note\rCREATE FUNCTION after_cr() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;',
      // Block comments nest: the whole of this one is a comment.
      '/* a /* b */ CREATE FUNCTION in_nested() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$; */',
      // An E string's escaped quote is no end of it: the `--` is inside
      // the string, and the function after it is code.
      "SELECT E'\\' -- '; CREATE FUNCTION after_estring() RETURNS int LANGUAGE sql AS $$ SELECT 3 $$;",
      'CREATE FUNCTION after_string() RETURNS int LANGUAGE sql SECURITY DEFINER AS $$ SELECT 2 $$;',
    ].join('\n'),
  );

  it('finds the functions Postgres makes, and none in a comment', () => {
    const fns = migrationFunctions(dir) as { name: string; definer: boolean }[];
    expect(fns.map((f) => `${f.name} ${f.definer}`)).toEqual([
      'after_cr false',
      'after_estring false',
      'after_string true',
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

describe('the repo', () => {
  const texts = (countedFiles(ROOT) as string[]).map((path) => ({
    path,
    text: readRepoFile(ROOT, path) as string,
  }));
  const { numbers, detail } = rightsCounts(ROOT, texts) as {
    numbers: Record<string, number>;
    detail: { requestSystemExitProblems: string[] };
  };

  it('follows every request system exit (no renamed call or wrapper, no wrapper chain)', () => {
    expect(detail.requestSystemExitProblems).toEqual([]);
  });

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
