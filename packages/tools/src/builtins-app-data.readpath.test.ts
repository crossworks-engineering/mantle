/**
 * The app data reads provision the app's database (workspaces arch A5 step
 * 4 must-do): app_data_schema and app_data_query make the app's registry
 * row, bring it to its declared schema and set its viewer salt
 * (app_databases, an item table). Since step 4 the owner MCP surface runs
 * a read tool read only (the gate's callActor: login(ro)), and system work
 * under a read-only login stays read only (systemUnder), so the database
 * would refuse the provisioning. It is a named read-path write
 * (READ_PATH_WRITES 'repair:app-db'): it runs as its own system actor,
 * which writes, whoever reads. Only the provisioning (fix round 1, LOW-4):
 * the read itself, the caller's SQL, stays read only. Pinned here by the
 * actors the provisioning and the read run as, called as a read-only login.
 */
import { describe, expect, it, vi } from 'vitest';
import { READ_PATH_WRITES, currentActor, loginActor, runAsActor, type Actor } from '@mantle/db';

const h = vi.hoisted(() => ({
  provision: [] as (Actor | null)[],
  read: [] as (Actor | null)[],
}));

type Provision = <T>(fn: () => Promise<T>) => Promise<T>;

vi.mock('@mantle/content', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getMcpDataApp: async (_a: string, _r: string, id: string) => ({
    id,
    title: 'Stock',
    writable: false,
    manifest: { sqlite: { schemaSql: 'create table t (a int)', schemaVersion: 2 } },
  }),
  recordAppAccess: () => undefined,
  recordAppError: () => undefined,
}));
vi.mock('@mantle/content/app-broker', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  appDbTableDetails: async (_o: string, _a: string, opts: { provision?: Provision }) => {
    await opts.provision!(async () => h.provision.push(currentActor()));
    h.read.push(currentActor());
    return { schemaVersion: 2, tables: [] };
  },
  appDbQuery: async (
    _o: string,
    _a: string,
    _sql: string,
    _p: unknown[],
    _s: unknown,
    opts: { provision?: Provision },
  ) => {
    await opts.provision!(async () => h.provision.push(currentActor()));
    h.read.push(currentActor());
    return [];
  },
}));

import { app_data_query, app_data_schema } from './builtins-app-data';

const LOGIN = '00000000-0000-4000-8000-0000000000b1';
const APP = '20000000-0000-4000-8000-000000000001';

const ctx = {
  ownerId: 'owner-1',
  surface: {
    kind: 'owner' as const,
    via: 'mcp' as const,
    loginId: LOGIN,
    mcp: { via: 'oauth' as const, write: false, role: 'member' as const },
  },
};

describe('the app data reads name their provisioning (A5 step 4)', () => {
  it('is a named read-path write', () => {
    expect('repair:app-db' in READ_PATH_WRITES).toBe(true);
    expect(app_data_schema.policy.effect).toBe('read');
    expect(app_data_query.policy.effect).toBe('read');
  });

  it('provisions as system(repair:app-db) that writes; the read stays read only', async () => {
    h.provision = [];
    h.read = [];
    const ro = loginActor(LOGIN, 'ro');
    const schema = await runAsActor(ro, () => app_data_schema.handler({ app_id: APP }, ctx));
    expect(schema.ok, JSON.stringify(schema)).toBe(true);
    const query = await runAsActor(ro, () =>
      app_data_query.handler({ app_id: APP, sql: 'select 1' }, ctx),
    );
    expect(query.ok, JSON.stringify(query)).toBe(true);
    expect(h.provision).toHaveLength(2);
    expect(h.read).toHaveLength(2);
    for (const actor of h.provision) {
      // The named read-path write, not narrowed by the login(ro) around it.
      expect(actor).toEqual({ kind: 'system', reason: 'repair:app-db' });
    }
    for (const actor of h.read) {
      // The read itself (the caller's SQL): system(app-data), read only
      // under the login(ro) it runs for.
      expect(actor).toMatchObject({ kind: 'system', reason: 'app-data', mode: 'ro' });
    }
    // Without the name, the same system work under login(ro) is read only.
    const { systemUnder } = await import('@mantle/db');
    expect(systemUnder('app-data', ro)).toMatchObject({ mode: 'ro' });
  });
});
