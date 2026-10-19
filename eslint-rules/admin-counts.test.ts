/**
 * The Admin counts (admin-counts.mjs) and the SQL readings rights-counts.mjs
 * adds for them: each counter on small inputs, and the repo facts the pins
 * rest on. The pins themselves are checked by `pnpm arch:check`.
 */
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AREA_GATES,
  NOT_LOGIN_KIND,
  adminActRoutes,
  adminCounts,
  adminDecisionFlags,
  areaAsks,
  loginFieldBranches,
  loginShapePin,
  systemWholeTools,
  tsAreaRules,
  // @ts-expect-error: plain-JS module, no types shipped.
} from './admin-counts.mjs';
// @ts-expect-error: plain-JS module, no types shipped.
import { countedFiles, readRepoFile } from './arch-counts.mjs';
import {
  readsAreaLimits,
  readsLoginRole,
  rightsCounts,
  tsAdminSqlKinds,
  // @ts-expect-error: plain-JS module, no types shipped.
} from './rights-counts.mjs';

const ROOT = join(__dirname, '..');

describe('systemWholeTools', () => {
  it('counts an area scope that runs whole, not the flag spread by a reader', () => {
    const t = [
      "const a = { policy: { scope: { area: 'settings', systemWhole: true } } };",
      "const b = { scope: { area: 'keys', systemWhole: true, adminOnly: true } };",
      "const c = { scope: { area: 'keys' } };",
      'const d = { ...(whole ? { systemWhole: true } : {}) };',
      "// scope: { area: 'x', systemWhole: true }",
      "const e = { scope: { area: 'x', systemWhole: false } };",
    ].join('\n');
    expect(systemWholeTools('x.ts', t)).toBe(2);
  });
});

describe('adminActRoutes', () => {
  it("counts the list's entries and each other ADMIN_ACT answer", () => {
    const t = [
      "export const ADMIN_ACT_WRITES = new Set(['POST /api/a', 'DELETE /api/b']);",
      "const ADMIN_ACT = 'admin-act';",
      'function gate(): typeof ADMIN_ACT | null {',
      '  const v = admin && adminActWrite(m, p) ? ADMIN_ACT : check();',
      '  if (v === ADMIN_ACT) return null;',
      '  if (close) return ADMIN_ACT;',
      '  const go = admin ? ADMIN_ACT : null;',
      '  return go;',
      '}',
    ].join('\n');
    expect(adminActRoutes('s.ts', t)).toEqual(['POST /api/a', 'DELETE /api/b', 's.ts:6', 's.ts:7']);
  });
});

describe('loginFieldBranches', () => {
  it('counts a login kind compared either way round and each switch case, not another value', () => {
    const t = [
      "if (login.kind === 'admin') a();",
      "if (res?.kind !== 'member') b();",
      "const x = 'admin' === caller.kind;",
      'switch (login.kind) {',
      "  case 'admin': break;",
      "  case 'member': break;",
      "  case 'other': break;",
      '}',
      "if (node.kind === 'page') c();",
      "// login.kind === 'admin'",
      'const s = "login.kind === \'admin\'";',
    ].join('\n');
    expect(loginFieldBranches('x.ts', t, 'kind')).toEqual([1, 2, 3, 5, 6]);
  });

  it('counts role reads, drizzle eq and ne included, not an agent role', () => {
    const t = [
      "if (row.role !== 'admin') return null;",
      "const m = user?.role === 'member' && x;",
      "db.select().where(eq(authUsers.role, 'admin'));",
      "db.select().where(ne(authUsers.role, 'member'));",
      "db.select().where(eq(agents.role, 'worker'));",
      'switch (role) {',
      "  case 'admin': break;",
      '}',
    ].join('\n');
    expect(loginFieldBranches('x.ts', t, 'role', { drizzle: true })).toEqual([1, 2, 3, 4, 7]);
    expect(loginFieldBranches('x.ts', t, 'role')).toEqual([1, 2, 7]);
  });

  it('reads a field held under another name, and a list of login names asked', () => {
    const t = [
      'const r = row.role;',
      "if (r === 'admin') a();",
      "if (['admin', 'member'].includes(row.role)) b();",
      "const ADMIN = ['admin'];",
      'if (ADMIN.includes(user.role)) c();',
      "const { role: who } = login; if (who !== 'member') d();",
      "if (new Set(['admin']).has(r)) e();",
      'let q; q = row.role; switch (q) {',
      "  case 'admin': break;",
      '}',
      "if (['page'].includes(row.role)) f();",
      "const t2 = row.title; if (t2 === 'admin') g();",
    ].join('\n');
    expect(loginFieldBranches('x.ts', t, 'role')).toEqual([2, 3, 5, 6, 7, 9]);
  });

  it("reads the field by a literal key (login['role']) as by the dot", () => {
    const t = [
      "if (login['role'] === 'admin') a();",
      "if ('member' !== row?.['kind']) b();",
      "const r = login['role']; if (r === 'member') c();",
      "db.select().where(eq(authUsers['role'], 'admin'));",
      "if (login['title'] === 'admin') d();",
      "if (login[role] === 'admin') e();",
    ].join('\n');
    expect(loginFieldBranches('x.ts', t, 'role', { drizzle: true })).toEqual([1, 3, 4]);
    expect(loginFieldBranches('x.ts', t, 'kind')).toEqual([2]);
  });

  it('names the files whose kind is not a login kind', () => {
    expect(Object.keys(NOT_LOGIN_KIND).sort()).toEqual([
      'packages/runtime/src/heartbeats/fire.ts',
      'packages/std/src/access-error.ts',
      'server/web/lib/workspace-look.ts',
    ]);
    const n = adminCounts(ROOT, [
      {
        path: 'packages/std/src/access-error.ts',
        text: "switch (e.kind) { case 'admin': break; }",
      },
      { path: 'packages/x/src/y.ts', text: "switch (e.kind) { case 'admin': break; }" },
    ]).numbers as Record<string, number>;
    expect(n.loginKindBranches).toBe(1);
  });
});

describe('adminDecisionFlags', () => {
  it('counts each isAdmin identifier, never a comment or a string', () => {
    const t = "const isAdmin = a.isAdmin;\n// isAdmin\nconst s = 'isAdmin';\nf({ isAdmin });";
    expect(adminDecisionFlags('x.ts', t)).toBe(3);
  });
});

describe('tsAreaRules', () => {
  it('finds the limits reader, the whole-list answer and the area ask built on them', () => {
    const t = [
      'function areasOf(info, caller) {',
      "  if (!info.migrated) return caller.kind === 'admin' ? [...WORKSPACE_AREAS] : [];",
      '  return areasFromLimits(info.limits);',
      '}',
      'export function areasFromLimits(limits) {',
      '  const off = limits.areas ?? {};',
      '  return WORKSPACE_AREAS.filter((a) => off[a] !== false);',
      '}',
      'export async function areasFor(caller) { return areasOf(await info(caller), caller); }',
      'export async function requireArea(caller, area) {',
      '  return (await areasFor(caller)).includes(area);',
      '}',
      'export function isArea(v) { return WORKSPACE_AREAS.includes(v); }',
      "async function list(caller) { return (await areasFor(caller)).includes('users'); }",
    ].join('\n');
    expect(tsAreaRules('w.ts', t)).toEqual(['areasFromLimits', 'areasOf', 'requireArea']);
  });

  it('a requireArea that asks SQL is no rule', () => {
    const t = [
      'export async function requireArea(caller, area) {',
      '  const [r] = await db.execute(sql`select mantle_scope_has_area(${area}) as a`);',
      '  return r.a === true;',
      '}',
    ].join('\n');
    expect(tsAreaRules('w.ts', t)).toEqual([]);
  });
});

describe('areaAsks', () => {
  it('counts calls and callbacks of the four asks, bare or a member, not imports or types', () => {
    const t = [
      "import { loginHasArea, scopeHasArea } from '@mantle/db';",
      "if (await scopeHasArea('users')) a();",
      "const ok = await db.loginHasArea(id, 'keys');",
      'const asks = [requireArea];',
      'type F = typeof loginHoldsAdmin;',
      'export async function loginHoldsAdmin(id: string) { return false; }',
      '// scopeHasArea(x)',
    ].join('\n');
    expect(areaAsks('x.ts', t)).toEqual([
      { name: 'scopeHasArea', line: 2 },
      { name: 'loginHasArea', line: 3 },
      { name: 'requireArea', line: 4 },
    ]);
  });

  it('leaves out the gates', () => {
    const text = "if (await scopeHasArea('users')) a();";
    const n = adminCounts(ROOT, [
      ...(AREA_GATES as string[]).map((path) => ({ path, text })),
      { path: 'packages/x/src/y.ts', text },
    ]).numbers as Record<string, number>;
    expect([n.inHandlerAreaChecks, n.inHandlerAreaCheckFiles]).toEqual([1, 1]);
  });

  it('follows a thin wrapper to its uses, in its file and where it is imported', () => {
    const inline = [
      "if (await requireArea(c, 'keys')) a();",
      "if (await requireArea(c, 'keys')) b();",
    ].join('\n');
    const wrapped = [
      "async function holds(c) { return requireArea(c, 'keys'); }",
      'if (await holds(c)) a();',
      'if (await holds(c)) b();',
    ].join('\n');
    const count = (texts: { path: string; text: string }[]) =>
      (adminCounts(ROOT, texts).numbers as Record<string, number>).inHandlerAreaChecks;
    expect(count([{ path: 'packages/x/src/a.ts', text: inline }])).toBe(2);
    expect(count([{ path: 'packages/x/src/a.ts', text: wrapped }])).toBe(2);
    // An exported one, and a wrapper of it, used in another file.
    const lib = [
      "export const canUsers = () => scopeHasArea('users');",
      'export async function canUsers2() { return !(await canUsers()); }',
    ].join('\n');
    const user = [
      "import { canUsers, canUsers2 } from './lib';",
      'if (await canUsers()) a();',
      'if (await canUsers2()) b();',
      'if (await canUsers2()) c();',
    ].join('\n');
    expect(
      count([
        { path: 'packages/x/src/lib.ts', text: lib },
        { path: 'packages/x/src/use.ts', text: user },
      ]),
    ).toBe(3);
    // A function that does more than ask asks where it is.
    const more = "async function check(c) { log(c); return requireArea(c, 'keys'); }\ncheck(c);";
    expect(count([{ path: 'packages/x/src/a.ts', text: more }])).toBe(1);
  });

  it('an ask held under another name is a problem', () => {
    for (const line of [
      'const ask = scopeHasArea;',
      'const ask = db.loginHasArea;',
      'let ask; ask = requireArea;',
      'const api = { ask: loginHoldsAdmin };',
      'const api = { scopeHasArea };',
      'const ask = scopeHasArea.bind(null);',
      "loginHasArea.call(null, id, 'keys');",
    ]) {
      const r = adminCounts(ROOT, [{ path: 'packages/x/src/a.ts', text: line }]) as {
        problems: string[];
      };
      expect(r.problems.length, line).toBe(1);
      expect(r.problems[0]).toMatch(/held under another name/);
    }
    const ok = adminCounts(ROOT, [
      { path: 'packages/x/src/a.ts', text: "if (await scopeHasArea('users')) a();" },
    ]) as { problems: string[] };
    expect(ok.problems).toEqual([]);
  });

  it('an ask used as anything but a call or a callback is a problem, each place once', () => {
    const run = (text: string) =>
      adminCounts(ROOT, [{ path: 'packages/x/src/a.ts', text }]) as {
        numbers: Record<string, number>;
        problems: string[];
      };
    for (const text of [
      'const f = cond ? scopeHasArea : other;\nf(x);',
      'const f = mine ?? loginHasArea;',
      'const asks = [requireArea, other];',
      'export default loginHoldsAdmin;',
      'const n = scopeHasArea.length;',
      "run(cond ? db['scopeHasArea'] : other);",
    ]) {
      const r = run(text);
      expect(r.problems.length, text).toBe(1);
      expect(r.problems[0], text).toMatch(/is used as/);
    }
    // A held ask is named once, not again as a value.
    expect(run('const ask = scopeHasArea.bind(null);').problems).toHaveLength(1);
    // A call and a callback are uses, not problems.
    const ok = run("await scopeHasArea('a');\nlist.filter(loginHasArea);");
    expect(ok.problems).toEqual([]);
    expect(ok.numbers.inHandlerAreaChecks).toBe(2);
  });

  it("counts an ask by a literal key (s['scopeHasArea']) as by the dot", () => {
    const run = (text: string) =>
      adminCounts(ROOT, [{ path: 'packages/x/src/a.ts', text }]) as {
        numbers: Record<string, number>;
        problems: string[];
      };
    const r = run("if (await s['scopeHasArea']('users')) a();\nawait db.loginHasArea(id, 'keys');");
    expect(r.numbers.inHandlerAreaChecks).toBe(2);
    expect(r.problems).toEqual([]);
    const held = run("const ask = s['requireArea'];");
    expect(held.problems).toHaveLength(1);
    expect(held.problems[0]).toMatch(/requireArea is held under another name/);
  });

  it('an ask renamed is a problem: a renamed import, a renaming destructure', () => {
    const run = (text: string) =>
      adminCounts(ROOT, [{ path: 'packages/x/src/a.ts', text }]) as {
        numbers: Record<string, number>;
        problems: string[];
      };
    for (const [text, problem] of [
      [
        "import { scopeHasArea as can } from './session';\nif (await can('users')) a();",
        'packages/x/src/a.ts:1: scopeHasArea is renamed (can)',
      ],
      [
        "const { loginHasArea: can } = gate;\nif (await can(id, 'keys')) a();",
        'packages/x/src/a.ts:1: loginHasArea is renamed (can)',
      ],
      [
        "export { requireArea as need } from './workspaces';",
        'packages/x/src/a.ts:1: requireArea is renamed (need)',
      ],
    ]) {
      const r = run(text);
      expect(r.problems.length, text).toBe(1);
      expect(r.problems[0], text).toContain(problem);
      // The rename is no ask; its calls are what the problem names.
      expect(r.numbers.inHandlerAreaChecks, text).toBe(0);
    }
    // The ask under its own name is none.
    const own0 = run("import { scopeHasArea } from './session';\nscopeHasArea('a');");
    expect(own0.problems).toEqual([]);
    const own = run(
      "import { scopeHasArea } from './session';\nconst { loginHasArea } = gate;\nscopeHasArea('a');\nloginHasArea(id, 'b');",
    );
    expect(own.problems).toEqual([]);
    expect(own.numbers.inHandlerAreaChecks).toBe(2);
  });
});

describe('the login type pin', () => {
  it('is read from the type test: kind and role today', () => {
    expect(loginShapePin(ROOT)).toBe(2);
  });

  it('is not readable once a line that holds it to the type changes', () => {
    const text = readRepoFile(ROOT, 'server/web/lib/auth/login-shape.test.ts') as string;
    expect(loginShapePin(ROOT, text)).toBe(2);
    for (const [from, to] of [
      ["{ kind: Has<'kind'>; role: Has<'role'> }", '{ kind: boolean; role: boolean }'],
      ["{ kind: Has<'kind'>; role: Has<'role'> }", "{ kind: Has<'kind'>; role: false }"],
      ['type Login = Exclude<', 'type Login0 = Exclude<'],
      ['K extends ShapeKeys<Login> ? true : false', 'K extends never ? true : false'],
      ["Exclude<keyof L, 'actor'>]: L[K]", "Exclude<keyof L, 'actor' | 'user'>]: L[K]"],
      ["from './session'", "from './other'"],
    ]) {
      expect(text.includes(from), from).toBe(true);
      expect(loginShapePin(ROOT, text.replace(from, to)), to).toBe(-1);
    }
  });
});

describe('the SQL readings', () => {
  it("reads the 'areas' limits in the quoted and path forms too", () => {
    for (const t of [
      "limits ? 'areas'",
      "limits ?| array['areas']",
      `limits @> '{"areas": {"x": false}}'`,
      `limits <@ E'{"areas": {}}'`,
      "jsonb_path_exists(limits, '$.areas.users')",
      `jsonb_path_query(limits, 'strict $."areas".x')`,
      "limits -> ('areas') ->> a",
      'limits -> $$areas$$ ->> a',
      'limits ->> $k$areas$k$',
      "limits @> jsonb_build_object('areas', jsonb_build_object(a, false))",
      'limits #> $${areas,x}$$',
    ]) {
      expect(readsAreaLimits(t), t).toBe(true);
    }
    for (const t of [
      "x ->> 'areasx'",
      's."areas"',
      "select 'areas' as label",
      "jsonb_build_object('a', 'b')",
    ]) {
      expect(readsAreaLimits(t), t).toBe(false);
    }
  });

  it('tells a membership ask from an Admin user rule', () => {
    const rule =
      'const a = sql`select exists (select 1 from workspaces w join workspace_users u on u.workspace_id = w.id and u.login_id = ${id}::uuid join auth.users l on l.id = u.login_id and l.disabled_at is null where w.is_admin) as a`;';
    const membership = [
      'const b = sql`with admin_ws as (select w.id from workspaces w where w.is_admin limit 1)',
      '  select exists (select 1 from workspaces w',
      '    join workspace_users u on u.workspace_id = w.id and u.login_id = ${id}::uuid',
      '    join auth.users l on l.id = u.login_id and l.disabled_at is null',
      '   where w.id = coalesce(a.workspace_id, (select id from admin_ws))) as m`;',
    ].join('\n');
    const area = "const c = sql`select coalesce(u.limits -> 'areas' ->> ${a}, '') <> 'false'`;";
    const list = 'const d = sql`select w.id, w.is_admin from workspaces w`;';
    expect(tsAdminSqlKinds([rule, membership, area, list].join('\n'))).toEqual({
      rules: 2,
      membership: 1,
    });
  });

  it('reads on past a template literal nested in a ${} part', () => {
    // The nested literal's `{` and `}` are its text, not the part's braces;
    // the ask after it is still one SQL text.
    const nested =
      "const a = sql`select 1 from t where id = any(${`{${ids.join(',')}}`}::uuid[]) and ${f({ k: '}' })}`;";
    const membership =
      'const b = sql`select 1 from workspace_users u join auth.users l on l.id = u.login_id and l.disabled_at is null where u.login_id = ${id}`;';
    expect(tsAdminSqlKinds([nested, membership].join('\n'))).toEqual({
      rules: 0,
      membership: 1,
    });
    // The ask itself holding a nested literal is read whole.
    const inside =
      'const c = sql`select 1 from workspace_users u join auth.users l on l.id = u.login_id and l.disabled_at is null where u.workspace_id = any(${`{${ws}}`}::uuid[]) and u.login_id = ${id}`;';
    expect(tsAdminSqlKinds(inside)).toEqual({ rules: 0, membership: 1 });
  });

  it('reads auth.users.role through an alias, in any quoting', () => {
    expect(readsLoginRole(`select u.role from auth.users u where u.id = login`)).toBe(true);
    expect(readsLoginRole(`select l."role" from "auth"."users" as l`)).toBe(true);
    expect(readsLoginRole(`select users.role from auth.users`)).toBe(true);
    expect(
      readsLoginRole(`select a.role from agents a join auth.users u on u.id = a.owner_id`),
    ).toBe(false);
    expect(readsLoginRole(`select current_setting('role')`)).toBe(false);
  });
});

describe('the repo', () => {
  const texts = (countedFiles(ROOT) as string[]).map((path) => ({
    path,
    text: readRepoFile(ROOT, path) as string,
  }));
  const { numbers, detail } = rightsCounts(ROOT, texts) as {
    numbers: Record<string, number>;
    detail: {
      loginRoleDecisionReads: Record<string, number[]>;
      tsAreaRules: Record<string, string[]>;
      sqlRoleReaderFns: string[];
      asSystemRouteProblems: string[];
      adminActRoutes: string[];
    };
  };

  it('names the three role reads the plan moves in S8c', () => {
    const reads = detail.loginRoleDecisionReads;
    expect(reads['server/web/lib/mcp-auth.ts']).toEqual(expect.arrayContaining([263, 273]));
    expect(reads['server/web/lib/pair-code.ts']).toEqual(expect.arrayContaining([131]));
  });

  it('finds no TypeScript area rule: SQL decides (plan v3.2: areasOf, areasFromLimits and requireArea`s list rule went)', () => {
    expect(detail.tsAreaRules).toEqual({});
  });

  it('classes the two Telegram asks as membership, not area rules', () => {
    const tg = texts.find((t) => t.path === 'packages/telegram/src/chat-login.ts')!;
    expect(tsAdminSqlKinds(tg.text)).toEqual({ rules: 0, membership: 2 });
  });

  it('reads the role column in the functions S8b must pin', () => {
    expect(detail.sqlRoleReaderFns).toEqual(
      expect.arrayContaining([
        'mantle_login_is_admin_user',
        'mantle_member_space',
        'mantle_ws_dry_run',
        'mantle_ws_reach_diff',
        'mantle_ws_review_off',
        'mantle_ws_spaces_fold',
      ]),
    );
  });

  it('routes every asSystem reason, all full, and the systemWhole tools ride admin-area', () => {
    expect(detail.asSystemRouteProblems).toEqual([]);
    expect(numbers.asSystemNarrow).toBe(0);
    expect(numbers.asSystemFull).toBeGreaterThan(0);
    expect(numbers.systemWholeOnFull).toBe(numbers.systemWholeTools);
  });

  it('counts no Admin act: the item gate three went (S6 c2), ADMIN_ACT_WRITES (S6 c3)', () => {
    // The item gate's ADMIN_ACT answers became definers (migration 0310);
    // the four listed acts run in the login's scope (S6 c3).
    expect(detail.adminActRoutes.filter((a) => a.startsWith('server/'))).toHaveLength(0);
    expect(numbers.adminActRoutes).toBe(0);
  });
});
