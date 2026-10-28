/**
 * The runtime role (workspaces arch A9, plan v2 section 4.2): the app's own
 * pools stop logging in as the superuser that runs the migrations.
 *
 *  - mantle_owner (NOLOGIN) owns the app's tables and sequences, and
 *    mantle_acl_internal() (the marker mantle_owner_role() asks about, 0241
 *    and 0290). Only the migrator acts for it: migrate runs as the superuser
 *    (DATABASE_URL) and hands every table and sequence in APP_SCHEMAS, and
 *    the marker, to it after the migrations (ownTables).
 *  - mantle_runtime is the system pool's login when MANTLE_DB_RUNTIME_ROLE
 *    is on (systemDatabaseUrl), and logs in only then (migrate sets LOGIN
 *    when it sees the switch, NOLOGIN when it does not): not a superuser,
 *    owns nothing, BYPASSRLS (the system pool reads and writes past the row
 *    rules, as it did as the superuser), and data rights only: SELECT,
 *    INSERT, UPDATE and DELETE on the tables but those the access matrix
 *    marks `runtime: 'none'` (and SELECT only on those it marks
 *    `runtime: 'read'`), the sequences, and EXECUTE on an allowlist
 *    (runtimeFunctionAllowlist: what PUBLIC or a viewer role may run, plus
 *    RUNTIME_SYSTEM_FUNCTIONS). A non-owner cannot ALTER a table or disable
 *    its triggers or row rules; a non-superuser cannot set
 *    session_replication_role, mark a function LEAKPROOF, or ALTER DATABASE
 *    (so not mantle.actor_check); and it cannot create anything in public
 *    (CREATE on the schema is taken from PUBLIC). Its password is derived
 *    from MANTLE_MASTER_KEY, as the viewer roles' are: nothing to store.
 *  - The runtime role is a member of mantle_owner WITHOUT INHERIT and
 *    WITHOUT SET: it holds none of the owner's rights and cannot become it,
 *    and mantle_owner_role() (0290: MEMBER, not USAGE) says yes to it, as
 *    to the superuser. So the marker that guard reads is out of its reach.
 *  - mantle_system (NOLOGIN) holds no right and owns nothing. The runtime
 *    role may SET ROLE to it (no INHERIT), and it may SET ROLE to the write
 *    role and the gap writer: the checked rerun's switches, which plan v3
 *    S3 deleted from client.ts (TODO(plan v3 S3 part 2, one release later):
 *    drop both SET memberships and the gap writer role). The
 *    write role's own membership tests (0277, 0278) count only a direct
 *    membership, so the system pool is still "not the write role's login"
 *    there, as it was as the superuser.
 *  - mantle_system_narrow: the narrow system role. Migrate gives it its
 *    login (LOGIN, its password derived from MANTLE_MASTER_KEY as the
 *    runtime role's is, another label; NOLOGIN in per-database mode or with
 *    no master key), and the narrow route's own pool logs in as it
 *    (narrowDatabaseUrl, gateway/pools.ts), so a narrow session holds no
 *    other role to go back to. BYPASSRLS, owns nothing (the narrow route's text check refuses
 *    the large-object functions that would make it an owner), member of
 *    nothing, and its rights come
 *    from the access matrix (narrowFor): read only on the content tables
 *    (closed in S7d),
 *    read and write on the system and admin tables, nothing where the
 *    runtime role has nothing, and EXECUTE on the runtime role's allowlist
 *    less NARROW_DENIED_FUNCTIONS. The runtime role may SET ROLE to it (no
 *    INHERIT), and the superuser may as any role: the narrow route's
 *    fallback (per-database mode, where the role gets no login) takes it per
 *    transaction with set_config('role', ..., true), never a session SET.
 *    Not a member of mantle_owner, so the derivation guards
 *    (mantle_owner_role) count it as a limited role: it writes no content
 *    table anyway.
 *
 * Roles are cluster objects: a restore into a fresh cluster lacks them, so
 * migrate makes them on every run (ensureRuntimeRoles) and
 * scripts/db-restore.sh creates them (no login) before pg_restore, whose
 * grants name them. One brain per cluster: with
 * MANTLE_VIEWER_ROLES_PER_DATABASE the runtime role gets no login and the
 * app refuses the switch.
 */
import { hkdfSync } from 'node:crypto';
import type postgres from 'postgres';
import { env, feature } from '@mantle/config';
import { backoffMs, errorMessage, withRetry } from '@mantle/std';
import { ACCESS_MATRIX, GAP_WRITER_ROLE, NARROW_WRITES, narrowFor } from './access-matrix';
import { viewerRoleName } from './viewer';
import { LOCK_ATTRS, POOL_ROLES, runRoleStatement, withRoleRetry } from './viewer-roles';

type Sql = ReturnType<typeof postgres>;

export const OWNER_ROLE = 'mantle_owner';
export const RUNTIME_ROLE = 'mantle_runtime';
export const SYSTEM_ROLE = 'mantle_system';
export const NARROW_ROLE = 'mantle_system_narrow';

/**
 * pg-boss's routines taken from PUBLIC (pg-boss makes them with PUBLIC's
 * default EXECUTE): job_table_run runs its text argument as SQL, as its
 * caller, and the app's roles hold USAGE on the schema for the queue counts.
 * pg-boss runs as the migrator (DATABASE_URL), which owns them; no role the
 * app runs as calls one (it reads pgboss.job and pgboss.version only). Run
 * at every migrate (applyRuntimeGrants) and by pgboss:init right after
 * pg-boss installs or upgrades its schema (a fresh box's routines come after
 * migrate). Per-schema default privileges cannot take a global default
 * (PUBLIC's EXECUTE) away, so there is none for this (measured on pg18).
 */
export async function revokePgBossRoutines(sql: {
  unsafe: (text: string) => PromiseLike<unknown>;
}): Promise<void> {
  await sql.unsafe('REVOKE EXECUTE ON ALL ROUTINES IN SCHEMA pgboss FROM PUBLIC');
}

/**
 * The server-side large-object creators. No role the app runs as makes a
 * large object (measured: no app code calls one, pg-boss neither), and one
 * the narrow login made would be its own, outside every table's rules (the
 * text check refuses the plain calls; it is not the boundary). So EXECUTE
 * is taken from PUBLIC at every migrate (applyRuntimeGrants), in each
 * database migrate runs in. lo_import is the superuser's already (Postgres
 * 11 and later); named so the list is whole.
 */
export const LARGE_OBJECT_CREATORS = [
  'pg_catalog.lo_create(oid)',
  'pg_catalog.lo_creat(integer)',
  'pg_catalog.lo_from_bytea(oid, bytea)',
  'pg_catalog.lo_import(text)',
  'pg_catalog.lo_import(text, oid)',
] as const;

/** Take EXECUTE on LARGE_OBJECT_CREATORS from PUBLIC (the superuser keeps
 *  them). */
export async function revokeLargeObjectCreators(sql: {
  unsafe: (text: string) => PromiseLike<unknown>;
}): Promise<void> {
  await sql.unsafe(`REVOKE EXECUTE ON FUNCTION ${LARGE_OBJECT_CREATORS.join(', ')} FROM PUBLIC`);
}

/** A database (or any) name as a quoted identifier: its `"` doubled. */
export function quotedIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** The schemas the app's tables live in. pgboss (pg-boss's own, it makes
 *  partitions at run time) and drizzle (the ledger) stay the migrator's. */
export const APP_SCHEMAS = ['public', 'auth'] as const;

/** APP_SCHEMAS as a SQL list of literals, for the catalog reads below. */
export const APP_SCHEMAS_SQL = APP_SCHEMAS.map((s) => `'${s}'`).join(', ');

/** The roles scripts/db-restore.sh makes before pg_restore (a test checks
 *  the script names the same). */
export const RUNTIME_ROLES = [OWNER_ROLE, SYSTEM_ROLE, NARROW_ROLE, RUNTIME_ROLE] as const;

/** The function whose owner mantle_owner_role() asks about (0241, 0290). */
export const ACL_MARKER_FUNCTION = 'public.mantle_acl_internal()';

/** The derivation guards' owner test (0241). 0290 made it ask for MEMBER;
 *  before that it asked for USAGE, which the runtime role (a member without
 *  INHERIT) never passes: every write guard would refuse the system pool. */
export const OWNER_ROLE_FUNCTION = 'public.mantle_owner_role()';

/** The marker's body, as 0241 made it: migrate makes it again when it is
 *  missing or not this (ensureAclMarker). */
const ACL_MARKER_BODY = `
  SELECT coalesce(current_setting('mantle.acl_internal', true), '') = 'on'
`;

/**
 * Functions the runtime role may not EXECUTE, nor any viewer role (and
 * PUBLIC, again, though the migrations already took it): the switches of
 * the checks, the heads key's own primitives, the actor setters (packages/db
 * sets the actor with set_config), and the steps that change the schema.
 * Each is a migrator's or an operator's (docs/update-prod.md), never the
 * app's. A missing one (a database before its migration) is skipped.
 *
 * The runtime role's own rights are an allowlist (runtimeFunctionAllowlist),
 * so this list is not what keeps a function from it: it is what is taken
 * from PUBLIC and the viewer roles, and what the allowlist may never hold.
 */
export const RUNTIME_DENIED_FUNCTIONS: Readonly<Record<string, string>> = {
  'public.mantle_set_check(text,text,integer,text)': 'sets a check mode (ALTER DATABASE)',
  'public.mantle_set_actor_check(text,integer,text)': 'sets mantle.actor_check',
  'public.mantle_set_edit_check(text,integer,text)': 'sets mantle.edit_check',
  'public.mantle_check_note(text,text)': 'writes the record of a lowered check (ALTER DATABASE)',
  'public.mantle_switch_triggers(text[],boolean,integer)': 'enables or disables triggers',
  'public.mantle_actor_check_triggers(boolean,integer)': 'the actor check triggers on or off',
  'public.mantle_edit_check_triggers(boolean,integer)': 'the edit check triggers on or off',
  'public.mantle_heads_mac(text)': 'a MAC with the heads key: a forged held list',
  'public.mantle_heads_sig(text,text)': 'a held list signature: a forged held list',
  'public.mantle_heads_set(uuid[],uuid[])': 'sets a signed held list without the locks',
  'public.mantle_heads_bypass(text)': 'turns the heads check off (migrations only)',
  'public.mantle_set_actor(text,text,text)': 'an actor setter (packages/db uses set_config)',
  'public.mantle_operator_actor(text)': "an operator's psql actor",
  'public.mantle_write_role_sync_table(text,boolean,text[])': 'row rules and triggers (DDL)',
  'public.mantle_ws_ddl_retry(text[],text)': 'runs DDL (the workspaces switch)',
  'public.mantle_ws_switch_off()': 'drops the bridge triggers (DDL)',
  'public.mantle_ws_migrate_locked()': 'the workspaces switch (executeAsMigrator)',
};

/**
 * The functions taken from PUBLIC (and from every viewer role) that the
 * system pool itself calls, each with where. With what PUBLIC or a viewer
 * role may run, this is all the runtime role may EXECUTE
 * (runtimeFunctionAllowlist); runtime-role.db.test.ts pins that the set of
 * such functions it may run is exactly this list, so a new one is a
 * reviewed line here. A trigger function needs no entry: Postgres checks
 * EXECUTE when the trigger is made, not when it fires. Everything a
 * SECURITY DEFINER function calls runs as its owner, so it needs no entry
 * either; an invoker function here calls none of the PUBLIC-revoked ones.
 * The workspaces switch (mantle_ws_migrate and its steps) is not here: the
 * app runs it as the migrator (mantle_ws_migrate_locked, executeAsMigrator).
 */
export const RUNTIME_SYSTEM_FUNCTIONS: Readonly<Record<string, string>> = {
  'public.mantle_narrow_message_ok(uuid,uuid,uuid,uuid)':
    "0321's assistant_messages guard: the trigger, as the narrow role, asks it whether a row it inserts is consistent (a read definer)",
  'public.mantle_actor_miss_log(text,text,text,text)':
    'gateway/pools.ts logActorMiss: an actor check miss row, as system(actor-check)',
  'public.mantle_check_box_mode(text)':
    'gateway/check-mode.ts EDIT_CHECK_DRIFT_SQL and check-floor.ts CHECK_FLOOR_SQL: the boot warnings and the integrity rows',
  'public.mantle_check_lowered()':
    'check-floor.ts CHECK_FLOOR_SQL: the record of a check lowered below on (0301), logged loudly',
  'public.mantle_contact_sharing_set(uuid,text,text)':
    "admin-acts.ts: an Admin user's switch of a contact's sharing (0308)",
  'public.mantle_contact_sharing_rows(uuid,uuid,text,text)':
    'contact-share-codes.ts: the same rows for an owner, system work (0308)',
  'public.mantle_contact_shares_revoke_all(uuid)':
    "admin-acts.ts: an Admin user's Revoke all of a contact's shares (0308)",
  'public.mantle_contact_shares_revoke_rows(uuid,uuid)':
    'contact-shares.ts: the same rows for an owner, system work (0308)',
  'public.mantle_embed_host(uuid,public.node_type)':
    'maintenance/refold-embeds.ts: the host text of an embedded item (0248)',
  'public.mantle_entity_merge(uuid,uuid)': "admin-acts.ts: an Admin user's entity merge (0308)",
  'public.mantle_entity_merge_rows(uuid,uuid,uuid)':
    'entity-dedup.ts mergeEntities: the entities-dedupe sweep and CLI, system work (0308)',
  'public.mantle_share_close_admin(uuid)':
    'admin-acts.ts: a share closed by an Admin user with the users area (0310)',
  'public.mantle_share_contact_write_set(uuid,boolean)':
    "admin-acts.ts: an Admin user's Can write on a contact share (0310)",
  'public.mantle_app_trash_act(uuid,text)':
    "admin-acts.ts: an Admin user's purge or restore check of a deleted app (0310)",
  'public.mantle_share_with_contacts(uuid,uuid[],text[],boolean,text[])':
    "admin-acts.ts: an Admin user's share of an item with contacts (0308)",
  'public.mantle_share_with_contacts_rows(uuid,uuid,uuid[],text[],boolean,text[])':
    'contact-shares.ts: the same rows for an owner, system work (0308)',
  'public.mantle_area_rule(uuid,text)':
    'gateway/scope-answers.ts loginHasArea: the area rule about another login (0304, S2a a0)',
  'public.mantle_login_areas(uuid)': 'the areas the area rule gives a login (0304, S2a a0)',
  'public.mantle_login_is_admin(uuid)':
    'gateway/scope-answers.ts loginHoldsAdmin: a login holds Admin now (0304, S2a a0)',
  'public.mantle_login_role(uuid)':
    "the display role, Admin membership (0330, S8b): token-login's device-login answer, pair-code's read before the claim (a member's code) and the Users screen's target (loadLoginTarget), membership whether the login is enabled or not",
  'public.mantle_role_drift()':
    'the box count of role drift (scripts/arch-scoreboard-box.sh; 0304, S2a a0)',
  'public.mantle_ws_archive(uuid,uuid)':
    "workspaces.ts archiveWorkspace: a workspace archived by the acting login, on the system pool in its write scope so every held item's head is locked (0309, S2b)",
  'public.mantle_ws_attach_assistants()':
    'workspaces-migrate.ts attachDefaultAssistants: the default assistants (a definer since 0307: system work at boot, the assistants area at signup and onboarding)',
  'public.mantle_ws_private_workspace(uuid)':
    "gateway/viewer-scope.ts: the creating login's private workspace (W6b create home)",
  'public.mantle_ws_skip_reason()':
    'snapshot-copies.ts and the integrity row workspaces_not_migrated',
  'public.mantle_file_restamp_home(uuid,uuid)':
    "packages/files ops/files.ts restampRacedCreate: a raced snapshot copy's home, the snapshot copies' system work only (0313)",
  'public.mantle_tg_login_moderates(uuid,uuid,uuid)':
    "packages/telegram chat-login.ts loginModeratesBot: a Telegram bot's Moderator rule about a login, a read definer (0313)",
  'public.mantle_structure_item(text,text,uuid,uuid,uuid[],jsonb)':
    'gateway/structure-item.ts: a listed structure item (Secrets root, secret, peer, contact, documentation) a narrow exit makes, edits or removes; the definer holds the rule (0316)',
  'public.mantle_space_settle_promotion(uuid,uuid)':
    "login-update.ts: a login made admin, its personal space's shared and submitted items back to private drafts, on the users area's narrow exit; the definer holds the rule (0317)",
  'public.mantle_member_turn_claim(text,uuid,timestamp with time zone,integer,bigint)':
    "login-definer.ts: a member chat turn's slot of the daily cap and token budget, for the scope's own login only (the system pool in that login's scope); the definer holds the rule (0326)",
  'public.mantle_member_turn_release(text)':
    "login-definer.ts: a slot given back when its turn's enqueue failed, the scope login's own row of the last five minutes only (0326)",
  'public.mantle_member_turn_settle(text,bigint)':
    "login-definer.ts: a member chat turn's model tokens stamped on its slot at the turn's close, the scope login's own row only, only up; the token budget reads them (0327)",
  'public.mantle_narrow_login_held(uuid)':
    "login-update.ts and session.ts: whether a login's disable or session end runs at the spot login-credential (the owner or an Admin user, 0327's hold); also read by that hold's report branch",
  'public.mantle_narrow_client_held(uuid)':
    "mcp-clients.ts disconnectClient: whether an MCP client's removal runs at the spot login-credential (a live grant of the owner or an Admin user on it, 0327's hold); also read by that hold's trigger",
  'public.mantle_agent_delete(uuid,uuid,uuid,boolean)':
    "agents.ts deleteAgent: an assistant deleted, with or without its conversation, on the assistants area's narrow exit; the definer holds the rule (0317)",
};

/**
 * The functions taken from PUBLIC that the narrow system role may EXECUTE:
 * an allowlist, each with the narrow work that calls it. Measured with the
 * switch on (the full DB suite and the area routes' sweep,
 * narrow-area-routes.db.test.ts: what a narrow statement names), plus what the column defaults
 * and checks of the tables it writes call (none today:
 * runtime-role.db.test.ts reads them from the catalog and fails on one not
 * listed here). Each must also be the runtime role's (narrowFunctionAllowlist
 * intersects the two) and never in NARROW_DENIED_FUNCTIONS. A trigger
 * function needs no entry (EXECUTE is checked when the trigger is made),
 * nor what a definer calls (it runs as its owner); but what a plain (not
 * definer) trigger function calls does, since it runs as the role that
 * wrote the row (runtime-role.db.test.ts walks them from the catalog). Everything else the
 * runtime role may run, the content-writing definers among it, is refused
 * to the narrow role: a narrow exit's own content write runs at a full-route
 * spot (viewer.ts FULL_ROUTE_SPOTS).
 */
export const NARROW_SYSTEM_FUNCTIONS: Readonly<Record<string, string>> = {
  'public.mantle_narrow_login_held(uuid)':
    "0327's hold on auth.users (a trigger that runs as the narrow role): a read definer that answers whether a login is the owner or an Admin user; no identity read",
  'public.mantle_narrow_client_held(uuid)':
    "0327's hold on access_keys, oauth_access_tokens, mobile_tokens, oauth_auth_codes and oauth_clients (a trigger that runs as the narrow role): a read definer that answers whether an MCP client carries a live grant of the owner or an Admin user; no identity read",
  'public.mantle_narrow_message_ok(uuid,uuid,uuid,uuid)':
    "0321's assistant_messages guard on the narrow role's insert (the turn's message rows): a read definer that answers whether the row is consistent",
  'public.mantle_brain_id()':
    "the brain's anchor, read by narrow statements (resolve-owner.ts, the tree's kind roots, workspace-ticks.ts)",
  'public.mantle_area_rule(uuid,text)':
    'the area rule about a login (the login-self routes, the Telegram login): a read definer (0304)',
  'public.mantle_login_areas(uuid)':
    "a login's areas (the login-self routes' whoami and devices): a read definer (0304)",
  'public.mantle_connector_state(uuid,text)':
    "a connector's state (the Admin area's approval recheck): a read definer",
  'public.mantle_ws_kind(uuid)': "a workspace's kind (the login-self routes): a read definer",
  'public.mantle_ws_private_for(uuid,uuid)':
    "whether a workspace is a login's private one (the login-self routes' whoami): a read definer",
  'public.mantle_connector_rows(uuid,text,uuid[])':
    "a connector's rows (the Admin area's approval of an elevated call): a read definer",
  'public.mantle_login_role(uuid)':
    "the users area's change reads its target's role from Admin membership (login-update.ts loadLoginTarget, S8b round 4): a read definer (0330)",
  'public.mantle_login_is_admin(uuid)':
    "a peer's bound login is no Admin user (peer-access.ts resolvePeerActsAs, loginIsAdmin; S8b round 4) on the peers area's exit: a read definer (0304)",
  'public.mantle_pending_card_route(uuid,uuid)':
    "a pending approval card's route (the Admin area's run of an item): a read definer",
  'public.mantle_connector_beyond_admin(uuid,text)':
    "whether a connector is held beyond Admin (the Admin area's connector sync, move and key rotate: external-access.ts connectorBeyondAdmin): a read definer with no identity read (0293: an inactive scope reads the owner's rows; round 14, the re-audit's app MED-1: refused on the narrow exit before)",
  'public.mantle_agent_experience(uuid,uuid[])':
    "an assistant's level counts (the assistants area's GET /api/agents: agents.ts listAgents withExperience): a read definer of counts only, no content; on the narrow role the identity readers answer no scope, so it counts the owner's assistants as on the system pool (0293). Round 14b: refused on the narrow exit before (dev's narrow-denied miss of 2026-10-22)",
  'public.mantle_access_log_names(uuid,uuid[])':
    "the display names of an app's access log actors (the users area's GET /api/apps/:id/access-log: app-access-log.ts actorNames): a read definer; on the narrow role no scope, so the names of the actors the app's log holds, as on the system pool (0293)",
  'public.mantle_contact_sharing(uuid,uuid[])':
    "the share code dates of contacts (the users area's POST /api/team-admin/invites from a contact: contacts.ts getContact): a read definer, dates only, never a code; on the narrow role no scope, the listed contacts' (0293)",
  'public.mantle_check_box_mode(text)':
    "the box's actor or edit check mode (the settings area's GET /api/debug/integrity/audit: its check rows): a read of the database's settings, no identity (0280)",
  'public.mantle_check_lowered()':
    "the record of a lowered check floor (the integrity audit's check_floor row): a read of the database's settings, no identity (0301)",
  'public.mantle_ws_skip_reason()':
    "why the workspaces switch skipped this brain (the integrity audit's workspaces_not_migrated row): runs as its caller, so with the narrow role's own reads (0272)",
  'public.mantle_ws_any_shared(uuid[])':
    "whether a workspace list holds one beyond Admin and the private ones (the integrity audit's snapshot row, grant-reads.ts sharedReadsAliasSql): a read definer, no identity (0286)",
  'public.mantle_mail_backfill_accounts(uuid)':
    "the email area's discover (a sender made a contact): the enabled mail accounts' ids and providers, a read definer (backfill-queue.ts)",
};

/**
 * The SECURITY DEFINER functions open to PUBLIC (so to the narrow role too)
 * that are not on NARROW_SYSTEM_FUNCTIONS, each with why it is harmless: a
 * definer runs with its owner's rights, not the narrow role's.
 * runtime-role.db.test.ts fails on any definer the narrow role may run,
 * through PUBLIC or any grant, listed in neither. A function that runs as
 * its caller (no SECURITY DEFINER) runs with the narrow role's own rights
 * and needs no entry.
 */
export const NARROW_PUBLIC_DEFINERS: Readonly<Record<string, string>> = {
  'public.mantle_actor_check_mode()':
    "the box's actor check mode, read by the count's triggers and the pool: reads one setting row, writes nothing",
};

/**
 * Functions of the runtime role's allowlist the narrow system role may
 * never EXECUTE, each with why: NARROW_SYSTEM_FUNCTIONS may not name one
 * (runtime-role.test.ts), and narrowFunctionAllowlist leaves them out
 * whatever it names. The four `_rows` bodies run for an owner with no Admin
 * check: only full system work reaches them (the entities sweep and its
 * CLI) and tests, never a narrow reason. The content and workspace writers
 * among the definers: narrow work calls none of them (measured), and its
 * own content write runs at a full-route spot.
 */
export const NARROW_DENIED_FUNCTIONS: Readonly<Record<string, string>> = {
  // The five definers that need the exit's acting login (0322, and the
  // onboarding attach): the
  // identity readers answer none on the narrow role, so each would refuse
  // it; their callers run at the full-route spot acting-login until a
  // signed acting login lets the readers trust a signed value.
  'public.mantle_ws_set_moderator(uuid,uuid,uuid,boolean,text)':
    "the workspaces area's Moderator tick (workspaces.ts setModerator): needs the acting login, so it runs at the full-route spot acting-login (0322); a self-set login and workspace made a member Moderator on the narrow role before",
  'public.mantle_tg_chat_set(uuid,uuid,uuid,text,uuid)':
    "a chat's block or unpair (telegram pairing.ts setChatPairing): needs the acting login, so it runs at the full-route spot acting-login (0322)",
  'public.mantle_structure_item(text,text,uuid,uuid,uuid[],jsonb)':
    "the keys, connectors and settings areas' structure items (gateway/structure-item.ts): need the acting login, so they run at the full-route spot acting-login (0322)",
  'public.mantle_agent_delete(uuid,uuid,uuid,boolean)':
    "an assistant's delete (gateway/spot-definers.ts deleteAgentOnNarrow): needs the acting login, so it runs at the full-route spot acting-login (0322); a self-set acting login deleted an assistant on the narrow role before",
  'public.mantle_ws_attach_assistants()':
    "the default assistants attached at onboarding (workspaces-migrate.ts attachDefaultAssistants in the login's scope): needs that login, so it runs at the full-route spot acting-login (round 13c: the fifth such definer, met by the onboarding cells with the switch on; on the narrow role it refused every call after 0322)",
  'public.mantle_space_settle_promotion(uuid,uuid)':
    "a promoted login's personal space settled (0317): the role change runs at the full-route spot login-credential with its settle, so no narrow reason calls it (measured); dropped from the narrow allowlist (the CEO's call)",
  'public.mantle_member_turn_claim(text,uuid,timestamp with time zone,integer,bigint)':
    "a member chat turn's slot (0326): runs on the system pool in the login's own scope (login-definer.ts), never a narrow statement; on the narrow role the identity readers answer no login, so it would refuse anyway",
  'public.mantle_member_turn_release(text)':
    "a member chat turn's slot given back (0326): the same rule as the claim; a narrow session may not clear any login's daily cap",
  'public.mantle_member_turn_settle(text,bigint)':
    "a member chat turn's tokens stamped on its slot (0327): the same rule as the claim; a narrow session may not lower its own count or raise another login's",
  'public.mantle_contact_sharing_rows(uuid,uuid,text,text)':
    "an owner's sharing switch with no Admin check: tests only, never a narrow reason",
  'public.mantle_contact_shares_revoke_rows(uuid,uuid)':
    "an owner's Revoke all with no Admin check: tests only, never a narrow reason",
  'public.mantle_share_with_contacts_rows(uuid,uuid,uuid[],text[],boolean,text[])':
    "an owner's contact share with no Admin check: tests only, never a narrow reason",
  'public.mantle_entity_merge_rows(uuid,uuid,uuid)':
    'the entities-dedupe sweep and CLI with no Admin check: full system work',
  'public.mantle_embed_host(uuid,public.node_type)':
    'the refold-embeds maintenance step: full system work',
  'public.mantle_role_drift()': 'the box count, run by hand as the superuser: no app route',
  // The content writers among the definers: narrow work writes no content,
  // so it calls none of them (the switch-on suite measures the calls, the
  // dump's fn:<name> uses); a narrow exit's own content write runs at a
  // full-route spot (viewer.ts FULL_ROUTE_SPOTS).
  'public.mantle_grant_change(text,uuid,uuid,boolean,uuid)':
    "an item's grant change (item_grants, nodes): a login's write, never a narrow reason",
  'public.mantle_grant_move_home(uuid,uuid,boolean,uuid)':
    "an item's home move (item_grants, nodes): a login's write, never a narrow reason",
  'public.mantle_subtree_rewrite(uuid,ltree,ltree)':
    "a folder's subtree rewrite (nodes): a login's move or rename, never a narrow reason",
  'public.mantle_recall_retarget(uuid,text,text)':
    "a recall card's retarget (recall_nodes): a login's write, never a narrow reason",
  'public.mantle_app_trash_act(uuid,text)':
    "an app's trash restore or purge (content tables): the app-trash reason, routed full",
  // The workspace and share writers: a login's act in its own scope, or
  // system work, never a narrow statement (measured; the one measured,
  // mantle_ws_set_moderator, runs at the full-route spot acting-login since
  // 0322, listed above).
  'public.mantle_ws_add_user(uuid,uuid,uuid,boolean)': 'workspace_users: never a narrow statement',
  'public.mantle_ws_remove_user(uuid,uuid,uuid)': 'workspace_users: never a narrow statement',
  'public.mantle_ws_create(uuid,uuid,text,text)': 'workspaces: never a narrow statement',
  'public.mantle_ws_archive(uuid,uuid)': 'workspaces and the held items: never a narrow statement',
  'public.mantle_ws_resource_add(uuid,uuid,text,text,boolean)':
    'workspace_resources: never a narrow statement',
  'public.mantle_ws_resource_remove(uuid,uuid,text,text)':
    'workspace_resources: never a narrow statement',
  'public.mantle_ws_resource_set_write(uuid,uuid,text,text,boolean)':
    'workspace_resources: never a narrow statement',
  'public.mantle_ws_set_assistant(uuid,uuid,uuid)': 'workspaces: never a narrow statement',
  'public.mantle_ws_set_contact(uuid,uuid,uuid)': 'workspaces: never a narrow statement',
  'public.mantle_ws_set_landing(uuid,uuid,uuid)': 'workspaces: never a narrow statement',
  'public.mantle_ws_update_about(uuid,uuid,jsonb)': 'workspaces: never a narrow statement',
  'public.mantle_workspace_event(uuid,uuid,text,jsonb)':
    'workspace_events: written by the workspace definers, never a narrow statement',
  'public.mantle_lock_heads(uuid[],text)': "an item write's heads: never a narrow statement",
  'public.mantle_share_close_admin(uuid)': 'shares (content): never a narrow statement',
  'public.mantle_share_contact_write_set(uuid,boolean)':
    'shares (content): never a narrow statement',
  'public.mantle_file_restamp_home(uuid,uuid)':
    "item_grants (content): the snapshot copies' system work only, never a narrow statement",
};

/** Tables the runtime role holds no right on (the access matrix's
 *  `runtime: 'none'`): what only definer functions touch. */
export function runtimeDeniedTables(): string[] {
  return ACCESS_MATRIX.filter((t) => t.runtime === 'none').map((t) => t.table);
}

/** Tables the runtime role may SELECT and never write (the access matrix's
 *  `runtime: 'read'`): definer functions write them. */
export function runtimeReadOnlyTables(): string[] {
  return ACCESS_MATRIX.filter((t) => t.runtime === 'read').map((t) => t.table);
}

/** Tables the narrow system role may read and write (narrowFor 'all'). */
export function narrowWriteTables(): string[] {
  return ACCESS_MATRIX.filter((t) => narrowFor(t) === 'all').map((t) => t.table);
}

/** The tables the narrow system role may INSERT into (NARROW_WRITES), whose
 *  sequences it may draw from. */
export function narrowInsertTables(): string[] {
  return narrowWriteTables().filter((t) => NARROW_WRITES[t]?.insert === true);
}

/** Tables the narrow system role may only SELECT (narrowFor 'read'). */
export function narrowReadOnlyTables(): string[] {
  return ACCESS_MATRIX.filter((t) => narrowFor(t) === 'read').map((t) => t.table);
}

/**
 * The runtime role's password: HKDF-SHA256 over the master key with its own
 * label (the viewer roles' scheme, another label). Deterministic, so every
 * process of a box derives it and migrate (re)sets it on every run, after a
 * restore and after a master-key change.
 */
export function runtimeRolePassword(masterKey: string): string {
  return loginRolePassword(masterKey, RUNTIME_ROLE);
}

/** The narrow system role's password: the runtime role's scheme, its own
 *  label (`runtime-role:mantle_system_narrow`). */
export function narrowRolePassword(masterKey: string): string {
  return loginRolePassword(masterKey, NARROW_ROLE);
}

/** HKDF-SHA256 over the master key, labelled by the role. */
function loginRolePassword(masterKey: string, role: string): string {
  if (!masterKey) throw new Error(`MANTLE_MASTER_KEY must be set to derive the ${role} password`);
  const key = hkdfSync(
    'sha256',
    Buffer.from(masterKey, 'utf8'),
    Buffer.from('mantle-runtime-role', 'utf8'),
    Buffer.from(`runtime-role:${role}`, 'utf8'),
    32,
  );
  return Buffer.from(key).toString('base64url');
}

/** `adminUrl` with the runtime role's user and password. Host, port,
 *  database and options stay. */
export function runtimeDatabaseUrl(
  adminUrl: string,
  password: string,
  role = RUNTIME_ROLE,
): string {
  const u = new URL(adminUrl);
  u.username = role;
  u.password = password; // base64url: nothing to escape
  return u.toString();
}

/**
 * The URL the narrow route's own pool logs in with (gateway/pools.ts): the
 * same server and database as DATABASE_URL, as mantle_system_narrow, or
 * null when the role has no login here (MANTLE_VIEWER_ROLES_PER_DATABASE:
 * one cluster, several brains, so one password cannot be every brain's;
 * the route then takes the role per transaction on the system pool, as
 * before). Independent of MANTLE_DB_RUNTIME_ROLE: the system pool may log
 * in as the superuser, the narrow pool never does.
 */
export function narrowDatabaseUrl(): string | null {
  const url = env('DATABASE_URL');
  if (!url) throw new Error('DATABASE_URL must be set');
  if (feature('viewerRolesPerDatabase')) return null;
  const key = env('MANTLE_MASTER_KEY');
  if (!key) throw new Error('the narrow route needs MANTLE_MASTER_KEY (the narrow role password)');
  return runtimeDatabaseUrl(url, narrowRolePassword(key), NARROW_ROLE);
}

/** The narrow role's CONNECTION LIMIT, sized to every narrow pool a box
 *  can open at once, each at NARROW_POOL_MAX (2, gateway/pools.ts): the 12
 *  compose processes that take the app env (24), up to 4 stdio MCP servers
 *  (8, the count the write role's limit leaves room for) and 2 operator
 *  runs (a maintain run and one more CLI, 4). 24 + 8 + 4 = 36.
 *  connection-ceiling.test.ts reads the compose file and fails when that
 *  sum outgrows this limit, or the box's pools outgrow 90% of
 *  max_connections. */
export const NARROW_CONNECTION_LIMIT = 36;

/** What the boot line reads of the narrow role (narrowLoginNote): whether
 *  it may log in, and how many settings are stored on it (ALTER ROLE ...
 *  SET, any database). Null: the role is missing. Readable by any role. */
export async function readNarrowLogin(sql: Sql): Promise<NarrowLoginRow | null> {
  const rows = await sql<NarrowLoginRow[]>`
    select r.rolcanlogin as login,
           (select count(*)::int from pg_catalog.pg_db_role_setting s
             where s.setrole = r.oid) as settings
      from pg_catalog.pg_roles r where r.rolname = ${NARROW_ROLE}`;
  return rows[0] ?? null;
}

/** What readNarrowLogin reads. */
export type NarrowLoginRow = { login: boolean; settings: number };

/** The fix for a narrow role that cannot log in: the boot line and the
 *  narrow route's error both name it. */
export const NARROW_LOGIN_FIX =
  'run migrate as a superuser on Postgres 16 or later, with MANTLE_MASTER_KEY set (it gives mantle_system_narrow its login and password)';

/**
 * The boot line's warning about the narrow role, or null when there is
 * none. `loginPool`: the route logs in as the role (narrowDatabaseUrl not
 * null, outside per-database mode). A role with no login (or none at all)
 * then fails every narrow statement, closed: the line names the fix. A
 * setting stored on the role is named whatever the mode: the narrow
 * pool's startup parameters win over search_path, TimeZone and DateStyle,
 * and the next migrate takes every one back.
 */
export function narrowLoginNote(row: NarrowLoginRow | null, loginPool: boolean): string | null {
  const lines: string[] = [];
  if (loginPool && !row?.login) {
    lines.push(
      `[db] the narrow route logs in as ${NARROW_ROLE}, but it ${
        row ? 'cannot log in' : 'does not exist'
      }: every narrow statement fails until you ${NARROW_LOGIN_FIX}`,
    );
  }
  if (row && row.settings > 0) {
    lines.push(
      `[db] ${NARROW_ROLE} has ${row.settings} stored setting row(s) (ALTER ROLE ... SET): the narrow pool's startup parameters override search_path, TimeZone and DateStyle; the next migrate takes them all back`,
    );
  }
  return lines.length ? lines.join('\n') : null;
}

/** Whether this process's pools log in as the runtime role. */
export function runtimeRoleOn(): boolean {
  return feature('dbRuntimeRole');
}

/**
 * The URL the app's own connections use (the system pool, the LISTEN
 * connections): DATABASE_URL, or with MANTLE_DB_RUNTIME_ROLE on the same
 * server and database as the runtime role. Fails loudly, never falls back
 * to DATABASE_URL, when the switch is on and the role cannot be named.
 */
export function systemDatabaseUrl(): string {
  const url = env('DATABASE_URL');
  if (!url) throw new Error('DATABASE_URL must be set');
  if (!runtimeRoleOn()) return url;
  if (feature('viewerRolesPerDatabase')) {
    throw new Error(
      'MANTLE_DB_RUNTIME_ROLE needs one brain per Postgres cluster: it cannot run with ' +
        'MANTLE_VIEWER_ROLES_PER_DATABASE (docs/runtime-role.md)',
    );
  }
  const key = env('MANTLE_MASTER_KEY');
  if (!key) throw new Error('MANTLE_DB_RUNTIME_ROLE needs MANTLE_MASTER_KEY (the role password)');
  return runtimeDatabaseUrl(url, runtimeRolePassword(key));
}

/** The mode a connection runs in, from DB_ROLE_SQL's row. */
export type DbRoleMode = 'runtime' | 'superuser' | 'other';

export type DbRoleRow = {
  user: string;
  superuser: boolean;
  bypassrls: boolean;
  /** Tables, sequences and functions of the app's schemas the role owns. */
  owns: number;
};

/** Who the connection is: one row, readable by any role. */
export const DB_ROLE_SQL = `
  SELECT r.rolname AS "user", r.rolsuper AS superuser, r.rolbypassrls AS bypassrls,
         ((SELECT count(*)::int FROM pg_catalog.pg_class c
             JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
            WHERE c.relowner = r.oid AND n.nspname IN (${APP_SCHEMAS_SQL})
              AND c.relkind IN ('r', 'p', 'S'))
          + (SELECT count(*)::int FROM pg_catalog.pg_proc p
               JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
              WHERE p.proowner = r.oid AND n.nspname IN (${APP_SCHEMAS_SQL}))) AS owns
    FROM pg_catalog.pg_roles r WHERE r.rolname = current_user`;

/**
 * The integrity row runtime_role_lock (server/web/lib/integrity/audit.ts):
 * one row (id, kind, detail) when mantle_runtime is no longer the lock it
 * was made as, none when it is (or does not exist: a box before A9). Here,
 * beside the roles it names. Also what the lock leans on: the marker present
 * and mantle_owner's, mantle_owner_role() the MEMBER version of 0290 (a
 * skipped 0290 shows here), and no role but mantle_runtime (and a
 * superuser, a member of every role) a member of mantle_owner, directly or
 * through another role: mantle_owner_role() says yes to every such member.
 * And no pg-boss routine the runtime or the narrow role may run
 * (revokePgBossRoutines). afterMigrations logs every row as a warning.
 */
export const RUNTIME_LOCK_SQL = `
  SELECT '${RUNTIME_ROLE}' AS id, 'lock broken' AS kind, x.detail AS detail
  FROM (
    SELECT concat_ws('; ',
      CASE WHEN r.rolsuper THEN 'a superuser' END,
      CASE WHEN r.rolcreaterole THEN 'may create roles' END,
      CASE WHEN r.rolcreatedb THEN 'may create databases' END,
      CASE WHEN EXISTS (SELECT 1 FROM pg_catalog.pg_class c
                          JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
                         WHERE c.relowner = r.oid AND n.nspname IN (${APP_SCHEMAS_SQL}))
           THEN 'owns tables' END,
      CASE WHEN EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
                          JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
                         WHERE p.proowner = r.oid AND n.nspname IN (${APP_SCHEMAS_SQL}))
           THEN 'owns functions' END,
      CASE WHEN has_schema_privilege(r.oid, 'public', 'CREATE') THEN 'may create in public' END,
      (SELECT 'may run pg-boss routines: ' || string_agg(DISTINCT p.proname, ', ' ORDER BY p.proname)
         FROM pg_catalog.pg_proc p
         JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'pgboss'
          AND (has_function_privilege(r.oid, p.oid, 'EXECUTE')
               OR (to_regrole('${NARROW_ROLE}') IS NOT NULL
                   AND has_function_privilege(to_regrole('${NARROW_ROLE}'), p.oid, 'EXECUTE')))),
      CASE WHEN EXISTS (SELECT 1 FROM unnest(ARRAY['${OWNER_ROLE}', '${SYSTEM_ROLE}', '${NARROW_ROLE}']) o(name)
                         WHERE to_regrole(o.name) IS NOT NULL
                           AND pg_has_role(r.oid, to_regrole(o.name), 'USAGE'))
           THEN 'holds the rights of ${OWNER_ROLE}, ${SYSTEM_ROLE} or ${NARROW_ROLE}' END,
      CASE WHEN to_regrole('${OWNER_ROLE}') IS NOT NULL
            AND pg_has_role(r.oid, to_regrole('${OWNER_ROLE}'), 'SET')
           THEN 'may become ${OWNER_ROLE}' END,
      CASE WHEN to_regrole('${OWNER_ROLE}') IS NOT NULL
            AND coalesce((SELECT pg_get_userbyid(p.proowner) FROM pg_catalog.pg_proc p
                           WHERE p.oid = to_regprocedure('${ACL_MARKER_FUNCTION}')), '')
                <> '${OWNER_ROLE}'
           THEN '${ACL_MARKER_FUNCTION} missing or not ${OWNER_ROLE}''s' END,
      CASE WHEN EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
                         WHERE p.oid = to_regprocedure('${OWNER_ROLE_FUNCTION}')
                           AND position('''MEMBER''' IN upper(p.prosrc)) = 0)
           THEN '${OWNER_ROLE_FUNCTION} is not the MEMBER version (migration 0290 not applied): ' ||
                'every write guard refuses ${RUNTIME_ROLE}' END,
      (SELECT 'other members of ${OWNER_ROLE}: ' || string_agg(o.rolname, ', ' ORDER BY o.rolname)
         FROM pg_catalog.pg_roles o
        WHERE to_regrole('${OWNER_ROLE}') IS NOT NULL AND NOT o.rolsuper
          AND o.rolname NOT IN ('${OWNER_ROLE}', '${RUNTIME_ROLE}')
          AND pg_has_role(o.oid, to_regrole('${OWNER_ROLE}'), 'MEMBER'))) AS detail
    FROM pg_catalog.pg_roles r WHERE r.rolname = '${RUNTIME_ROLE}') x
  WHERE x.detail <> ''`;

/** What the integrity row runtime_role_lock says now: its details, none
 *  when the lock is whole (afterMigrations logs each). */
export async function runtimeLockDetails(sql: Sql): Promise<string[]> {
  const rows = (await sql.unsafe(RUNTIME_LOCK_SQL)) as unknown as { detail: string }[];
  return rows.map((r) => r.detail);
}

/** runtime: the runtime role, not a superuser and owning nothing (what A9
 *  wants); superuser: the box before its roll; other: anything else. */
export function dbRoleMode(row: DbRoleRow): DbRoleMode {
  if (row.superuser) return 'superuser';
  if (row.user === RUNTIME_ROLE && row.owns === 0) return 'runtime';
  return 'other';
}

/** A line for the log about the mode, or null when there is nothing to say
 *  (the runtime role, as wanted). */
export function dbRoleNote(row: DbRoleRow, switchOn: boolean): string | null {
  const mode = dbRoleMode(row);
  if (mode === 'runtime') return null;
  // Plan v3.2 S4a: off (unset or 0) is said loudly at every start; the
  // default stays off so no existing box flips (new installs write 1).
  const loud = switchOn ? '' : '[db] SECURITY: MANTLE_DB_RUNTIME_ROLE is unset or 0. ';
  if (mode === 'superuser') {
    return (
      `${loud}[db] the system pool logs in as the superuser "${row.user}": it may alter tables, ` +
      `disable triggers and change the check modes. Set MANTLE_DB_RUNTIME_ROLE=1 to run as ` +
      `${RUNTIME_ROLE} (docs/runtime-role.md).`
    );
  }
  return (
    `${loud}[db] the system pool logs in as "${row.user}"${switchOn ? '' : ' (MANTLE_DB_RUNTIME_ROLE is off)'}` +
    `${row.owns > 0 ? `, which owns ${row.owns} table(s) or function(s)` : ''}: not the runtime role A9 wants ` +
    `(docs/runtime-role.md).`
  );
}

/** One membership: `role` granted to `member` with these options. */
export type Membership = {
  member: string;
  role: string;
  inherit: boolean;
  set: boolean;
};

/**
 * Every membership the runtime roles (RUNTIME_ROLES) may hold, and every one held in them,
 * with its options: any other (a hand grant of mantle_owner with INHERIT,
 * say, or of mantle_runtime to another role), or one of these with other
 * options, is taken back on every run. A member of mantle_runtime is a
 * member of mantle_owner through it, whatever the options, and
 * mantle_owner_role() (0290, MEMBER) says yes to it.
 *
 *  - runtime in mantle_owner: neither INHERIT nor SET. Membership only,
 *    which mantle_owner_role() asks (0290), and none of the owner's rights:
 *    it cannot drop or alter the marker, nor DROP OWNED or REASSIGN OWNED.
 *  - runtime in mantle_system: SET only, and mantle_system in the write
 *    role and the gap writer: SET only. The checked rerun's SET ROLE goes
 *    through it (Postgres 16: a chain of SET options), never directly, so
 *    0277 and 0278 do not count the system pool as the write role's login.
 *    mantle_system owns nothing and holds no right, so SET ROLE to it gains
 *    nothing.
 *  - runtime in mantle_system_narrow: SET only. The narrow route takes it
 *    per transaction (set_config('role', ..., true)); without INHERIT the
 *    runtime role's own rights never mix with it.
 */
export function wantedMemberships(): readonly Membership[] {
  return [
    { member: RUNTIME_ROLE, role: OWNER_ROLE, inherit: false, set: false },
    { member: RUNTIME_ROLE, role: SYSTEM_ROLE, inherit: false, set: true },
    { member: RUNTIME_ROLE, role: NARROW_ROLE, inherit: false, set: true },
    { member: SYSTEM_ROLE, role: viewerRoleName('write'), inherit: false, set: true },
    // TODO(plan v3 S3 part 2, one release later): nothing SETs these two
    // since S3 (the checked rerun is gone); kept one release so a rollback
    // to the image before S3 still finds them (rule 2).
    { member: SYSTEM_ROLE, role: GAP_WRITER_ROLE, inherit: false, set: true },
  ];
}

/** The attributes of each role. Pure. */
function roleAttrs(role: string, password: string | null): string {
  // NOINHERIT: a membership granted without options (a hand GRANT) then
  // defaults to INHERIT FALSE; migrate takes it back all the same.
  if (role === RUNTIME_ROLE) {
    return password
      ? `LOGIN NOSUPERUSER BYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION PASSWORD '${password}'`
      : `NOLOGIN NOSUPERUSER BYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION PASSWORD NULL`;
  }
  // The owner runs a foreign key's check and cascade, and the triggers a
  // cascade fires, as the superuser did: past the row rules, on its own
  // tables and on one migrate left with its old owner (ownTables, busy).
  // Nobody logs in as it, and nobody holds its rights: the runtime role is
  // its member without INHERIT and without SET, and BYPASSRLS is never
  // inherited anyway.
  if (role === OWNER_ROLE) {
    return `NOLOGIN NOSUPERUSER BYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION PASSWORD NULL`;
  }
  // The narrow system role reads and writes past the row rules, as the
  // system pool does, but only where the access matrix lets it
  // (applyNarrowGrants). The narrow route's own pool logs in as it when
  // its password is given (a master key, outside per-database mode).
  if (role === NARROW_ROLE) {
    return password
      ? `LOGIN NOSUPERUSER BYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION CONNECTION LIMIT ${NARROW_CONNECTION_LIMIT} PASSWORD '${password}'`
      : `NOLOGIN NOSUPERUSER BYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION CONNECTION LIMIT ${NARROW_CONNECTION_LIMIT} PASSWORD NULL`;
  }
  return `NOLOGIN ${LOCK_ATTRS} PASSWORD NULL`;
}

/**
 * The statements that bring the runtime roles and their memberships to their
 * wanted state. Pure, so a test can pin the attributes. `existing`: the
 * roles that exist; `password`: the runtime role's (null = no login).
 */
export function runtimeRoleStatements(
  existing: ReadonlySet<string>,
  password: string | null,
  narrowPassword: string | null = null,
): string[] {
  for (const p of [password, narrowPassword]) {
    if (p !== null && !/^[A-Za-z0-9_-]+$/.test(p)) {
      throw new Error('runtime role password is not base64url');
    }
  }
  const out: string[] = [];
  for (const role of RUNTIME_ROLES) {
    const verb = existing.has(role) ? 'ALTER' : 'CREATE';
    const pw = role === RUNTIME_ROLE ? password : role === NARROW_ROLE ? narrowPassword : null;
    out.push(`${verb} ROLE "${role}" WITH ${roleAttrs(role, pw)}`);
  }
  for (const m of wantedMemberships()) out.push(membershipGrant(m));
  return out;
}

/** The GRANT that makes one wanted membership, with its options. */
function membershipGrant(m: Membership): string {
  return (
    `GRANT "${m.role}" TO "${m.member}" WITH INHERIT ${m.inherit ? 'TRUE' : 'FALSE'}, ` +
    `SET ${m.set ? 'TRUE' : 'FALSE'}, ADMIN FALSE`
  );
}

export type RuntimeRolesOutcome = 'ok' | 'not-superuser' | 'old-server';

/** One row of pg_auth_members, by name. */
export type HeldMembership = {
  member: string;
  role: string;
  grantor: string;
  inherit: boolean;
  set: boolean;
  admin: boolean;
};

/** Anything that runs a query string: a pool, or a transaction (a test
 *  takes its own grants back in the transaction that made them). */
type Runner = Pick<postgres.TransactionSql, 'unsafe'>;

/**
 * The order to take memberships back in, from every membership `held` in
 * the same roles: a grant made on the strength of another's ADMIN option
 * (an operator's `GRANT mantle_system TO ops_a WITH ADMIN OPTION`, then
 * ops_a's own grant on to ops_b) before the one it rests on, the far end of
 * a grant chain first. So the CASCADE each revoke carries rarely has
 * anything left to take. Pure; stable for rows of equal depth.
 */
export function revokeOrder<T extends HeldMembership>(
  revoke: readonly T[],
  held: readonly HeldMembership[],
): T[] {
  const depth = (m: HeldMembership, seen: Set<string>): number => {
    const key = `${m.role}\u0000${m.member}\u0000${m.grantor}`;
    if (seen.has(key)) return 0; // a cycle: Postgres refuses one, but never loop
    seen.add(key);
    const parents = held.filter((x) => x.role === m.role && x.member === m.grantor && x.admin);
    return parents.length === 0 ? 0 : 1 + Math.max(...parents.map((p) => depth(p, seen)));
  };
  return revoke
    .map((m, i) => ({ m, i, d: depth(m, new Set()) }))
    .sort((a, b) => b.d - a.d || a.i - b.i)
    .map((x) => x.m);
}

/** pg_auth_members by name: the runtime roles' memberships both ways, or
 *  (`role`) every membership in one role. */
async function readMemberships(sql: Runner, role?: string): Promise<HeldMembership[]> {
  const where = role
    ? 'r.rolname = $1'
    : `u.rolname IN (${RUNTIME_ROLES.map((r) => `'${r}'`).join(', ')})
        OR r.rolname IN (${RUNTIME_ROLES.map((r) => `'${r}'`).join(', ')})`;
  return (await sql.unsafe(
    `select u.rolname as member, r.rolname as role, g.rolname as grantor,
            m.inherit_option as inherit, m.set_option as set, m.admin_option as admin
       from pg_auth_members m
       join pg_roles r on r.oid = m.roleid
       join pg_roles u on u.oid = m.member
       join pg_roles g on g.oid = m.grantor
      where ${where}`,
    role ? [role] : [],
  )) as unknown as HeldMembership[];
}

const membershipKey = (m: { role: string; member: string; grantor: string }) =>
  `${m.role}\u0000${m.member}\u0000${m.grantor}`;

/**
 * Take back every membership the runtime roles hold, and every one held in
 * them, that wantedMemberships does not name with these options (part of
 * ensureRuntimeRoles). Each revoke names its grantor and CASCADEs: an
 * operator's grant WITH ADMIN OPTION that its holder passed on leaves a
 * dependent membership, and without CASCADE Postgres refuses the revoke
 * (2BP01) and migrate, and so the app, would not start. The dependents are
 * memberships in the same role, made on the strength of the one taken back,
 * and go with it; revokeOrder takes them first anyway. Every membership
 * that goes, a dependent too, is one warning (role, member, grantor). A
 * revoke that fails for any other reason is a warning as well, never a
 * failed migrate: the integrity row runtime_role_lock shows what is left.
 * Needs a superuser.
 */
export async function takeBackMemberships(
  sql: Runner,
  warn: (line: string) => void,
): Promise<void> {
  const held = await readMemberships(sql);
  const wanted = wantedMemberships();
  const revoke = held.filter((h) => {
    const w = wanted.find((x) => x.member === h.member && x.role === h.role);
    return !(w && w.inherit === h.inherit && w.set === h.set && !h.admin);
  });
  const gone = new Set<string>();
  for (const h of revokeOrder(revoke, held)) {
    if (gone.has(membershipKey(h))) continue; // went with an earlier CASCADE
    try {
      const before = await readMemberships(sql, h.role);
      if (!before.some((b) => membershipKey(b) === membershipKey(h))) continue;
      await withRoleRetry(() =>
        sql.unsafe(
          `REVOKE ${quotedIdent(h.role)} FROM ${quotedIdent(h.member)} ` +
            `GRANTED BY ${quotedIdent(h.grantor)} CASCADE`,
        ),
      );
      const after = new Set((await readMemberships(sql, h.role)).map(membershipKey));
      for (const b of before) {
        if (after.has(membershipKey(b))) continue;
        gone.add(membershipKey(b));
        warn(
          `  WARNING membership taken back: ${b.role} from ${b.member} (granted by ${b.grantor})` +
            (membershipKey(b) === membershipKey(h) ? '' : ', with the grant it rested on'),
        );
      }
    } catch (err) {
      warn(
        `  WARNING could not take back ${h.role} from ${h.member} (granted by ${h.grantor}): ` +
          `${errorMessage(err)}; ` +
          'the integrity row runtime_role_lock shows what is left',
      );
    }
  }
}

/**
 * Make the runtime roles and their memberships (runtimeRoleStatements), and
 * take back any other membership they hold or another role holds in them,
 * or one with other options. The
 * runtime role logs in only when `login` (migrate: MANTLE_DB_RUNTIME_ROLE
 * on), with a master key and outside per-database mode; otherwise it is
 * NOLOGIN with no password, so switching the switch off closes the login at
 * the next migrate. The narrow role logs in whenever there is a master key
 * outside per-database mode (the narrow route is always on). Needs a superuser (a BYPASSRLS role is a superuser's to
 * make): any other caller changes nothing and gets 'not-superuser'.
 * Postgres 16 or later (membership options). Before the migrations: they
 * and the grants name the roles. `warn`: each membership taken back
 * (takeBackMemberships); console.warn when not given.
 */
export async function ensureRuntimeRoles(
  sql: Sql,
  masterKey: string | null,
  opts: {
    login: boolean;
    perDatabase?: boolean;
    warn?: (line: string) => void;
  },
): Promise<RuntimeRolesOutcome> {
  const [me] = await sql<{ su: boolean; v: number }[]>`
    select r.rolsuper as su, current_setting('server_version_num')::int as v
      from pg_roles r where r.rolname = current_user`;
  if (!me?.su) return 'not-superuser';
  if (me.v < 160000) return 'old-server';
  // The roles these memberships name: the write role and the gap writer
  // are made by ensureViewerRoles and syncGapWriterRights; a fresh cluster
  // may not have the gap writer yet.
  const gap = await sql<{ n: number }[]>`
    select count(*)::int as n from pg_roles where rolname = ${GAP_WRITER_ROLE}`;
  if ((gap[0]?.n ?? 0) === 0) {
    await withRoleRetry(() =>
      sql
        .unsafe(`CREATE ROLE "${GAP_WRITER_ROLE}" WITH NOLOGIN ${LOCK_ATTRS} PASSWORD NULL`)
        .catch((err: Error) => {
          if (!/already exists/.test(err.message)) throw err;
        }),
    );
  }
  const rows = await sql<{ rolname: string }[]>`
    select rolname from pg_roles where rolname = any(${[...RUNTIME_ROLES]}::text[])`;
  const password =
    opts.login && masterKey && !opts.perDatabase ? runtimeRolePassword(masterKey) : null;
  const narrowPassword = masterKey && !opts.perDatabase ? narrowRolePassword(masterKey) : null;
  const statements = runtimeRoleStatements(
    new Set(rows.map((r) => r.rolname)),
    password,
    narrowPassword,
  );
  // The wanted memberships first: a GRANT sets the options of its own row
  // in place, so a wanted membership held with the wrong options (a hand
  // GRANT ... WITH INHERIT TRUE) is put right without ever being taken
  // away. Taking it back first left a moment in which the runtime role
  // could not become the narrow or the system role, cluster-wide: every
  // database's SET ROLE then failed with 42501 while the old app served
  // (and a test file beside a migrating one met it).
  // Each one whose two roles exist (a first run makes the runtime roles
  // below, with no membership yet to put right).
  const wanted = wantedMemberships();
  const named = [...new Set(wanted.flatMap((m) => [m.member, m.role]))];
  const present = new Set(
    (
      await sql<{ rolname: string }[]>`
        select rolname from pg_roles where rolname = any(${named}::text[])`
    ).map((r) => r.rolname),
  );
  for (const m of wanted) {
    if (present.has(m.member) && present.has(m.role)) {
      await runRoleStatement(sql, membershipGrant(m), true);
    }
  }
  // Then every membership still wrong (another grantor's row, an ADMIN
  // option, a role the runtime roles should not hold or be held by), and
  // the roles and the wanted memberships again: a row the take-back had
  // to remove is made again at once.
  await takeBackMemberships(sql, opts.warn ?? ((line) => console.warn(line)));
  for (const stmt of statements) {
    await runRoleStatement(sql, stmt, true);
  }
  await resetNarrowRoleSettings(sql);
  return 'ok';
}

/**
 * Take back every setting stored on the narrow role (ALTER ROLE ... SET,
 * for every database and for each one): its own login may store them on
 * itself (a search_path, a timeout), and they would reach every later
 * narrow session. Each migrate run, with the password set again above (a
 * password the login changed on itself is the derived one again). A
 * superuser's work (ensureRuntimeRoles).
 */
async function resetNarrowRoleSettings(sql: Sql): Promise<void> {
  await runRoleStatement(sql, `ALTER ROLE "${NARROW_ROLE}" RESET ALL`, true);
  const rows = await sql<{ db: string }[]>`
    select d.datname as db from pg_catalog.pg_db_role_setting s
      join pg_catalog.pg_roles r on r.oid = s.setrole
      join pg_catalog.pg_database d on d.oid = s.setdatabase
     where r.rolname = ${NARROW_ROLE}`;
  for (const { db } of rows) {
    await runRoleStatement(
      sql,
      `ALTER ROLE "${NARROW_ROLE}" IN DATABASE "${db.replace(/"/g, '""')}" RESET ALL`,
      true,
    );
  }
}

/** The outcome of one ownership change (ownTables). `busy`: left for the
 *  next run because a lock was not to be had in time. */
export type OwnOutcome = {
  owned: string[];
  failed: { rel: string; error: string; busy: boolean }[];
};

/** How long ownTables waits for one table's lock: the old app still serves
 *  while compose's migrate runs, and every statement queued behind an
 *  ALTER ... OWNER waits with it. */
export const OWN_LOCK_TIMEOUT = '200ms';

/** The batch's whole budget: past it, the batch gives up (rolling back,
 *  so every lock it took is let go) and each table goes on its own. */
const OWN_BATCH_BUDGET_MS = 1_000;

/** A lock not to be had within lock_timeout. */
function isBusy(err: unknown): boolean {
  return (err as { code?: string })?.code === '55P03';
}

/** "tuple concurrently updated": two sessions changing the same catalog
 *  row (a GRANT on the table in another migrate or test). Idempotent, so
 *  tried again; any other internal error is not. */
function isConcurrentUpdate(err: unknown): boolean {
  const e = err as { code?: string; message?: string };
  return e?.code === 'XX000' && /tuple concurrently updated/.test(e.message ?? '');
}

/**
 * Hand every table and sequence of the app's schemas, and the marker
 * mantle_acl_internal() (made again first when missing or changed,
 * ensureAclMarker), to mantle_owner. Never fails the run.
 *
 * ALTER ... OWNER takes the table's strongest lock, and on a box this runs
 * while the old app still serves (compose's migrate). So: all in one
 * transaction first (a fresh database or a quiet box: one commit), each lock
 * waited for at most OWN_LOCK_TIMEOUT and the whole batch at most
 * OWN_BATCH_BUDGET_MS; past either it rolls back, letting every lock go,
 * and each change goes on its own with the same short wait, tried three
 * times. A table still busy then is left for the next migrate (`busy`).
 * Ownership is not the runtime role's lock (it never owns anything, whoever
 * does), and mantle_owner, which runs a foreign key's cascade and the
 * triggers it fires, holds every right on such a table (applyRuntimeGrants)
 * and BYPASSRLS, so it reads there what it reads on its own: a table left
 * behind is untidy, not a hole. A sequence a column owns (serial, identity)
 * moves with its table. Needs a superuser.
 */
export async function ownTables(sql: Sql): Promise<OwnOutcome> {
  const out: OwnOutcome = { owned: [], failed: [] };
  await ensureAclMarker(sql);
  const rels = await sql<{ rel: string; kind: string }[]>`
    select c.oid::regclass::text as rel, c.relkind::text as kind
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = any(${[...APP_SCHEMAS]}::text[])
       and c.relkind in ('r', 'p', 'S')
       and c.relowner <> (select oid from pg_roles where rolname = ${OWNER_ROLE})
       and not exists (select 1 from pg_depend d
                        where d.classid = 'pg_class'::regclass and d.objid = c.oid
                          and d.deptype = 'e')
       and not (c.relkind = 'S' and exists (
             select 1 from pg_depend d
              where d.classid = 'pg_class'::regclass and d.objid = c.oid
                and d.refclassid = 'pg_class'::regclass and d.deptype in ('a', 'i')))
     order by 1`;
  const change = async (stmt: string, rel: string) => {
    try {
      // Three tries, 50 then 100 ms apart (plus jitter), on a busy lock or
      // a concurrent catalog update only.
      await withRetry(
        () =>
          sql.begin(async (tx) => {
            await tx.unsafe(`set local lock_timeout = '${OWN_LOCK_TIMEOUT}'`);
            await tx.unsafe(stmt);
          }),
        {
          retries: 2,
          retryOn: ({ error }) => isBusy(error) || isConcurrentUpdate(error),
          delayMs: (retry) => backoffMs(retry - 1, { baseMs: 50, jitter: 'quarter' }),
        },
      );
      out.owned.push(rel);
    } catch (err) {
      out.failed.push({
        rel,
        error: errorMessage(err),
        busy: isBusy(err),
      });
    }
  };
  const alter = ({ rel, kind }: { rel: string; kind: string }) =>
    `ALTER ${kind === 'S' ? 'SEQUENCE' : 'TABLE'} ${rel} OWNER TO "${OWNER_ROLE}"`;
  const items = rels.map((r) => ({ rel: r.rel, stmt: alter(r) }));
  const [marker] = await sql<{ owner: string | null }[]>`
    select (select pg_get_userbyid(p.proowner) from pg_proc p
             where p.oid = to_regprocedure(${ACL_MARKER_FUNCTION})) as owner`;
  if (marker?.owner && marker.owner !== OWNER_ROLE) {
    items.push({
      rel: ACL_MARKER_FUNCTION,
      stmt: `ALTER FUNCTION ${ACL_MARKER_FUNCTION} OWNER TO "${OWNER_ROLE}"`,
    });
  }
  let batched = false;
  if (items.length > 1) {
    const started = Date.now();
    try {
      await sql.begin(async (tx) => {
        await tx.unsafe(`set local lock_timeout = '${OWN_LOCK_TIMEOUT}'`);
        for (const it of items) {
          if (Date.now() - started > OWN_BATCH_BUDGET_MS) throw new Error('batch budget');
          await tx.unsafe(it.stmt);
        }
      });
      out.owned.push(...items.map((it) => it.rel));
      batched = true;
    } catch {
      // Rolled back, every lock let go: one by one below.
    }
  }
  if (!batched) for (const it of items) await change(it.stmt, it.rel);
  return out;
}

/**
 * Make mantle_acl_internal() again, as 0241 made it, when it is missing or
 * changed (another body, volatility, a definer, a setting): every write
 * guard asks mantle_owner_role(), which errors without it. The superuser
 * replaces it; ownTables then hands it to mantle_owner. A database before
 * 0241 (no mantle_owner_role) is left alone. Returns whether it was made.
 */
export async function ensureAclMarker(sql: Sql): Promise<boolean> {
  const [m] = await sql<{ ok: boolean }[]>`
    select to_regprocedure('public.mantle_owner_role()') is null or coalesce((
      select btrim(p.prosrc, E' \n\t\r') = btrim(${ACL_MARKER_BODY}, E' \n\t\r')
             and p.provolatile = 's' and p.proparallel = 's' and not p.prosecdef
             and p.proconfig is null and p.prorettype = 'boolean'::regtype
             and l.lanname = 'sql'
        from pg_proc p join pg_language l on l.oid = p.prolang
       where p.oid = to_regprocedure(${ACL_MARKER_FUNCTION})), false) as ok`;
  if (m?.ok) return false;
  await sql.unsafe(
    `CREATE OR REPLACE FUNCTION ${ACL_MARKER_FUNCTION}\n` +
      `  RETURNS boolean LANGUAGE sql STABLE PARALLEL SAFE SECURITY INVOKER AS $$${ACL_MARKER_BODY}$$`,
  );
  // CREATE OR REPLACE keeps what ALTER FUNCTION ... SET added: reset it.
  await sql.unsafe(`ALTER FUNCTION ${ACL_MARKER_FUNCTION} RESET ALL`);
  return true;
}

/** The functions of RUNTIME_DENIED_FUNCTIONS that exist here. */
async function deniedFunctionsPresent(sql: Sql): Promise<string[]> {
  const rows = await sql<{ fn: string | null }[]>`
    select to_regprocedure(n)::text as fn from unnest(${Object.keys(RUNTIME_DENIED_FUNCTIONS)}::text[]) n`;
  return rows.map((r) => r.fn).filter((f): f is string => !!f);
}

/** The viewer roles (the scoped pools and the gap writer): what any of
 *  them may run, the runtime role may run. */
function viewerRoles(): string[] {
  return [...POOL_ROLES.map((r) => viewerRoleName(r)), GAP_WRITER_ROLE];
}

/**
 * The functions of APP_SCHEMAS the runtime role is granted EXECUTE on
 * (it runs what PUBLIC may run anyway, as every role): every one a viewer
 * role may run that PUBLIC may not, and RUNTIME_SYSTEM_FUNCTIONS, never one
 * of RUNTIME_DENIED_FUNCTIONS. An allowlist: a function a migration takes
 * from PUBLIC and gives to no viewer role is not the runtime role's until a
 * line in RUNTIME_SYSTEM_FUNCTIONS says why. Read after the denials are
 * taken from PUBLIC and the viewer roles.
 */
export async function runtimeFunctionAllowlist(
  sql: Sql,
  except: readonly string[] = [],
): Promise<string[]> {
  const rows = await sql<{ fn: string }[]>`
    select p.oid::regprocedure::text as fn
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = any(${[...APP_SCHEMAS]}::text[])
       and not has_function_privilege('public', p.oid, 'EXECUTE')
       and (exists (select 1 from unnest(${viewerRoles()}::text[]) v
                     where to_regrole(v) is not null
                       and has_function_privilege(to_regrole(v), p.oid, 'EXECUTE'))
            or p.oid in (select to_regprocedure(x)
                           from unnest(${Object.keys(RUNTIME_SYSTEM_FUNCTIONS)}::text[]) x))
       and p.oid not in (select to_regprocedure(x)
                           from unnest(${[...Object.keys(RUNTIME_DENIED_FUNCTIONS), ...except]}::text[]) x
                          where to_regprocedure(x) is not null)
     order by 1`;
  return rows.map((r) => r.fn);
}

/** The functions the narrow system role is granted EXECUTE on:
 *  NARROW_SYSTEM_FUNCTIONS that are on the runtime role's allowlist, never
 *  one of NARROW_DENIED_FUNCTIONS. */
export async function narrowFunctionAllowlist(sql: Sql): Promise<string[]> {
  const runtime = await runtimeFunctionAllowlist(sql, Object.keys(NARROW_DENIED_FUNCTIONS));
  const want = await sql<{ fn: string }[]>`
    select to_regprocedure(x)::text as fn
      from unnest(${Object.keys(NARROW_SYSTEM_FUNCTIONS)}::text[]) x
     where to_regprocedure(x) is not null`;
  const named = new Set(want.map((r) => r.fn));
  return runtime.filter((f) => named.has(f));
}

/**
 * The runtime role's rights in this database, made equal to the wanted set
 * on every run (as applyViewerGrants does the viewer roles'): everything it
 * holds on the app's tables, sequences and functions is revoked, then
 * SELECT, INSERT, UPDATE and DELETE on every table but runtimeDeniedTables
 * (SELECT only on runtimeReadOnlyTables),
 * USAGE, SELECT and UPDATE on every sequence, EXECUTE on the allowlist
 * (runtimeFunctionAllowlist; RUNTIME_DENIED_FUNCTIONS are also taken from
 * PUBLIC and every viewer role), CONNECT on the database, and default
 * privileges so a table a later migration makes is the runtime role's at
 * once. CREATE on public is taken from PUBLIC: the runtime role may make
 * nothing there. TEMPORARY on the database is taken from PUBLIC too and
 * granted to none: no role the app runs as makes a temporary object; a
 * narrow role that still holds it afterwards (a migrator that does not own
 * the database only gets a warning from the REVOKE) fails the run. EXECUTE
 * on pg-boss's routines is taken from PUBLIC (revokePgBossRoutines), and
 * on the large-object creators (revokeLargeObjectCreators).
 *
 * And mantle_owner's: USAGE on the schemas, every right on the tables and
 * EXECUTE on every function. Nobody logs in as it, but Postgres runs a
 * foreign key's check and its cascade as the owner of the table queried,
 * and the triggers a cascade fires as that owner too: as the superuser's
 * tables these ran as the superuser, so the owner must reach what they
 * reach (auth's tables, the functions taken from PUBLIC). One transaction.
 */
/** The LIKE pattern of the system schemas (pg_catalog, pg_toast, ...): an
 *  escaped underscore, so `pgboss` is not one (the re-audit's DB
 *  LOW-3: written 'pg\_%' inside a JS template it reached Postgres as
 *  'pg_%', where `_` is any one character, and pg-boss's schema kept
 *  PUBLIC's CREATE). Sent as a parameter: the text is exactly this. */
export const SYSTEM_SCHEMA_LIKE = 'pg\\_%';

/** The default-privilege entries that name PUBLIC (grantee 0) or the narrow
 *  role, but Postgres's own defaults restated in a global entry. */
export function defaultAclEntries(sql: Sql): Promise<DefaultAclRow[]> {
  return sql<DefaultAclRow[]>`
    select pg_get_userbyid(d.defaclrole) as owner, n.nspname as schema,
           d.defaclobjtype::text as objtype,
           case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end as grantee
      from pg_default_acl d
      left join pg_namespace n on n.oid = d.defaclnamespace
      cross join lateral aclexplode(d.defaclacl) a
     where (a.grantee = 0 or a.grantee = (select oid from pg_roles where rolname = ${NARROW_ROLE}))
       and not (a.grantee = 0 and d.defaclnamespace = 0
                and ((d.defaclobjtype = 'f' and a.privilege_type = 'EXECUTE')
                  or (d.defaclobjtype = 'T' and a.privilege_type = 'USAGE')))
     group by 1, 2, 3, 4`;
}

export type DefaultAclRow = {
  owner: string;
  schema: string | null;
  objtype: string;
  grantee: string;
};

/** The REVOKE of one default-privilege entry (DEFAULT_ACL_SQL's row). */
export function defaultAclRevoke(r: DefaultAclRow): string {
  const kinds: Record<string, string> = {
    r: 'TABLES',
    S: 'SEQUENCES',
    f: 'FUNCTIONS',
    T: 'TYPES',
    n: 'SCHEMAS',
  };
  const kind = kinds[r.objtype];
  if (!kind) throw new Error(`unknown default ACL object type ${r.objtype}`);
  const where = r.schema && kind !== 'SCHEMAS' ? ` IN SCHEMA ${quotedIdent(r.schema)}` : '';
  const who = r.grantee === 'PUBLIC' ? 'PUBLIC' : quotedIdent(r.grantee);
  return `ALTER DEFAULT PRIVILEGES FOR ROLE ${quotedIdent(r.owner)}${where} REVOKE ALL ON ${kind} FROM ${who}`;
}

export async function applyRuntimeGrants(sql: Sql): Promise<void> {
  const rt = `"${RUNTIME_ROLE}"`;
  const schemas = APP_SCHEMAS.join(', ');
  const viewers = viewerRoles()
    .map((r) => `"${r}"`)
    .join(', ');
  await withRoleRetry(() =>
    sql.begin(async (tx) => {
      const [db] = await tx<{ name: string; me: string }[]>`
        select current_database() as name, current_user as me`;
      await tx.unsafe(`REVOKE CREATE ON SCHEMA public FROM PUBLIC`);
      const dbName = quotedIdent(db!.name);
      await tx.unsafe(`REVOKE TEMPORARY ON DATABASE ${dbName} FROM PUBLIC, "${NARROW_ROLE}"`);
      const [temp] = await tx<{ held: boolean }[]>`
        select has_database_privilege(${NARROW_ROLE}, current_database(), 'TEMP') as held`;
      if (temp!.held) {
        throw new Error(
          `${NARROW_ROLE} still holds TEMPORARY on database ${dbName} after the REVOKE: ` +
            'run migrate as the database owner or a superuser',
        );
      }
      await tx.unsafe(`GRANT CONNECT ON DATABASE ${dbName} TO ${rt}`);
      // PUBLIC holds nothing on the app's tables, and EXECUTE on no
      // definer but NARROW_PUBLIC_DEFINERS (the only one a fresh migrate
      // leaves PUBLIC's). The full re-audit found a hand GRANT ... TO PUBLIC
      // on a table and on a definer surviving two migrates; every role is a
      // member of PUBLIC, the narrow login too. A fresh migrate grants
      // PUBLIC neither, so this changes nothing there.
      await tx.unsafe(`REVOKE ALL ON ALL TABLES IN SCHEMA ${schemas} FROM PUBLIC`);
      // Nor a sequence (a nextval or setval on an app sequence) nor CREATE
      // in any schema but the system's own (round 13b, the re-audit's DB
      // LOW-4): a fresh migrate grants PUBLIC neither on an app schema, so
      // this changes nothing there; a hand grant is taken back every run.
      // The roles that need a sequence hold their own grant (the runtime
      // role's, the write role's, the narrow role's measured ones).
      await tx.unsafe(`REVOKE ALL ON ALL SEQUENCES IN SCHEMA ${schemas} FROM PUBLIC`);
      const createSchemas = await tx<{ s: string }[]>`
        select quote_ident(n.nspname) as s from pg_namespace n
         where n.nspname not like ${SYSTEM_SCHEMA_LIKE} and n.nspname <> 'information_schema'
           and has_schema_privilege('public', n.oid, 'CREATE')`;
      for (const { s } of createSchemas)
        await tx.unsafe(`REVOKE CREATE ON SCHEMA ${s} FROM PUBLIC`);
      // Default privileges naming PUBLIC or the narrow role (the
      // re-audit's DB LOW-3): a hand ALTER DEFAULT PRIVILEGES ... TO PUBLIC
      // would hand every object a later migration makes to every role
      // before this step takes it back. Each such entry is revoked; the
      // built-in defaults restated in a global entry (EXECUTE on functions,
      // USAGE on types, to PUBLIC) are Postgres's own and stay.
      for (const r of await defaultAclEntries(tx as unknown as Sql)) {
        await tx.unsafe(defaultAclRevoke(r));
      }
      const publicDefiners = await tx<{ fn: string }[]>`
        select p.oid::regprocedure::text as fn
          from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = any(${[...APP_SCHEMAS]}::text[]) and p.prosecdef
           and has_function_privilege('public', p.oid, 'EXECUTE')
           and p.oid not in (select to_regprocedure(x)
                               from unnest(${Object.keys(NARROW_PUBLIC_DEFINERS)}::text[]) x
                              where to_regprocedure(x) is not null)`;
      for (const { fn } of publicDefiners) {
        await tx.unsafe(`REVOKE EXECUTE ON FUNCTION ${fn} FROM PUBLIC`);
      }
      // Temporary objects: PUBLIC has TEMPORARY on a database by default, so
      // every role (the narrow role too) could make a function in pg_temp
      // and call it, code no text check reads. No role the app runs as
      // makes a temporary object (the measured suites: none), so it is
      // granted to none; the migrator keeps it as the database's owner or a
      // superuser. Here and not in a migration: the database's name is the
      // box's own, and a restore into a fresh database (no --create) starts
      // with PUBLIC's default again, which the next migrate takes back.
      const ow = `"${OWNER_ROLE}"`;
      await tx.unsafe(`GRANT USAGE ON SCHEMA ${schemas} TO ${ow}`);
      await tx.unsafe(`GRANT ALL ON ALL TABLES IN SCHEMA ${schemas} TO ${ow}`);
      await tx.unsafe(`GRANT ALL ON ALL SEQUENCES IN SCHEMA ${schemas} TO ${ow}`);
      await tx.unsafe(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA ${schemas} TO ${ow}`);
      await tx.unsafe(`GRANT USAGE ON SCHEMA ${schemas} TO ${rt}`);
      await tx.unsafe(`REVOKE ALL ON ALL TABLES IN SCHEMA ${schemas} FROM ${rt}`);
      await tx.unsafe(`REVOKE ALL ON ALL SEQUENCES IN SCHEMA ${schemas} FROM ${rt}`);
      await tx.unsafe(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${schemas} TO ${rt}`,
      );
      await tx.unsafe(`GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA ${schemas} TO ${rt}`);
      const denied = await tx<{ t: string }[]>`
        select c.oid::regclass::text as t from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where n.nspname || '.' || c.relname = any(${runtimeDeniedTables()}::text[])`;
      for (const { t } of denied) await tx.unsafe(`REVOKE ALL ON ${t} FROM ${rt}`);
      const readOnly = await tx<{ t: string }[]>`
        select c.oid::regclass::text as t from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where n.nspname || '.' || c.relname = any(${runtimeReadOnlyTables()}::text[])`;
      for (const { t } of readOnly) {
        await tx.unsafe(`REVOKE INSERT, UPDATE, DELETE ON ${t} FROM ${rt}`);
      }
      for (const fn of await deniedFunctionsPresent(tx as unknown as Sql)) {
        await tx.unsafe(`REVOKE ALL ON FUNCTION ${fn} FROM PUBLIC, ${rt}, ${viewers}`);
      }
      // Functions: an allowlist, not every function less a denylist.
      await tx.unsafe(`REVOKE ALL ON ALL ROUTINES IN SCHEMA ${schemas} FROM ${rt}`);
      const allowed = await runtimeFunctionAllowlist(tx as unknown as Sql);
      if (allowed.length > 0) {
        await tx.unsafe(`GRANT EXECUTE ON ROUTINE ${allowed.join(', ')} TO ${rt}`);
      }
      // pg-boss's own schema (it stays the migrator's: pg-boss makes
      // partitions at run time): read only, for the queue counts the app
      // shows (provider-alerts.ts, ocr-rescan.ts, the integrity page). Made
      // here when missing (pg-boss installs into it: CREATE SCHEMA IF NOT
      // EXISTS, then its version table), so the default privileges cover the
      // tables pgboss:init makes after this migrate on a fresh box.
      await tx.unsafe(`CREATE SCHEMA IF NOT EXISTS pgboss`);
      await revokePgBossRoutines(tx);
      await revokeLargeObjectCreators(tx);
      await tx.unsafe(`GRANT USAGE ON SCHEMA pgboss TO ${rt}`);
      await tx.unsafe(`GRANT SELECT ON ALL TABLES IN SCHEMA pgboss TO ${rt}`);
      await tx.unsafe(
        `ALTER DEFAULT PRIVILEGES FOR ROLE "${db!.me}" IN SCHEMA pgboss GRANT SELECT ON TABLES TO ${rt}`,
      );
      await applyNarrowGrants(tx as unknown as Sql);
      // Objects a later migration makes (as this role, or as mantle_owner)
      // are the runtime role's at once; the next run applies the denials.
      await tx.unsafe(
        `ALTER DEFAULT PRIVILEGES FOR ROLE "${db!.me}" IN SCHEMA ${schemas} ` +
          `GRANT EXECUTE ON FUNCTIONS TO ${ow}`,
      );
      for (const owner of [db!.me, OWNER_ROLE]) {
        await tx.unsafe(
          `ALTER DEFAULT PRIVILEGES FOR ROLE "${owner}" IN SCHEMA ${schemas} ` +
            `GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${rt}`,
        );
        await tx.unsafe(
          `ALTER DEFAULT PRIVILEGES FOR ROLE "${owner}" IN SCHEMA ${schemas} ` +
            `GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO ${rt}`,
        );
      }
    }),
  );
}

/**
 * The narrow system role's rights, made equal to the access matrix on every
 * run, inside applyRuntimeGrants' transaction: everything it holds on the
 * app's tables, sequences and functions is revoked, then SELECT, INSERT,
 * UPDATE and DELETE on narrowWriteTables, SELECT on narrowReadOnlyTables,
 * USAGE and SELECT on the sequences those write tables draw from (owned by
 * a column, or named in a column default), EXECUTE on
 * narrowFunctionAllowlist, USAGE on the app's schemas, and SELECT on
 * pg-boss's tables (the queue counts). No default privileges: a table a
 * later migration makes is closed to it until the next migrate grants what
 * the matrix says, and a table the matrix does not list never opens.
 */
async function applyNarrowGrants(tx: Sql): Promise<void> {
  const nr = `"${NARROW_ROLE}"`;
  const schemas = APP_SCHEMAS.join(', ');
  await tx.unsafe(`GRANT USAGE ON SCHEMA ${schemas} TO ${nr}`);
  await tx.unsafe(`REVOKE ALL ON ALL TABLES IN SCHEMA ${schemas} FROM ${nr}`);
  await tx.unsafe(`REVOKE ALL ON ALL SEQUENCES IN SCHEMA ${schemas} FROM ${nr}`);
  await tx.unsafe(`REVOKE ALL ON ALL ROUTINES IN SCHEMA ${schemas} FROM ${nr}`);
  const presentNamed = async (tables: string[]) =>
    await tx<{ t: string; name: string }[]>`
        select c.oid::regclass::text as t, n.nspname || '.' || c.relname as name
          from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where n.nspname || '.' || c.relname = any(${tables}::text[]) order by 1`;
  for (const { t, name } of await presentNamed(narrowWriteTables())) {
    // SELECT on every table the role may touch; writes only as the measured
    // allowlist says (NARROW_WRITES): INSERT where listed, UPDATE of the
    // listed columns (always column-level), DELETE where listed. A table
    // not listed stays read only.
    const w = NARROW_WRITES[name];
    const table = ['SELECT', ...(w?.insert ? ['INSERT'] : []), ...(w?.delete ? ['DELETE'] : [])];
    await tx.unsafe(`GRANT ${table.join(', ')} ON ${t} TO ${nr}`);
    if (!w || w.update.length === 0) continue;
    // Only the columns this schema has: migrate's grants also run on an
    // older schema (a box before the migration that adds a column).
    const have = new Set(
      (
        await tx<{ c: string }[]>`
          select attname::text as c from pg_attribute
           where attrelid = ${t}::regclass and attnum > 0 and not attisdropped`
      ).map((r) => r.c),
    );
    const list = w.update
      .filter((c) => have.has(c))
      .map((c) => `"${c}"`)
      .join(', ');
    if (list) await tx.unsafe(`GRANT UPDATE (${list}) ON ${t} TO ${nr}`);
  }
  for (const { t } of await presentNamed(narrowReadOnlyTables())) {
    await tx.unsafe(`GRANT SELECT ON ${t} TO ${nr}`);
  }
  const seqs = await tx<{ seq: string }[]>`
    select distinct s.oid::regclass::text as seq
      from pg_depend d
      join pg_class s on s.oid = d.refobjid and s.relkind = 'S'
      join pg_attrdef ad on d.classid = 'pg_attrdef'::regclass and ad.oid = d.objid
      join pg_class t on t.oid = ad.adrelid
      join pg_namespace tn on tn.oid = t.relnamespace
     where tn.nspname || '.' || t.relname = any(${narrowInsertTables()}::text[])
    union
    select distinct s.oid::regclass::text
      from pg_depend d
      join pg_class s on s.oid = d.objid and s.relkind = 'S'
      join pg_class t on t.oid = d.refobjid
      join pg_namespace tn on tn.oid = t.relnamespace
     where d.classid = 'pg_class'::regclass and d.deptype in ('a', 'i')
       and tn.nspname || '.' || t.relname = any(${narrowInsertTables()}::text[])
     order by 1`;
  for (const { seq } of seqs) await tx.unsafe(`GRANT USAGE, SELECT ON SEQUENCE ${seq} TO ${nr}`);
  const allowed = await narrowFunctionAllowlist(tx);
  if (allowed.length > 0) {
    await tx.unsafe(`GRANT EXECUTE ON ROUTINE ${allowed.join(', ')} TO ${nr}`);
  }
  // pg-boss's schema exists here (applyRuntimeGrants made it first).
  await tx.unsafe(`GRANT USAGE ON SCHEMA pgboss TO ${nr}`);
  await tx.unsafe(`REVOKE ALL ON ALL TABLES IN SCHEMA pgboss FROM ${nr}`);
  await tx.unsafe(`GRANT SELECT ON ALL TABLES IN SCHEMA pgboss TO ${nr}`);
}

/** The report branch's triggers 0341 drops: the would-refuse count's
 *  derived ones (0320; migrate made them from the narrow role's grants up to
 *  0.400.15) and the cascade count's (0312, on auth.users, spaces and
 *  agents). */
const REPORT_TRIGGERS = [
  'mantle_narrow_would_refuse_ins',
  'mantle_narrow_would_refuse_del',
  'mantle_narrow_would_refuse_upd',
  'mantle_narrow_cascade',
] as const;

/**
 * Drop the report branch's triggers (the would-refuse count's derived ones
 * and the cascade count's) table by table, before the pending migrations
 * (migrate-runner.ts applyJournal): 0341 drops their functions, and one
 * transaction taking the lock of every table that holds one (about 120)
 * while the old app still serves (compose's migrate) could stall its
 * writes or deadlock with them. Each table in its own
 * transaction, waiting at most 3 s for its lock, tried again on a lock wait
 * or a deadlock (eight tries, a second apart); 0341 drops whatever is
 * left. One catalog read, finding none, on a database past 0341 or a
 * fresh one. Returns how many tables it changed.
 */
export async function dropNarrowWouldRefuse(sql: Sql): Promise<number> {
  const tables = await sql<{ t: string; names: string[] }[]>`
    select g.tgrelid::regclass::text as t, array_agg(g.tgname::text order by g.tgname) as names
      from pg_trigger g
     where not g.tgisinternal and g.tgname = any(${[...REPORT_TRIGGERS]}::text[])
     group by 1 order by 1`;
  for (const { t, names } of tables) {
    await withRetry(
      () =>
        sql.begin(async (tx) => {
          await tx.unsafe(`SET LOCAL lock_timeout = '3s'`);
          for (const name of REPORT_TRIGGERS) {
            if (names.includes(name)) await tx.unsafe(`DROP TRIGGER IF EXISTS "${name}" ON ${t}`);
          }
        }),
      {
        retries: 7,
        retryOn: ({ error }) =>
          ['55P03', '40P01'].includes((error as { code?: string }).code ?? ''),
        delayMs: () => 1000,
      },
    );
  }
  return tables.length;
}
