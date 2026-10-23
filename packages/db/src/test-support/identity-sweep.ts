/**
 * The identity gateway's live sweep (migration 0322, plan v3.2 S7b part b2
 * round 13): every function the narrow system role may EXECUTE, generated
 * from the catalog (pg_proc and has_function_privilege, never a hand list),
 * called as the REAL narrow login with every identity setting forged to the
 * brain owner and the Admin workspace, with owner-shaped arguments. Each
 * must refuse or change no row: a transaction that changed a row has a
 * transaction id (pg_current_xact_id_if_assigned), one that only read has
 * none. Shared by identity-gateway.db.test.ts and the workstation's forge
 * proof (which runs the same statements through psql).
 */

/** The calls, one per function: `sig` and the statement with @OWNER@,
 *  @WS@ and @AGENT@ to fill in. Run as a superuser. */
import { WORKSPACE_SYSTEM_REASONS } from '../viewer';

export const IDENTITY_SWEEP_CALLS_SQL = `
with f as (
  select p.oid, p.oid::regprocedure::text as sig, n.nspname, p.proname, p.prokind,
         coalesce(p.proargnames, '{}'::text[]) as names, p.proargtypes::oid[] as types
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname not in ('pg_catalog', 'information_schema') and n.nspname !~ '^pg_'
     and p.prokind in ('f', 'p')
     and has_function_privilege('mantle_system_narrow', p.oid, 'EXECUTE')
     and p.prorettype not in ('trigger'::regtype, 'event_trigger'::regtype, 'internal'::regtype,
                              'cstring'::regtype)
     and not exists (select 1 from unnest(p.proargtypes::oid[]) t
                      where t::regtype::text in ('internal', 'cstring', 'anyelement', 'anyarray',
                        'anynonarray', 'anyenum', 'anyrange', 'anycompatible',
                        'anycompatiblearray', 'anymultirange', '"any"', 'trigger'))
)
select f.sig,
       case when f.prokind = 'p' then 'call ' else 'select ' end
         || quote_ident(f.nspname) || '.' || quote_ident(f.proname) || '('
         || coalesce((
              select string_agg(
                case a.t::regtype::text
                  when 'uuid' then case
                    when coalesce(f.names[a.ord], '') ~* '(ws|workspace|space)' then '''@WS@''::uuid'
                    when coalesce(f.names[a.ord], '') ~* 'agent' then '''@AGENT@''::uuid'
                    else '''@OWNER@''::uuid' end
                  when 'uuid[]' then 'array[''@WS@''::uuid]'
                  when 'text' then case
                    when coalesce(f.names[a.ord], '') ~* '^action$' then '''unpair'''
                    when coalesce(f.names[a.ord], '') ~* 'area' then '''assistants'''
                    when coalesce(f.names[a.ord], '') ~* '^kind$' then '''secret-item'''
                    when coalesce(f.names[a.ord], '') ~* '^op$' then '''delete'''
                    when coalesce(f.names[a.ord], '') ~* '^fn$' then '''mantle_ws_set_moderator'''
                    else '''admin''' end
                  when 'boolean' then 'true'
                  when 'integer' then '1' when 'bigint' then '1' when 'smallint' then '1'
                  when 'numeric' then '1' when 'double precision' then '1' when 'real' then '1'
                  when 'jsonb' then '''{}''::jsonb' when 'json' then '''{}''::json'
                  when 'text[]' then '''{admin}''::text[]'
                  when 'timestamp with time zone' then 'now()'
                  else 'null::' || a.t::regtype::text end,
                ', ' order by a.ord)
              from unnest(f.types) with ordinality a(t, ord)), '')
         || ')' as stmt
  from f order by f.sig`;

/** Every identity setting forged to the owner and the Admin workspace, and
 *  a trusted system reason as the actor. */
export const IDENTITY_FORGE_SQL = `select
  set_config('mantle.login_id', '@OWNER@', true), set_config('mantle.scope_login', '@OWNER@', true),
  set_config('mantle.acting_login', '@OWNER@', true), set_config('mantle.ws', '{@WS@}', true),
  set_config('mantle.mod_ws', '{@WS@}', true), set_config('mantle.space_id', '@WS@', true),
  set_config('mantle.create_ws', '@WS@', true), set_config('mantle.private_ws', '@WS@', true),
  set_config('mantle.actor', '@ACTOR@', true), set_config('mantle.route', 'full', true),
  set_config('mantle.write_mode', 'rw', true)`;

/** The same forge with no scope (no workspaces, no scope login): the
 *  shape a definer's system path takes, where the acting login alone was
 *  trusted (the assistant delete forge). */
export const IDENTITY_FORGE_UNSCOPED_SQL = `select
  set_config('mantle.login_id', '', true), set_config('mantle.scope_login', '', true),
  set_config('mantle.ws', '', true), set_config('mantle.mod_ws', '', true),
  set_config('mantle.acting_login', '@OWNER@', true), set_config('mantle.create_ws', '@WS@', true),
  set_config('mantle.actor', '@ACTOR@', true), set_config('mantle.route', 'full', true),
  set_config('mantle.write_mode', 'rw', true)`;

export function fillIdentity(
  stmt: string,
  ids: { owner: string; ws: string; agent: string },
): string {
  return stmt
    .replaceAll('@OWNER@', ids.owner)
    .replaceAll('@WS@', ids.ws)
    .replaceAll('@AGENT@', ids.agent)
    .replaceAll('@ACTOR@', FORGED_ACTOR);
}

/** The forged actor: the first workspace system reason (the Moderator
 *  tick's), which mantle_ws_system_work trusted before 0322. Read from the
 *  list, not named: the reasons are named only in their pinned systemWork
 *  calls (eslint-rules/arch-lints.test.ts). */
export const FORGED_ACTOR = `system:${WORKSPACE_SYSTEM_REASONS[0]}`;
