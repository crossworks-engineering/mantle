/**
 * The role, area and actor names (arch plan A10 #13), RECORDED as every
 * copy stood on main v0.300.47, before each was read from one source.
 *
 * Record, move, compare: the first commit of A10 #13 proved RECORDED
 * against the literals in the source files (the commit before this one), and that
 * every copy of a concept already held its source's values (no difference
 * on main). Now each copy reads its source (./role-names and the dto lists),
 * and this proves each source holds exactly the values main recorded, in
 * main's order. A list the code only asks membership of is compared as a
 * set; a list whose order means something is compared in order (ORDERED).
 *
 * These are also the contract's VALUES (jackdaw holds hand copies of some):
 * a change here is a contract change, made on purpose.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ACCESS_LEVELS } from './dto/access';
import { ACCESS_KEY_AREAS } from './dto/access-keys';
import { WORKSPACE_AREAS, isWorkspaceArea } from './dto/workspaces';
import { HISTORY_ACTORS, LOGIN_ROLES, RECALL_ACTOR_KINDS, isLoginRole } from './role-names';

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

/** The source of each concept, as the code reads it now. */
const SOURCES = {
  loginRole: LOGIN_ROLES,
  workspaceArea: WORKSPACE_AREAS,
  historyActor: HISTORY_ACTORS,
  recallActor: RECALL_ACTOR_KINDS,
  accessLevel: ACCESS_LEVELS,
  keyArea: ACCESS_KEY_AREAS,
} as const satisfies Record<keyof typeof RECORDED, readonly string[]>;

const MIGRATIONS = new URL('../../db/migrations/', import.meta.url);

/** The text of the newest migration that adds `constraint`. */
function newestCheck(constraint: string): string {
  const files = readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  let found = '';
  for (const f of files) {
    const text = readFileSync(new URL(f, MIGRATIONS), 'utf8');
    const at = text.indexOf(`ADD CONSTRAINT "${constraint}"`);
    const inline = text.indexOf(`CONSTRAINT "${constraint}" CHECK`);
    const from = at >= 0 ? at : inline;
    if (from >= 0) found = text.slice(from, text.indexOf(';', from));
  }
  if (!found) throw new Error(`no migration adds ${constraint}`);
  return found;
}

const quoted = (values: readonly string[]) => values.map((v) => `'${v}'`).join(', ');

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
  it('each source holds the values main recorded, in main order', () => {
    for (const [concept, values] of Object.entries(SOURCES)) {
      expect([...values], concept).toEqual([...RECORDED[concept as keyof typeof RECORDED].source]);
    }
  });

  it('every copy on main already held its source values', () => {
    expect(differences()).toEqual([]);
  });

  it('the guards accept exactly the source values', () => {
    for (const r of LOGIN_ROLES) expect(isLoginRole(r)).toBe(true);
    for (const v of ['client', 'owner', 'Admin', '', null, undefined, 1]) {
      expect(isLoginRole(v)).toBe(false);
    }
    for (const a of WORKSPACE_AREAS) expect(isWorkspaceArea(a)).toBe(true);
    for (const v of ['content', 'self', 'Settings', '', null])
      expect(isWorkspaceArea(v)).toBe(false);
  });

  it('the role and recall actor CHECKs admit the source values', () => {
    expect(newestCheck('users_role_ck')).toContain(`CHECK ("role" IN (${quoted(LOGIN_ROLES)})`);
    expect(newestCheck('recall_revisions_actor_kind_ck')).toContain(
      `CHECK ("actor_kind" IN (${quoted(RECALL_ACTOR_KINDS)}))`,
    );
  });
});
