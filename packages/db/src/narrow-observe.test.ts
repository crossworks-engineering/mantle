/**
 * The narrow write count's actor list and its migration (plan v3.2 S7a
 * part a3), no database: mantle_narrow_actor (the latest migration that
 * makes it) names exactly the actors of the reasons viewer.ts routes
 * narrow, so a reason moved between routes fails here until a migration
 * replaces the function; and the migration's renumber proof.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { noteActorMiss, setActorMissLogger, type ActorMiss } from './actor';
import { AS_SYSTEM_ROUTE, REQUEST_SYSTEM_REASON, REQUEST_SYSTEM_ROUTE } from './viewer';

const DIR = join(__dirname, '..', 'migrations');
const journal = (
  JSON.parse(readFileSync(join(DIR, 'meta', '_journal.json'), 'utf8')) as {
    entries: { idx: number; when: number; tag: string }[];
  }
).entries;
const TAG = '0312_narrow_write_observe';

/** The actor each request exit binds (viewer.ts noteRequestSystem,
 *  enterFirstOwnerExit). */
const REQUEST_EXIT_REASON: Record<keyof typeof REQUEST_SYSTEM_ROUTE, string> = {
  area: 'http:admin-area',
  'login-self': 'http:login-self',
  'first-owner': 'first-owner-attach',
};

describe('mantle_narrow_actor names the narrow reasons (plan v3.2 S7a)', () => {
  it('each request exit binds the actor this list names', () => {
    expect(REQUEST_SYSTEM_REASON).toEqual(REQUEST_EXIT_REASON);
  });

  it('equals AS_SYSTEM_ROUTE and REQUEST_SYSTEM_ROUTE', () => {
    const files = readdirSync(DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    const defs = files
      .map((f) => readFileSync(join(DIR, f), 'utf8'))
      .filter((t) => /FUNCTION\s+"public"\."mantle_narrow_actor"\(/.test(t));
    expect(defs.length).toBeGreaterThan(0);
    const body = defs[defs.length - 1]!;
    const list = /"mantle_narrow_actor"[\s\S]*?ARRAY\[([\s\S]*?)\]::text\[\]/.exec(body)?.[1] ?? '';
    const inSql = [...list.matchAll(/'([^']+)'/g)].map((m) => m[1]!).sort();
    const want = [
      ...Object.entries(AS_SYSTEM_ROUTE)
        .filter(([, r]) => r === 'narrow')
        .map(([reason]) => `system:${reason}`),
      ...Object.entries(REQUEST_SYSTEM_ROUTE)
        .filter(([, r]) => r === 'narrow')
        .map(([why]) => `system:${REQUEST_EXIT_REASON[why as keyof typeof REQUEST_SYSTEM_ROUTE]}`),
    ].sort();
    expect(inSql).toEqual(want);
  });
});

describe('0312 is stamped above every `when` before it (renumber proof)', () => {
  const at = journal.findIndex((e) => e.tag === TAG);
  it('is in the journal, after its predecessor, above its predecessor (0311, when 1790197980000)', () => {
    expect(at).toBeGreaterThan(0);
    expect(journal[at]!.idx).toBe(journal[at - 1]!.idx + 1);
    expect(journal[at]!.when).toBeGreaterThan(journal[at - 1]!.when);
    expect(journal[at]!.when).toBeGreaterThan(1790197980000);
    for (const e of journal.slice(0, at)) expect(e.when, e.tag).toBeLessThan(journal[at]!.when);
    expect(readdirSync(DIR)).toContain(`${TAG}.sql`);
  });
  it('its revert takes the same `when` off the ledger', () => {
    const revert = readFileSync(join(DIR, '..', 'rollback', `${TAG}.revert.sql`), 'utf8');
    expect(revert).toContain(`WHERE "created_at" = ${journal[at]!.when};`);
  });
});

describe('a narrow check is one row per actor and table an hour', () => {
  const nodeEnv = process.env.NODE_ENV;
  afterEach(() => {
    process.env.NODE_ENV = nodeEnv;
    setActorMissLogger(() => {});
    vi.restoreAllMocks();
  });

  it('a second reason on the same table is a row of its own; another check keeps its key', () => {
    const rows: ActorMiss[] = [];
    setActorMissLogger((m) => rows.push(m));
    process.env.NODE_ENV = 'production';
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const write = (check: string, actor: string) =>
      noteActorMiss({ source: 'sql', check, actor, detail: 'nodes-dedupe-cell INSERT' });
    write('narrow-content-write', 'system:admin-area');
    write('narrow-content-write', 'system:admin-area');
    write('narrow-content-write', 'system:http:admin-area');
    write('narrow-denied', 'system:admin-area');
    write('narrow-denied', 'system:http:login-self');
    write('no-actor-dedupe-cell', 'a');
    write('no-actor-dedupe-cell', 'b');
    expect(rows.map((r) => `${r.check} ${r.actor}`)).toEqual([
      'narrow-content-write system:admin-area',
      'narrow-content-write system:http:admin-area',
      'narrow-denied system:admin-area',
      'narrow-denied system:http:login-self',
      'no-actor-dedupe-cell a',
    ]);
  });
});
