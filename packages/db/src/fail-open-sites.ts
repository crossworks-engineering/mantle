/**
 * What makes a fail-open branch a hit (plan v3.2 S4a; fail-open.ts counts
 * it), and the writer of its row. gateway/scope-answers.ts and
 * gateway/write-route.ts call these at their three sites; viewer.ts calls
 * noteFailOpen itself.
 */
import { getTableName, is } from 'drizzle-orm';
import { PgTable, getTableConfig } from 'drizzle-orm/pg-core';
import { SCOPED_SYSTEM_WRITE } from './access-matrix';
import { currentActor, longStack, writeActorMissRow, type Actor } from './actor';
import { noteFailOpen, setFailOpenWriter, type FailOpenSite } from './fail-open';
import { requestWriteScope, systemDbCallerOf } from './viewer';

setFailOpenWriter(writeActorMissRow);

/** `schema.table` of a drizzle table (an unqualified one is public's), or
 *  '?' for anything else. */
export function tableNameOf(table: unknown): string {
  if (!is(table, PgTable)) return '?';
  return `${getTableConfig(table).schema ?? 'public'}.${getTableName(table)}`;
}

/** The calling file of a hit (taken only when fail-open.ts lets the site
 *  take a stack); longStack's own frames and this file's left out. */
function failOpenCaller(): string | null {
  const frames = longStack()
    .split('\n')
    .filter(
      (line) => !/packages\/db\/src\/(?:actor|fail-open-sites)\.ts/.test(line.replace(/\\/g, '/')),
    );
  return systemDbCallerOf(frames.join('\n'));
}

/**
 * A scoped write sent to the system pool because the write role holds no
 * right on its table (`table`: a drizzle table or `schema.table`): counted,
 * never refused here. Scoped is loginWriteRoute's test
 * (gateway/write-route.ts: an actor the write role takes, its kinds
 * `writeRoleActors`, and a write scope), so system work, which binds a
 * system actor, is never a hit. A table whose matrix row names
 * scopedSystemWrite (SCOPED_SYSTEM_WRITE, its reason) is no hit either:
 * S4b refuses the rest.
 */
export function noteScopedSystemWrite(
  site: FailOpenSite,
  table: unknown,
  writeRoleActors: ReadonlySet<Actor['kind']>,
): void {
  const actor = currentActor();
  if (!actor || !writeRoleActors.has(actor.kind)) return;
  if (!requestWriteScope()) return;
  const name = typeof table === 'string' ? table : tableNameOf(table);
  if (Object.hasOwn(SCOPED_SYSTEM_WRITE, name)) return;
  noteFailOpen(site, actor.kind, failOpenCaller, name);
}

/** `yes`, given to code outside every workspace scope (scopeHoldsAdmin's
 *  isUnscoped, scopeHasArea's system case): a hit when it is yes and no
 *  system actor is bound, since system work is the route that yes is for. */
export function noteUnscopedYes(site: FailOpenSite, yes: boolean): boolean {
  if (!yes) return yes;
  const actor = currentActor();
  if (actor?.kind !== 'system') noteFailOpen(site, actor?.kind ?? '', failOpenCaller);
  return yes;
}
