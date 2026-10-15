/**
 * The role, area and actor names (arch plan A10 #13), RECORDED as every
 * copy stood on main v0.300.47, before each was read from one source.
 *
 * Record, move, compare: this first commit proves RECORDED against the
 * literals in the source files (onMain), and that every copy of a concept
 * already held its source's values. A list the code only asks membership of
 * is compared as a set; a list whose order means something is compared in
 * order (ORDERED).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const ROOT = new URL('../../../', import.meta.url);

/** Every concept: its source (file, then the list) and each copy on main. */
export const RECORDED = {
  loginRole: {
    // packages/db/src/schema/auth-users.ts LOGIN_ROLES (and the role CHECK
    // users_role_ck, migration 0272).
    source: ['admin', 'member'],
    copies: {
      'packages/client-types/src/dto/logins.ts LoginKind': ['admin', 'member'],
      'packages/client-types/src/dto/shell.ts ShellRole': ['admin', 'member'],
      'packages/client-types/src/dto/access-keys.ts AccessKeyRole': ['admin', 'member'],
      'packages/client-types/src/dto/workspaces.ts AuthWhoami.role': ['admin', 'member'],
      'packages/content/src/contacts.ts loginEmails inArray': ['admin', 'member'],
      'packages/content/src/mcp-app-data.ts McpDataRole': ['admin', 'member'],
      'packages/mcp-core/src/login-surface.ts McpLoginRole': ['admin', 'member'],
      'packages/tools/src/types.ts LoginMcpChannel.role': ['admin', 'member'],
      'packages/runtime/src/assistant/run-team-turn.ts hasUnknownRole': ['admin', 'member'],
      'packages/db/src/test-support.ts setLoginRoleUnguarded': ['admin', 'member'],
      'server/web/app/api/auth/token/refresh/route.ts BEARER_ROLES': ['admin', 'member'],
      'server/web/app/api/users/route.ts CreateBody.role': ['admin', 'member'],
      'server/web/app/api/users/[id]/route.ts PatchBody.role': ['admin', 'member'],
      'server/web/app/api/users/[id]/password/route.ts named roles': ['admin', 'member'],
      'server/web/app/api/oauth/authorize/route.ts Consenter.role': ['admin', 'member'],
      'server/web/lib/access-keys.ts AccessKeyRole': ['admin', 'member'],
      'server/web/lib/access-keys.ts isRole': ['admin', 'member'],
      'server/web/lib/mcp-auth.ts isRole': ['admin', 'member'],
      'server/web/lib/auth/session.ts HttpLogin.role': ['admin', 'member'],
      'server/web/lib/auth/session.ts ChatLogin.kind': ['admin', 'member'],
      'server/web/lib/auth/session.ts getCookieUpgradeLoginOr401 role': ['admin', 'member'],
      'server/web/lib/auth/session.ts passwordRole': ['admin', 'member'],
      'server/web/lib/login-update.ts LoginChange.role': ['admin', 'member'],
      'server/web/lib/login-update.ts role-fixed refusal': ['admin', 'member'],
      'server/web/lib/workspaces.ts WsCaller.kind': ['admin', 'member'],
      'server/web/lib/workspaces.ts adminRoleChange role': ['admin', 'member'],
      'server/web/server/a4-guard-sweep.keys.ts row role': ['admin', 'member'],
      'server/web/server/a4-guard-sweep.keys.ts grant role': ['admin', 'member'],
    },
  },
  workspaceArea: {
    // packages/client-types/src/dto/workspaces.ts WORKSPACE_AREAS.
    source: ['settings', 'users', 'assistants', 'connectors', 'keys'],
    copies: {
      'packages/client-types/src/dto/workspaces.ts WorkspaceArea': [
        'settings',
        'users',
        'assistants',
        'connectors',
        'keys',
      ],
      'packages/db/src/admin-user.ts Area': [
        'settings',
        'users',
        'assistants',
        'connectors',
        'keys',
      ],
      'packages/db/src/viewer.ts SCOPE_AREAS': [
        'settings',
        'users',
        'assistants',
        'connectors',
        'keys',
      ],
      'server/web/lib/auth/route-scope.ts AREAS': [
        'settings',
        'users',
        'assistants',
        'connectors',
        'keys',
      ],
    },
  },
  historyActor: {
    // No source on main: three equal unions and the column's comment.
    source: ['owner', 'agent', 'mcp', 'system', 'member'],
    copies: {
      'packages/client-types/src/dto/rows.ts AppSnapshot.actor': [
        'owner',
        'agent',
        'mcp',
        'system',
        'member',
      ],
      'packages/client-types/src/dto/rows.ts TableSnapshot.actor': [
        'owner',
        'agent',
        'mcp',
        'system',
        'member',
      ],
      'packages/content/src/apps.ts AppHistoryActor': ['owner', 'agent', 'mcp', 'system', 'member'],
      'packages/db/src/schema/node-snapshots.ts actor comment': [
        'owner',
        'agent',
        'mcp',
        'system',
        'member',
      ],
    },
  },
  recallActor: {
    // packages/db/src/schema/recall.ts RECALL_ACTOR_KINDS (and the CHECK
    // recall_revisions_actor_kind_ck, migration 0203).
    source: ['owner', 'agent'],
    copies: {
      'packages/client-types/src/types/recall.ts RecallActorKind': ['owner', 'agent'],
      'packages/content/src/recall-native.ts RecallActor.kind': ['owner', 'agent'],
      'packages/content/src/recall-native.ts listRevisions actorKind': ['owner', 'agent'],
      'packages/content/src/recall-native.ts listRevisions cast': ['owner', 'agent'],
    },
  },
  accessLevel: {
    // packages/client-types/src/dto/access.ts ACCESS_LEVELS, highest first.
    source: ['admin', 'team', 'client', 'public'],
    copies: {
      // Lowest first, on purpose (levelCovers reads it so): asked for
      // membership only.
      'packages/db/src/viewer.ts VIEWER_LEVELS': ['public', 'client', 'team', 'admin'],
    },
  },
  keyArea: {
    // packages/client-types/src/dto/access-keys.ts ACCESS_KEY_AREAS.
    source: [
      'search',
      'pages',
      'notes',
      'tasks',
      'tables',
      'files',
      'calendar',
      'contacts',
      'journal',
      'apps',
      'app_data',
    ],
    copies: {
      'packages/mcp-core/src/key-scope.ts KEY_AREAS': [
        'search',
        'pages',
        'notes',
        'tasks',
        'tables',
        'files',
        'calendar',
        'contacts',
        'journal',
        'apps',
        'app_data',
      ],
    },
  },
} as const;

/** The copies whose order the code reads (iterates or shows), compared in
 *  order with their source. Every other copy is asked for membership. */
export const ORDERED: ReadonlySet<string> = new Set([
  'packages/db/src/viewer.ts SCOPE_AREAS',
  'packages/mcp-core/src/key-scope.ts KEY_AREAS',
]);

function source(path: string): string {
  return readFileSync(new URL(path, ROOT), 'utf8');
}

/** The index of the `nth` (0-based) `marker` in `text`; throws when absent. */
function at(text: string, marker: string, nth = 0): number {
  let i = -1;
  for (let k = 0; k <= nth; k += 1) {
    i = text.indexOf(marker, i + 1);
    if (i < 0) throw new Error(`marker not found: ${marker} (${nth})`);
  }
  return i + marker.length;
}

/** The string literal union starting right after the marker. */
function union(text: string, marker: string, nth = 0): string[] {
  const rest = text.slice(at(text, marker, nth));
  const m = /^\s*((?:'[^']+'\s*\|\s*)*'[^']+')/.exec(rest);
  if (!m) throw new Error(`no union after: ${marker}`);
  return [...m[1]!.matchAll(/'([^']+)'/g)].map((x) => x[1]!);
}

/** The string entries of the bracket list starting at the marker's end
 *  (the marker ends with its `[`). */
function list(text: string, marker: string): string[] {
  const from = at(text, marker) - 1;
  const end = text.indexOf(']', from);
  return [...text.slice(from, end).matchAll(/'([^']+)'/g)].map((x) => x[1]!);
}

/** The values a comparison chain on the marker's line names (a `typeof`
 *  test is not one of them). */
function chain(text: string, marker: string): string[] {
  const i = at(text, marker);
  const line = text.slice(text.lastIndexOf('\n', i) + 1, text.indexOf('\n', i));
  return [...line.matchAll(/(typeof\s+)?[\w.]+\s*[!=]==\s*'([^']+)'/g)]
    .filter((x) => !x[1])
    .map((x) => x[2]!);
}

/** The values a comparison chain on one subject names, from the marker on
 *  (across lines). */
function chainFrom(text: string, marker: string, subject: string): string[] {
  const rest = text.slice(at(text, marker));
  const esc = subject.replace(/[.$]/g, '\\$&');
  const m = new RegExp(`^(?:\\s*(?:&&|\\|\\|)?\\s*${esc}\\s*[!=]==\\s*'[^']+')+`).exec(rest);
  if (!m) throw new Error(`no chain after: ${marker}`);
  return [...m[0].matchAll(/'([^']+)'/g)].map((x) => x[1]!);
}

function onMain() {
  const auth = source('packages/db/src/schema/auth-users.ts');
  const session = source('server/web/lib/auth/session.ts');
  const workspaces = source('server/web/lib/workspaces.ts');
  const keys = source('server/web/lib/access-keys.ts');
  const sweep = source('server/web/server/a4-guard-sweep.keys.ts');
  const wsDto = source('packages/client-types/src/dto/workspaces.ts');
  const rows = source('packages/client-types/src/dto/rows.ts');
  const recall = source('packages/content/src/recall-native.ts');
  return {
    loginRole: {
      source: list(auth, 'export const LOGIN_ROLES = ['),
      copies: {
        'packages/client-types/src/dto/logins.ts LoginKind': union(
          source('packages/client-types/src/dto/logins.ts'),
          'export type LoginKind =',
        ),
        'packages/client-types/src/dto/shell.ts ShellRole': union(
          source('packages/client-types/src/dto/shell.ts'),
          'export type ShellRole =',
        ),
        'packages/client-types/src/dto/access-keys.ts AccessKeyRole': union(
          source('packages/client-types/src/dto/access-keys.ts'),
          'export type AccessKeyRole =',
        ),
        'packages/client-types/src/dto/workspaces.ts AuthWhoami.role': union(
          wsDto,
          'export type AuthWhoami = {\n  role:',
        ),
        'packages/content/src/contacts.ts loginEmails inArray': list(
          source('packages/content/src/contacts.ts'),
          'inArray(authUsers.role, [',
        ),
        'packages/content/src/mcp-app-data.ts McpDataRole': union(
          source('packages/content/src/mcp-app-data.ts'),
          'export type McpDataRole =',
        ),
        'packages/mcp-core/src/login-surface.ts McpLoginRole': union(
          source('packages/mcp-core/src/login-surface.ts'),
          'export type McpLoginRole =',
        ),
        'packages/tools/src/types.ts LoginMcpChannel.role': union(
          source('packages/tools/src/types.ts'),
          'Absent = member. */\n  role?:',
        ),
        'packages/runtime/src/assistant/run-team-turn.ts hasUnknownRole': chain(
          source('packages/runtime/src/assistant/run-team-turn.ts'),
          "return typeof role === 'string' &&",
        ),
        'packages/db/src/test-support.ts setLoginRoleUnguarded': union(
          source('packages/db/src/test-support.ts'),
          '  loginId: string,\n  role:',
        ),
        'server/web/app/api/auth/token/refresh/route.ts BEARER_ROLES': list(
          source('server/web/app/api/auth/token/refresh/route.ts'),
          'const BEARER_ROLES: ReadonlySet<string> = new Set([',
        ),
        'server/web/app/api/users/route.ts CreateBody.role': list(
          source('server/web/app/api/users/route.ts'),
          'role: z.enum([',
        ),
        'server/web/app/api/users/[id]/route.ts PatchBody.role': list(
          source('server/web/app/api/users/[id]/route.ts'),
          'role: z.enum([',
        ),
        'server/web/app/api/users/[id]/password/route.ts named roles': chain(
          source('server/web/app/api/users/[id]/password/route.ts'),
          "if (target.role !== 'admin'",
        ),
        'server/web/app/api/oauth/authorize/route.ts Consenter.role': union(
          source('server/web/app/api/oauth/authorize/route.ts'),
          '  email: string;\n  role:',
        ),
        'server/web/lib/access-keys.ts AccessKeyRole': union(keys, 'export type AccessKeyRole ='),
        'server/web/lib/access-keys.ts isRole': chain(keys, 'v is AccessKeyRole {\n  return'),
        'server/web/lib/mcp-auth.ts isRole': chain(
          source('server/web/lib/mcp-auth.ts'),
          'v is McpLoginRole {\n  return',
        ),
        'server/web/lib/auth/session.ts HttpLogin.role': union(
          session,
          'loginId: string | null;\n  role:',
        ),
        'server/web/lib/auth/session.ts ChatLogin.kind': union(
          session,
          'export type ChatLogin = {\n  kind:',
        ),
        'server/web/lib/auth/session.ts getCookieUpgradeLoginOr401 role': union(
          session,
          '{ loginId: string; email: string; role:',
        ),
        'server/web/lib/auth/session.ts passwordRole': chain(session, 'const passwordRole ='),
        'server/web/lib/login-update.ts LoginChange.role': union(
          source('server/web/lib/login-update.ts'),
          'on the anchor or yourself. */\n  role?:',
        ),
        'server/web/lib/login-update.ts role-fixed refusal': chainFrom(
          source('server/web/lib/login-update.ts'),
          'change.role !== target.role &&',
          'target.role',
        ),
        'server/web/lib/workspaces.ts WsCaller.kind': union(
          workspaces,
          'export type WsCaller = {\n  kind:',
        ),
        'server/web/lib/workspaces.ts adminRoleChange role': union(
          workspaces,
          '  loginId: string,\n  role:',
        ),
        'server/web/server/a4-guard-sweep.keys.ts row role': union(
          sweep,
          'const row = (id: string, role:',
        ),
        'server/web/server/a4-guard-sweep.keys.ts grant role': union(
          sweep,
          '  loginId: string,\n  role:',
        ),
      },
    },
    workspaceArea: {
      source: list(wsDto, 'export const WORKSPACE_AREAS: readonly WorkspaceArea[] = ['),
      copies: {
        'packages/client-types/src/dto/workspaces.ts WorkspaceArea': union(
          wsDto,
          'export type WorkspaceArea =',
        ),
        'packages/db/src/admin-user.ts Area': union(
          source('packages/db/src/admin-user.ts'),
          'type Area =',
        ),
        'packages/db/src/viewer.ts SCOPE_AREAS': list(
          source('packages/db/src/viewer.ts'),
          'export const SCOPE_AREAS = [',
        ),
        'server/web/lib/auth/route-scope.ts AREAS': list(
          source('server/web/lib/auth/route-scope.ts'),
          'const AREAS: ReadonlySet<string> = new Set([',
        ),
      },
    },
    historyActor: {
      source: union(rows, '  note: string | null;\n  actor:'),
      copies: {
        'packages/client-types/src/dto/rows.ts AppSnapshot.actor': union(
          rows,
          '  note: string | null;\n  actor:',
        ),
        'packages/client-types/src/dto/rows.ts TableSnapshot.actor': union(
          rows,
          '  note: string | null;\n  actor:',
          1,
        ),
        'packages/content/src/apps.ts AppHistoryActor': union(
          source('packages/content/src/apps.ts'),
          'export type AppHistoryActor =',
        ),
        'packages/db/src/schema/node-snapshots.ts actor comment': union(
          source('packages/db/src/schema/node-snapshots.ts'),
          "    note: text('note'),\n    /**",
        ),
      },
    },
    recallActor: {
      source: list(
        source('packages/db/src/schema/recall.ts'),
        'export const RECALL_ACTOR_KINDS = [',
      ),
      copies: {
        'packages/client-types/src/types/recall.ts RecallActorKind': union(
          source('packages/client-types/src/types/recall.ts'),
          'export type RecallActorKind =',
        ),
        'packages/content/src/recall-native.ts RecallActor.kind': union(
          recall,
          'export type RecallActor = {\n  kind:',
        ),
        'packages/content/src/recall-native.ts listRevisions actorKind': union(
          recall,
          '    cardSlug: string | null;\n    actorKind:',
        ),
        'packages/content/src/recall-native.ts listRevisions cast': union(
          recall,
          'actorKind: r.actorKind as',
        ),
      },
    },
    accessLevel: {
      source: list(
        source('packages/client-types/src/dto/access.ts'),
        'export const ACCESS_LEVELS = [',
      ),
      copies: {
        'packages/db/src/viewer.ts VIEWER_LEVELS': list(
          source('packages/db/src/viewer.ts'),
          'export const VIEWER_LEVELS = [',
        ),
      },
    },
    keyArea: {
      source: list(
        source('packages/client-types/src/dto/access-keys.ts'),
        'export const ACCESS_KEY_AREAS = [',
      ),
      copies: {
        'packages/mcp-core/src/key-scope.ts KEY_AREAS': list(
          source('packages/mcp-core/src/key-scope.ts'),
          'export const KEY_AREAS = [',
        ),
      },
    },
  };
}

/** Each copy that differs from its source (as a set, or in order for
 *  ORDERED): none on main. */
function differences(): string[] {
  const out: string[] = [];
  for (const [concept, { source: src, copies }] of Object.entries(RECORDED)) {
    for (const [site, values] of Object.entries(copies)) {
      const a: readonly string[] = values;
      const b: readonly string[] = src;
      const same = ORDERED.has(site)
        ? a.join() === b.join()
        : a.length === b.length && a.every((v) => b.includes(v));
      if (!same) out.push(`${concept}: ${site} = ${a.join('|')}, source = ${b.join('|')}`);
    }
  }
  return out;
}

describe('the role, area and actor names, recorded on main v0.300.47', () => {
  it('RECORDED is every copy as main writes it', () => {
    expect(onMain()).toEqual(RECORDED);
  });

  it('every copy on main already held its source values', () => {
    expect(differences()).toEqual([]);
  });

  it('the role and recall actor CHECKs admit the recorded values', () => {
    const roleCk = source('packages/db/migrations/0272_workspaces_logins_carry_nothing.sql');
    expect(roleCk).toContain(`CHECK ("role" IN ('admin', 'member')`);
    const actorCk = source('packages/db/migrations/0203_recall_v2_schema.sql');
    expect(actorCk).toContain(`CHECK ("actor_kind" IN ('owner', 'agent'))`);
  });
});
