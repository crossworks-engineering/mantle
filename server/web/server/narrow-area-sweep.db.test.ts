/**
 * The ONE narrow area-route sweep (plan v3.2 S7b part b2): every writing
 * area row of the route table (narrow-area-sweep.entries.ts, one entry per
 * row, checked against the table by narrow-area-sweep.entries.test.ts)
 * driven through the real app (createApp) as an Admin user with a signed
 * session cookie, on a fresh brain: no statement may be refused by the
 * narrow role (takeNarrowDenials, per row), and every row answers 2xx but
 * the named ones (NOT_2XX). Plan v3.2 S7c closed the content tables to the
 * narrow role (reads too): a row that reads an item on its narrow exit is
 * refused here. MANTLE_SWEEP_REPORT=<file> writes each row's answer (its
 * status and its body, less ids, stamps and minted tokens), so two builds'
 * answers can be compared.
 *
 * The fixture holds rows at the sample id the paths carry (an assistant, a
 * tool group, a skill, a member login), so the PATCH, DELETE and action
 * rows reach their writes, and a documentation collection on a real
 * markdown file: made (the docs-item insert through the structure
 * definer), then the file edited and the collection re-read (its update).
 * No network (fetch throws), no updater, no sandbox daemon: those rows
 * answer their own refusal (the push relay and the sandbox daemon answer
 * here).
 *
 * Round 10 (D 1, D 2): each row's record of what the narrow login itself
 * wrote (installNarrowWrote) and of the full-route spots it entered
 * (pinned: SPOT_ROWS), and the login-self rows (LOGIN_SELF_ENTRIES: every
 * writing `self` row of the route table, as the owner or as a member).
 * Every GET of an area row or a `self` row too (sweepReadRows): none
 * refused by the narrow role.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/server/narrow-area-sweep.db.test.ts
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  CONTACT_NODE,
  KEY_OR,
  LANDED_NODE,
  LOGIN_SELF_ENTRIES,
  READ_SWEEP_SKIP,
  SELF_CHAT,
  MAIL_NODE,
  NARROW_SWEEP_ENTRIES,
  PEER_NODE,
  RELAY,
  SANDBOXD,
  WORKER,
  WORKER_KINDS,
  selfWriteRows,
  sweepReadRows,
  writingAreaRows,
} from './narrow-area-sweep.entries';
import { SAMPLE_ID } from './a10-body-sweep.samples';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

vi.mock('@mantle/crypto', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  seal: vi.fn(() => ({ ciphertext: Buffer.from('sealed'), keyVersion: 1 })),
  open: vi.fn(() => JSON.stringify({ note: 'n', fields: [] })),
}));

// The mail rescan's queue (pg-boss, its own pool on DATABASE_URL, kept for
// the process): replaced, so the first pass's client does not outlive its
// scratch database. Not the narrow route (its own connection).
vi.mock('pg-boss', () => {
  class PgBoss {
    async start() {}
    async stop() {}
    async createQueue() {}
    async send() {
      return 'job';
    }
    on() {}
  }
  return { PgBoss, default: PgBoss };
});

vi.mock('@mantle/voice', async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  return {
    ...orig,
    getEmbeddingAdapter: () => ({
      embed: async ({ input }: { input: unknown[] }) => ({
        vectors: input.map(() => Array.from({ length: 768 }, () => 0.01)),
      }),
    }),
  };
});

/** The a10 body sweep's valid body per row (made from each route's schema). */
const bodies = JSON.parse(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '__snapshots__', 'a10-body-sweep.bodies.json'),
    'utf8',
  ),
) as Record<string, unknown>;

const OWNER = '22222222-2222-4222-8222-222222222222';

const S = SAMPLE_ID;
/** The Azure route's 'custom' key, and the provision row's record key. */
const KEY_AZURE = '55555555-5555-4555-8555-5555555555a2';
const AZURE_PROVISION = 'onboarding provision (Azure only)';
const MOBILE_LOGOUT = 'POST /api/auth/mobile-logout (a device bearer)';
/** The users area disables an Admin user (0327's hold): the record key. */
const ADMIN_DISABLE = 'PATCH /api/users/:id {disabled} (an Admin user)';
/** The owner signs out everywhere (its own sessions, keys and grants):
 *  the record key. Last in a pass: it ends the pass's cookie. */
const OWNER_LOGOUT_ALL = 'POST /api/auth/logout {everywhere} (the owner)';
/** The Admin user the disable row acts on (an admin by role: held). */
const ADMIN2 = '22222222-2222-4222-8222-2222222222a1';
/** The Microsoft sign-in, token refresh and drive discovery with Graph
 *  stubbed: the record key (the table's callback row carries no state
 *  cookie, so it never reaches the account write). */
const MS_CONNECT = 'microsoft connect, refresh and discover (Graph stubbed)';
const MS_UPN = 'sweep-ms2@example.invalid';

/**
 * The rows each route needs to reach its write: one per table at the
 * sample id, plus a few the paths and bodies name (narrow-area-sweep
 * entries). The same on both passes. Run as the superuser.
 */
async function seedFixture(su: postgres.Sql): Promise<void> {
  const b = Buffer.from('sealed');
  // A member login, an Anthropic key at the sample id (PATCH /api/keys
  // takes only that service) and an OpenRouter one (the assistants, the
  // manifest's adopt and reset, the workers).
  await su`insert into auth.users (id, email, password_hash, role, display_name)
           values (${S}, 'sweep-member@example.test', 'x', 'member', 'Sweep Member')`;
  await su`insert into api_keys (id, user_id, service, label, key_enc)
           values (${S}, ${OWNER}, 'anthropic', 'default', ${b}),
                  (${KEY_OR}, ${OWNER}, 'openrouter', 'default', ${b})`;
  await su`insert into tool_groups (id, owner_id, slug, name, tool_slugs)
           values (${S}, ${OWNER}, 'sweep-group', 'Sweep group', '{search}')`;
  await su`insert into agents (id, owner_id, slug, name, role, model, system_prompt, tool_group_slugs, api_key_id)
           values (${S}, ${OWNER}, 'sweep-agent', 'Sweep agent', 'responder', 'm', 'p', '{sweep-group}', ${KEY_OR})`;
  await su`insert into skills (id, owner_id, slug, name, description, instructions)
           values (${S}, ${OWNER}, 'sweep-skill', 'Sweep skill', 'd', 'b')`;
  // An assistant's Telegram bot and one chat of the owner's.
  await su`insert into channels (id, owner_id, agent_id, type, display_name, credentials_enc)
           values (${S}, ${OWNER}, ${S}, 'telegram', 'Sweep bot', ${b})`;
  await su`insert into telegram_accounts (id, user_id, bot_username, branch_path, channel_id)
           values (${S}, ${OWNER}, 'sweep_bot', 'inbox.telegram_sweep_bot', ${S})`;
  await su`insert into telegram_chats (id, account_id, user_id, telegram_chat_id, chat_type, login_id)
           values (${S}, ${S}, ${OWNER}, '1', 'private', ${OWNER}),
                  (${SELF_CHAT}, ${S}, ${OWNER}, '2', 'private', ${OWNER})`;
  // AI workers: one at the sample id, one per kind the test rows probe.
  await su`insert into ai_workers (id, owner_id, slug, name, kind, provider, model, api_key_id)
           values (${S}, ${OWNER}, 'sweep-worker', 'Sweep worker', 'reflector', 'openrouter', 'x/m', ${KEY_OR})`;
  for (const [i, kind] of WORKER_KINDS.entries()) {
    await su`insert into ai_workers (id, owner_id, slug, name, kind, provider, model, api_key_id)
             values (${WORKER(i + 1)}, ${OWNER}, ${`sweep-${kind}`}, ${kind}, ${kind}, 'openrouter', 'x/m', ${KEY_OR})`;
  }
  await su`insert into curated_models (id, owner_id, pool, name, routes)
           values (${S}, ${OWNER}, 'agents', 'Sweep pool entry',
                   ${su.json([{ provider: 'openrouter', model: 'sweep/model' }])})`;
  await su`insert into calendar_accounts (id, owner_id, provider, display_name)
           values (${S}, ${OWNER}, 'ics', 'Sweep cal')`;
  await su`insert into doc_collections (id, owner_id, key, label, origin, root_path, enabled)
           values (${S}, ${OWNER}, 'sweep-fixture', 'Sweep fixture', 'user', 'sweep-fixture', false)`;
  await su`insert into email_accounts (id, user_id, provider, address, branch_path, imap_host, imap_port, imap_secure, imap_config_enc)
           values (${S}, ${OWNER}, 'imap', 'sweep-box@example.invalid', 'inbox.sweep_box', '127.0.0.1', 1, false, ${b})`;
  await su`insert into nodes (id, owner_id, type, title, path)
           values (${MAIL_NODE}, ${OWNER}, 'email', 'Sweep mail', 'inbox.sweep_box'),
                  (${LANDED_NODE}, ${OWNER}, 'note', 'Sweep landed', 'notes')`;
  await su`insert into emails (id, node_id, account_id, provider_msg_id, from_addr, internal_date)
           values (${S}, ${MAIL_NODE}, ${S}, 'sweep-1', 'a@example.invalid', now())`;
  // A heartbeat whose assistant is gone: its fire pauses it, no model call.
  await su`insert into heartbeats (id, owner_id, slug, name, agent_slug, skill_slug, schedule_kind, schedule, surface)
           values (${S}, ${OWNER}, 'sweep-hb', 'Sweep hb', 'sweep-gone', 'sweep-skill', 'manual',
                   ${su.json({ kind: 'manual' })}, ${su.json({ kind: 'web' })})`;
  await su`insert into microsoft_config (owner_id, client_id, client_secret_enc, redirect_uri)
           values (${OWNER}, 'sweep-client', ${b}, 'https://example.invalid/cb')`;
  await su`insert into ms_accounts (id, user_id, upn, branch_path, access_token_enc, refresh_token_enc, token_expires_at)
           values (${S}, ${OWNER}, 'sweep-ms@example.invalid', 'microsoft.sweep_ms', ${b}, ${b}, '2000-01-01Z')`;
  await su`insert into ms_drives (id, account_id, drive_id, drive_type, name, branch_label)
           values (${S}, ${S}, 'sweep-drive', 'personal', 'Sweep drive', 'sweep_drive')`;
  // One scope already set, so the scope set's replace deletes a row.
  await su`insert into ms_drive_scopes (drive_db_id, item_id, path, is_folder)
           values (${S}, 'sweep-old', '/Old', true)`;
  await su`insert into runs (id, owner_id, title) values (${S}, ${OWNER}, 'Sweep run')`;
  await su`insert into sandboxes (id, owner_id, name, image) values (${S}, ${OWNER}, 'sweep-box', 'sweep-image')`;
  // The connectors: an MCP one with an authorization pending, an OpenAPI one.
  await su`insert into tool_groups (owner_id, slug, name, integration)
           values (${OWNER}, 'mcp-sweepfix', 'Sweep MCP', ${su.json({
             service: 'sweepfix',
             mcp: {
               url: 'https://203.0.113.10/mcp',
               oauth: {
                 enabled: true,
                 status: 'pending',
                 pending: {
                   state: 'sweep-state',
                   redirectUri: 'http://localhost/api/mcp-connectors/oauth/callback',
                   startedAt: '2026-01-01T00:00:00.000Z',
                 },
               },
             },
           })}),
                  (${OWNER}, 'openapi-sweepfix', 'Sweep API', ${su.json({
                    service: 'sweepfix',
                    openapi: { specUrl: 'https://203.0.113.10/openapi.json' },
                  })})`;
  await su`insert into oauth_clients (id, client_name, redirect_uris)
           values (${S}, 'Sweep client', '{https://claude.ai/cb}')`;
  await su`insert into oauth_access_tokens (token_hash, owner_id, actor_id, client_id, expires_at)
           values ('sweep-token-hash', ${OWNER}, ${OWNER}, ${S}, now() + interval '1 hour'),
                  ('sweep-member-token-hash', ${OWNER}, ${S}, ${S}, now() + interval '1 hour')`;
  await su`insert into tools (id, owner_id, slug, name, description, handler)
           values (${S}, ${OWNER}, 'sweep-tool', 'Sweep tool', 'd',
                   ${su.json({ kind: 'http', url: 'https://203.0.113.10/x', method: 'GET' })})`;
  await su`insert into tools (owner_id, slug, name, description, handler)
           values (${OWNER}, 'note_create', 'Create a note', 'd', ${su.json({ kind: 'builtin', ref: 'note_create' })})`;
  await su`insert into agent_groups (id, owner_id, slug, name)
           values (${S}, ${OWNER}, 'sweep-workers', 'Sweep workers')`;
  await su`insert into tailscale_config (owner_id, auth_key_enc, hostname) values (${OWNER}, ${b}, 'sweep')`;
  await su`insert into pdf_passwords (id, owner_id, password_enc) values (${S}, ${OWNER}, ${b})`;
  await su`insert into nodes (id, owner_id, type, title, path, data)
           values (${PEER_NODE}, ${OWNER}, 'mantle_peer', 'Sweep peer', 'peers',
                   ${su.json({ base_url: 'https://peer.example.test', description: '' })})`;
  await su`insert into mantle_peers (id, owner_id, node_id, display_name, base_url, inbound_token_hash, status, created_by)
           values (${S}, ${OWNER}, ${PEER_NODE}, 'Sweep peer', 'https://peer.example.test', 'sweep-peer-hash', 'pending', ${OWNER})`;
  await su`insert into pending_tool_calls (id, owner_id, tool_slug, args)
           values (${S}, ${OWNER}, 'calculate', ${su.json({ expression: '1+1' })})`;
  await su`insert into nodes (id, owner_id, type, title, path, data)
           values (${S}, ${OWNER}, 'secret', 'Sweep secret', 'secrets',
                   ${su.json({ description: 'd', kind: 'password', has_note: true, field_count: 0 })})`;
  await su`insert into secrets (node_id, ciphertext, key_version) values (${S}, ${b}, 1)`;
  await su`insert into member_invites (id, owner_id, email, code_hash, expires_at)
           values (${S}, ${OWNER}, 'sweep-invited@example.test', 'sweep-invite-hash', now() + interval '1 day')`;
  await su`insert into mobile_tokens (id, user_id, expires_at) values (${S}, ${S}, now() + interval '30 days')`;
  // The reads that reach a definer only with a row to read: an app's access
  // log with an actor (its names, mantle_access_log_names), a contact the
  // invite names (its sharing), and pg-boss's job table (the queue counts of
  // the integrity audit and the extraction screen; pg-boss itself is
  // replaced here). The migrate granted SELECT on pgboss's tables before
  // this one existed, so the grant is repeated as migrate makes it.
  await su`insert into app_access_log (owner_id, app_node_id, actor_id, kind)
           values (${OWNER}, ${S}, ${OWNER}, 'tool')`;
  await su`insert into nodes (id, owner_id, type, title, path)
           values (${CONTACT_NODE}, ${OWNER}, 'contact', 'Sweep contact', 'contacts')`;
  await su`create table if not exists pgboss.job (
             id uuid primary key default gen_random_uuid(), name text not null,
             state text not null, data jsonb, created_on timestamptz not null default now(),
             completed_on timestamptz)`;
  await su`grant select on pgboss.job to mantle_runtime, mantle_system_narrow`;
}

/**
 * The per-row record of the narrow login's own writes (round 10, D 1): a
 * row trigger on every table of public and auth that, when the statement
 * runs as the narrow role (current_user: a definer's own writes are its
 * owner's, never counted), notes the table and operation in
 * public.sweep_narrow_wrote (through sweep_narrow_note, a definer of this
 * scratch's superuser), which the sweep reads and empties after each row.
 * This scratch only.
 */
async function installNarrowWrote(su: postgres.Sql): Promise<void> {
  const tables = await su<{ t: string }[]>`
    select c.oid::regclass::text as t from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname in ('public', 'auth') and c.relkind in ('r', 'p') and not c.relispartition`;
  await su.unsafe(`create table public.sweep_narrow_wrote (k text primary key)`);
  await su.unsafe(`create or replace function public.sweep_narrow_note(k text) returns void
    language sql security definer set search_path = pg_catalog, pg_temp as $$
      insert into public.sweep_narrow_wrote values (k) on conflict do nothing $$`);
  await su.unsafe(`grant execute on function public.sweep_narrow_note(text) to public`);
  await su.unsafe(`create or replace function public.sweep_narrow_wrote() returns trigger
    language plpgsql set search_path = pg_catalog, pg_temp as $$
    begin
      if current_user = 'mantle_system_narrow' then
        perform public.sweep_narrow_note(TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME || ' ' || TG_OP);
      end if;
      return null;
    end $$`);
  for (const { t } of tables) {
    await su.unsafe(`create trigger sweep_narrow_wrote after insert or update or delete on ${t}
      for each row execute function public.sweep_narrow_wrote()`);
  }
}

/** An answer less what is fresh each run: ids, stamps, minted tokens. */
function normalize(text: string): string {
  return text
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, 'U')
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?/g, 'T')
    .replace(/"durationMs":\d+/g, '"durationMs":N')
    .replace(/\b\d{10,}\b/g, 'N')
    .replace(/[A-Za-z0-9_\-+/=]{24,}/g, 'K')
    .replace(/\/tmp\/[^"\s]*/g, 'P')
    .replace(/"code":"[^"]*"/g, '"code":"C"')
    .replace(/code=[^"&\s]*/g, 'code=C')
    .slice(0, 400);
}

describe.skipIf(!URL)('the narrow area-route sweep: every writing area row', () => {
  type Ts = typeof import('@mantle/db/test-support');
  let ts: Ts;
  let m: typeof import('@mantle/db');
  let app: { request: (path: string, init: RequestInit) => Response | Promise<Response> };
  let rows: { key: string }[] = [];
  let selfRows: { key: string }[] = [];
  let readRows: { key: string }[] = [];
  /** Per pass: each read row's status. */
  const readAnswers: Record<'on', Map<string, string>> = {
    on: new Map(),
  };
  let dir = '';
  const realFetch = globalThis.fetch;
  const answers: Record<'on', Map<string, string>> = { on: new Map() };
  const denials = new Map<string, unknown[]>();
  /** Per row and pass: the tables and operations the narrow login wrote
   *  (installNarrowWrote), and the full-route spots it entered. */
  const wrote: Record<'on', Map<string, string[]>> = { on: new Map() };
  const spots: Record<'on', Map<string, string[]>> = { on: new Map() };
  const selfAnswers: Record<'on', Map<string, string>> = {
    on: new Map(),
  };
  const docs: Record<string, Record<string, number | boolean>> = {};
  /** The Azure-only provision per pass: its answer, the persona's route
   *  and the tool groups after it. */
  const azure: Record<string, { answer: string; persona: string; groups: number }> = {};
  /** The phone's sign-out per pass (a live device bearer, no cookie): its
   *  answer and whether the token row was revoked. */
  const mobileOut: Record<string, string> = {};
  /** The Admin user's disable and the owner's sign-out everywhere per
   *  pass: the answer and what landed. */
  const adminOff: Record<string, string> = {};
  const ownerOut: Record<string, string> = {};
  /** The MS_CONNECT block per pass: the callback's redirect, the discover
   *  answer, and what landed (the new account with its tokens, the
   *  fixture account's refreshed expiry, the drive found). */
  const ms: Record<string, Record<string, string | boolean>> = {};

  beforeAll(async () => {
    ts = await import('@mantle/db/test-support');
    dir = mkdtempSync(join(tmpdir(), 'narrow-sweep-'));
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    process.env.SESSION_SECRET = 'narrow-area-sweep-secret-at-least-32-characters';
    process.env.MANTLE_DOCS_ROOT = join(dir, 'docs');
    process.env.MANTLE_BACKUP_DIR = join(dir, 'backups');
    process.env.MANTLE_PUSH_RELAY_URL = RELAY;
    process.env.MANTLE_TAILSCALE_SOCK = join(dir, 'tailscaled.sock');
    // No network, but the sandbox daemon (its own box service) answers.
    process.env.SANDBOXD_URL = SANDBOXD;
    process.env.SANDBOXD_TOKEN = 'sweep-token';
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : 'url' in input ? input.url : input.href;
      if (url.startsWith(RELAY)) {
        // The relay registers the brain (its instance id) and takes the rest.
        const out = url.endsWith('/instances') ? { instanceId: 'sweep-instance' } : {};
        return new Response(JSON.stringify(out), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      // Microsoft's token endpoint and Graph (the MS_CONNECT block): a
      // code exchange or refresh answers a token set, /me the account,
      // /me/drive one drive, no followed sites.
      const json = (out: unknown) =>
        new Response(JSON.stringify(out), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      if (url.startsWith('https://login.microsoftonline.com/')) {
        return json({
          access_token: 'sweep-access',
          refresh_token: 'sweep-refresh-2',
          expires_in: 3600,
          scope: 'Files.Read offline_access',
        });
      }
      if (url === 'https://graph.microsoft.com/v1.0/me') {
        return json({ userPrincipalName: MS_UPN, displayName: 'Sweep MS' });
      }
      if (url.startsWith('https://graph.microsoft.com/v1.0/me/drive')) {
        return json({ id: 'sweep-drive-2', driveType: 'business', name: 'Sweep OneDrive' });
      }
      if (url.startsWith('https://graph.microsoft.com/v1.0/me/followedSites')) {
        return json({ value: [] });
      }
      if (url.startsWith(SANDBOXD)) {
        return new Response('{}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error('sweep: no network');
    }) as typeof fetch;
    const { routeManifest } = await import('./route-manifest.gen');
    const { buildRoutePolicy } = await import('../lib/auth/route-policy');
    const policy = buildRoutePolicy(routeManifest);
    rows = writingAreaRows(policy);
    selfRows = selfWriteRows(policy);
    readRows = sweepReadRows(policy).filter((r) => !(r.key in READ_SWEEP_SKIP));
    await runPass('on');
  }, 900_000);

  afterAll(async () => {
    globalThis.fetch = realFetch;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  async function runPass(pass: 'on'): Promise<void> {
    const scratch = await ts.createMigratedScratchDatabase(URL!);
    const su = postgres(scratch.url, { max: 1, prepare: false, onnotice: () => {} });
    try {
      process.env.DATABASE_URL = scratch.url;
      m = await import('@mantle/db');
      await su`insert into auth.users (id, email, password_hash, is_owner, role, display_name)
               values (${OWNER}, 'sweep-owner@example.test', 'x', true, 'admin', 'Sweep Owner')`;
      await su`insert into spaces (id, kind, login_id) values (${OWNER}, 'brain', ${OWNER})
               on conflict (id) do nothing`;
      await ts.runWorkspacesSwitch(scratch.url);
      await su`insert into profiles (user_id) values (${OWNER}) on conflict do nothing`;
      await seedFixture(su);
      await installNarrowWrote(su);
      const col = join(dir, `docs-${pass}`, 'sweep-docs');
      mkdirSync(col, { recursive: true });
      writeFileSync(join(col, 'a.md'), '# Sweep guide\n\nThe first text.\n');
      const tokens = await import('../lib/auth/tokens');
      const cookie = `mantle_session=${tokens.buildSessionCookie(OWNER).value}`;
      const { createApp } = await import('./app');
      app = await createApp();
      const memberCookie = `mantle_session=${tokens.buildSessionCookie(S).value}`;
      const send = async (method: string, path: string, body: unknown, as = cookie) => {
        const res = await app.request(path, {
          method,
          headers: { 'content-type': 'application/json', cookie: as },
          ...(body === null || body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        return { status: res.status, text: await res.text().catch(() => '') };
      };
      const sample = bodies;
      /** What the row just sent made the narrow login write, and the
       *  spots it entered (each taken, so the next row starts empty). */
      const record = async (key: string) => {
        const w = (
          await su<{ k: string }[]>`delete from public.sweep_narrow_wrote returning k`
        ).map((r) => r.k);
        wrote[pass].set(key, [...new Set(w)].sort());
        spots[pass].set(key, [...new Set(ts.takeSpotUses())].sort());
        denials.set(key, ts.takeNarrowDenials());
      };
      ts.takeSpotUses();
      ts.takeNarrowDenials();
      // The read rows first, on the untouched
      // fixture: each GET of an area or `self` row, a member row as the
      // member login. A read writes nothing the next row reads.
      for (const row of readRows) {
        const [, pattern] = row.key.split(' ') as [string, string];
        const path = pattern.replace(/:[A-Za-z0-9_]+\??/g, SAMPLE_ID).replace(/\*$/, 'a/b');
        const as = pattern.startsWith('/api/member/') ? memberCookie : cookie;
        const r = await send('GET', path, null, as);
        readAnswers[pass].set(row.key, String(r.status));
        await record(`read ${row.key}`);
      }
      // The login-self rows next: the area rows' DELETEs remove the member.
      for (const [key, entry] of Object.entries(LOGIN_SELF_ENTRIES)) {
        if ('skip' in entry) continue;
        const [method, pattern] = key.split(' ') as [string, string];
        const path = entry.path ?? pattern.replace(/:[A-Za-z0-9_]+\??/g, SAMPLE_ID);
        const as = entry.as === 'owner' ? cookie : memberCookie;
        const r = await send(method, path, entry.body ?? null, as);
        selfAnswers[pass].set(key, `${r.status} ${normalize(r.text)}`);
        await record(`self ${key}`);
      }
      // The phone's sign-out with a live device bearer (the table's
      // self rows skip device bearers): forgetRequestLogins drops the
      // request's own login, and nothing after it may ask the narrow role
      // for a right it lacks (a later guard read, the push devices, the
      // audit row).
      {
        const jti = '00000000-0000-4000-8000-00000000a0be';
        await su`insert into mobile_tokens (id, user_id, label, expires_at)
                   values (${jti}, ${OWNER}, 'sweep phone', now() + interval '30 days')`;
        const bearer = tokens.buildMobileToken(OWNER, jti).value;
        const res = await app.request('/api/auth/mobile-logout', {
          method: 'POST',
          headers: { authorization: `Bearer ${bearer}` },
        });
        const [row] = await su<{ revoked: boolean }[]>`
            select revoked_at is not null as revoked from mobile_tokens where id = ${jti}`;
        mobileOut[pass] = `${res.status} ${normalize(await res.text())} revoked=${row?.revoked}`;
        await record(MOBILE_LOGOUT);
      }
      // The users area disables an Admin user (the round 16 re-audit's
      // L5): 0327's hold, so a narrow exit runs it at the spot
      // login-credential; the same answer both ways.
      {
        await su`insert into auth.users (id, email, password_hash, role)
                   values (${ADMIN2}, 'sweep-admin2@example.invalid', 'x', 'admin')
                   on conflict (id) do nothing`;
        const r = await send('PATCH', `/api/users/${ADMIN2}`, { disabled: true });
        const [row] = await su<{ off: boolean }[]>`
            select disabled_at is not null as off from auth.users where id = ${ADMIN2}`;
        adminOff[pass] = `${r.status} ${normalize(r.text)} disabled=${row?.off}`;
        await record(ADMIN_DISABLE);
      }
      // The Microsoft sign-in, a token refresh and a drive discovery, with
      // Graph stubbed (round 13c, G): the callback with its state and PKCE
      // cookies; the fixture account's tokens sealed for real and expired,
      // so the discover refreshes them first. Before the area rows: the
      // DELETE rows remove the config and the account.
      {
        const { seal } = await import('@mantle/crypto');
        await su`update microsoft_config
                      set client_secret_enc = ${seal('sweep-secret', OWNER).ciphertext}
                    where owner_id = ${OWNER}`;
        await su`update ms_accounts
                      set access_token_enc = ${seal('sweep-old', S).ciphertext},
                          refresh_token_enc = ${seal('sweep-refresh', S).ciphertext},
                          token_expires_at = '2000-01-01Z', enabled = true
                    where id = ${S}`;
        const back = await app.request(
          '/api/microsoft/oauth/callback?code=sweep-code&state=sweep-state',
          {
            method: 'GET',
            headers: {
              cookie: `${cookie}; ms_oauth_state=sweep-state; ms_oauth_verifier=sweep-verifier`,
            },
          },
        );
        const to = back.headers.get('location') ?? '';
        const found = await send('POST', `/api/microsoft/accounts/${S}/drives`, {});
        await record(MS_CONNECT);
        const [acct] = await su<{ tokens: boolean }[]>`
            select (access_token_enc is not null and refresh_token_enc is not null) as tokens
              from ms_accounts where user_id = ${OWNER} and upn = ${MS_UPN}`;
        const [fixture] = await su<{ fresh: boolean }[]>`
            select token_expires_at > now() as fresh from ms_accounts where id = ${S}`;
        const [drive] = await su<{ enabled: boolean }[]>`
            select enabled from ms_drives where account_id = ${S} and drive_id = 'sweep-drive-2'`;
        ms[pass] = {
          callback: `${back.status} ${to.includes('connected=') ? 'connected' : to.slice(0, 160)}`,
          discover: `${found.status} ${normalize(found.text)}`,
          account: acct?.tokens ?? false,
          refreshed: fixture?.fresh ?? false,
          drive: drive ? `found, enabled ${drive.enabled}` : 'none',
        };
      }
      // The DELETE rows last, a sub-resource's before its parent's (the
      // table's own order otherwise), so a row that reads, edits or acts
      // on a fixture row meets it before a DELETE row removes it.
      const depth = (k: string) => k.split('/').length;
      const ordered = [
        ...rows.filter((r) => !r.key.startsWith('DELETE ')),
        ...rows
          .filter((r) => r.key.startsWith('DELETE '))
          .sort((x, y) => depth(y.key) - depth(x.key)),
      ];
      for (const row of ordered) {
        const entry = NARROW_SWEEP_ENTRIES[row.key];
        if (!entry || 'skip' in entry) continue;
        const [method, pattern] = row.key.split(' ') as [string, string];
        const path =
          entry.path ?? pattern.replace(/:[A-Za-z0-9_]+\??/g, SAMPLE_ID).replace(/\*$/, 'a/b');
        const body = 'body' in entry ? entry.body : method === 'GET' ? null : sample[row.key];
        const r = await send(method, path, body);
        answers[pass].set(row.key, `${r.status} ${normalize(r.text)}`);
        await record(row.key);
      }
      // LOW-4: a documentation item made from a real markdown file, then
      // the file edited and the collection read again (its update).
      // The collection's own items only: the default collections the
      // `all` row enabled may index the same file under their own root.
      const docIds = async (text: string) =>
        (
          await su<{ id: string }[]>`
    select id::text as id from nodes where owner_id = ${OWNER}
       and type = 'documentation' and data->>'collection' = 'sweep-docs'
       and data->>'content' like ${`%${text}%`} order by id`
        ).map((r) => r.id);
      const made = await send('POST', '/api/docs/collections', {
        label: 'Sweep docs',
        key: 'sweep-docs',
        rootPath: col,
        brainDepth: 'retrieval',
      });
      const first = await docIds('first text');
      const [c] = await su<{ id: string }[]>`
  select id::text as id from doc_collections where key = 'sweep-docs'`;
      writeFileSync(join(col, 'a.md'), '# Sweep guide\n\nThe second text.\n');
      // Enabling an enabled collection reconciles it: the changed file is an
      // update of its item (upsertDocFromDisk), the same id.
      const reread = await send('PATCH', `/api/docs/collections/${c!.id}`, { enabled: true });
      const second = await docIds('second text');
      docs[pass] = {
        made: made.status,
        reread: reread.status,
        rereadOk: reread.text.includes('1 updated'),
        first: first.length,
        left: (await docIds('first text')).length,
        sameIds: first.length > 0 && first.every((id) => second.includes(id)),
      };
      denials.set('docs-item', ts.takeNarrowDenials());
      // The onboarding provision on the Azure route only (round 8's B):
      // the OpenRouter key leaves the provider lookup (its service
      // renamed, so the rows that name it keep it), a 'custom' key and
      // the Models step's Azure endpoint are saved, and Set up seeds the
      // tool substrate, the workers' routes and the persona assistant.
      // Last: it changes the fixture's keys.
      await su`update api_keys set service = 'sweep-renamed' where id = ${KEY_OR}`;
      await su`insert into api_keys (id, user_id, service, label, key_enc)
                 values (${KEY_AZURE}, ${OWNER}, 'custom', 'default', ${Buffer.from('sealed')})`;
      await su`update profiles
                    set preferences = coalesce(preferences, '{}'::jsonb) || ${su.json({
                      onboardingModels: {
                        route: 'azure',
                        azureBaseUrl: 'https://sweep.openai.azure.example/openai/v1',
                        assistantModel: 'sweep-assistant',
                        workerModel: 'sweep-worker',
                      },
                    })}
                  where user_id = ${OWNER}`;
      const provisioned = await send('POST', '/api/onboarding', { action: 'provision' });
      await record(AZURE_PROVISION);
      const { PERSONA_SLUG } = await import('../lib/system-manifest/manifest');
      const [persona] = await su<{ provider: string; key: string | null; url: string | null }[]>`
  select provider, api_key_id::text as key, base_url as url from agents
   where owner_id = ${OWNER} and slug = ${PERSONA_SLUG}`;
      azure[pass] = {
        answer: `${provisioned.status} ${normalize(provisioned.text)}`,
        persona: persona ? `${persona.provider} ${persona.key} ${persona.url}` : 'none',
        groups: (
          await su<
            { n: number }[]
          >`select count(*)::int as n from tool_groups where owner_id = ${OWNER}`
        )[0]!.n,
      };
      // The owner signs out everywhere (the round 16 re-audit's L5): its
      // session epoch, its keys, OAuth grants and devices (0327's hold:
      // the owner's own, at the spot login-credential on a narrow exit).
      // Last: the pass's cookie ends with it.
      {
        await su`insert into mobile_tokens (id, user_id, label, expires_at)
                   values ('00000000-0000-4000-8000-00000000a0bf', ${OWNER}, 'sweep phone 2',
                           now() + interval '30 days')`;
        const [was] = await su<{ epoch: number }[]>`
            select session_epoch as epoch from auth.users where id = ${OWNER}`;
        const r = await send('POST', '/api/auth/logout', { everywhere: true });
        const [now] = await su<{ epoch: number; live: number }[]>`
            select u.session_epoch as epoch,
                   (select count(*)::int from mobile_tokens t
                     where t.user_id = u.id and t.revoked_at is null) as live
              from auth.users u where u.id = ${OWNER}`;
        ownerOut[pass] =
          `${r.status} ${normalize(r.text)} epochMoved=${now!.epoch > was!.epoch} liveDevices=${now!.live}`;
        await record(OWNER_LOGOUT_ALL);
      }
    } finally {
      await m?.closeDb();
      await su.end();
      await scratch.drop();
    }
  }

  it('drives every writing area row but those the table says why', () => {
    const driven = rows.filter((r) => !('skip' in (NARROW_SWEEP_ENTRIES[r.key] ?? {})));
    expect(answers.on.size).toBe(driven.length);
  });

  it('no row is refused by the narrow role', () => {
    const refused = [...denials].filter(([, d]) => d.length > 0);
    expect(refused).toEqual([]);
  });

  it('the login-self rows (every writing self row of the table): 2xx but the named ones', () => {
    const sent = Object.entries(LOGIN_SELF_ENTRIES).filter(([, e]) => !('skip' in e));
    expect(selfAnswers.on.size).toBe(sent.length);
    expect(selfRows.length).toBe(Object.keys(LOGIN_SELF_ENTRIES).length);
    const differ = [...selfAnswers.on]
      .filter(([k, a]) => {
        const e = LOGIN_SELF_ENTRIES[k]!;
        const named = !('skip' in e) && e.answers !== undefined;
        return !named && !a.startsWith('2');
      })
      .map(([k, a]) => ({ row: k, on: a }));
    expect(differ).toEqual([]);
  });

  it('the read rows (every GET of an area or self row): sent, none refused by the narrow role, none a 500', () => {
    expect(readAnswers.on.size).toBe(readRows.length);
    expect(readRows.length).toBeGreaterThan(100);
    const refused = [...denials].filter(([k, d]) => k.startsWith('read ') && d.length > 0);
    expect(refused).toEqual([]);
    expect([...readAnswers.on].filter(([, a]) => a.startsWith('5'))).toEqual([]);
  });

  it('the phone sign-out with a live bearer: 200 and its token revoked, nothing refused by the narrow role', () => {
    expect(mobileOut.on).toMatch(/^200 .*revoked=true$/);
    expect(denials.get(MOBILE_LOGOUT) ?? []).toEqual([]);
  });

  it("an Admin user's disable and the owner's sign-out everywhere: landed, nothing refused by the narrow role", () => {
    expect(adminOff.on).toMatch(/^200 .*disabled=true$/);
    expect(denials.get(ADMIN_DISABLE) ?? []).toEqual([]);
    expect(ownerOut.on).toMatch(/^200 .*epochMoved=true liveDevices=0$/);
    expect(denials.get(OWNER_LOGOUT_ALL) ?? []).toEqual([]);
  });

  it('the onboarding provision on the Azure route only: 2xx, the persona on the custom key', () => {
    expect(azure.on!.answer.startsWith('2')).toBe(true);
    expect(azure.on!.persona).toBe(
      `custom ${KEY_AZURE} https://sweep.openai.azure.example/openai/v1`,
    );
    expect(azure.on!.groups).toBeGreaterThan(2);
  });

  it('records per row whether the narrow login wrote: the scope set`s insert on the narrow route', () => {
    // ms_drive_scopes' narrow INSERT and DELETE (round 9, from the code):
    // the product's scope set makes both as the narrow login.
    expect(wrote.on.get('PUT /api/microsoft/drives/:id/scopes')).toEqual(
      expect.arrayContaining(['public.ms_drive_scopes DELETE', 'public.ms_drive_scopes INSERT']),
    );
    const by = (pick: (w: string[]) => boolean) => [...wrote.on].filter(([, w]) => pick(w)).length;
    console.log(
      `narrow sweep: rows where the narrow login wrote ${by((w) => w.length > 0)}, wrote nothing ${by((w) => w.length === 0)}`,
    );
  });

  /**
   * The rows whose writes run at a full-route spot (onFullSystemRoute),
   * each with the spots it enters (round 10, D 1). A row that starts or
   * stops using a spot fails here: name it.
   */
  const SPOT_ROWS: Readonly<Record<string, readonly string[]>> = {
    'self PUT /api/profile': ['profile-row'],
    'self PUT /api/profile/backgrounds': ['profile-row'],
    'self PUT /api/profile/color-theme': ['profile-row'],
    'self PUT /api/profile/default-mode': ['profile-row'],
    'self PUT /api/profile/fonts': ['profile-row'],
    'self PUT /api/profile/nav-favorites': ['profile-row'],
    'self PUT /api/profile/neat-background': ['profile-row'],
    'self PUT /api/profile/reminder-channel': ['profile-row'],
    'self PUT /api/profile/share-neat': ['profile-row'],
    'self DELETE /api/profile/logo': ['profile-row'],
    'self DELETE /api/profile/photo': ['profile-row'],
    'self POST /api/push/connect': ['push-device'],
    'self POST /api/push/reset': ['push-device'],
    // The login's own chat rows (pairing.ts setChatPairing,
    // its definer at acting-login on every route) and the reads that
    // write at a spot (a collection's index settled, a drive's token
    // refreshed, the onboarding row made on first read).
    'self POST /api/telegram/chats/:id/block': ['acting-login'],
    'self POST /api/telegram/chats/:id/unpair': ['acting-login'],
    'self DELETE /api/telegram/my-chats/:id': ['acting-login'],
    'read GET /api/docs/collections': ['docs-root'],
    'read GET /api/microsoft/drives/:id/browse': ['ms-account'],
    'read GET /api/onboarding': ['profile-row'],
    'POST /api/agents': ['assistant-grant'],
    'POST /api/agents/:id/persona': ['skill-text'],
    'POST /api/ai-workers': ['model-route'],
    'POST /api/ai-workers/reembed': ['reembed'],
    'PATCH /api/agents/:id': ['assistant-grant', 'skill-text'],
    'PATCH /api/ai-workers/:id': ['model-route', 'skill-text'],
    'POST /api/backups': ['profile-row'],
    'POST /api/backups/run': ['profile-row'],
    'POST /api/config/adopt': ['assistant-grant'],
    'POST /api/config/adopt-all': [
      'assistant-grant',
      'heartbeat-maker',
      'model-route',
      'skill-text',
      'tool-config',
      'tool-group-grant',
    ],
    'POST /api/debug/integrity/landed/delete': ['integrity-delete'],
    'POST /api/dev-tools/execute-tool': ['console-tool'],
    'POST /api/dev-tools/queue-approval': ['pending-park'],
    'POST /api/docs/collections': ['docs-root'],
    'POST /api/docs/collections/all': ['docs-root'],
    'POST /api/embedding': ['model-route'],
    'POST /api/embedding/rebuild': ['reembed'],
    'POST /api/heartbeats': ['heartbeat-maker'],
    'POST /api/keys': ['model-route'],
    'POST /api/mcp-connectors': ['tool-group-grant'],
    'GET /api/mcp-connectors/oauth/callback': ['tool-config'],
    'PATCH /api/heartbeats/:id': ['heartbeat-maker'],
    'PATCH /api/mcp-connectors/:slug': ['tool-config'],
    'POST /api/mcp-connectors/:slug/oauth/start': ['tool-config'],
    'PATCH /api/mcp-settings': ['profile-row'],
    'PATCH /api/microsoft/accounts/:id/mail': ['mail-account'],
    'PUT /api/microsoft/config': ['tool-config'],
    'POST /api/microsoft/accounts/:id/drives': ['ms-account'],
    'POST /api/model-combos/apply': ['model-route'],
    // The destination and cost class: a pool entry added or
    // removed, the extraction concurrency; a new feed starts on (0325).
    'POST /api/model-pools': ['model-route'],
    'DELETE /api/model-pools/:id': ['model-route'],
    'PATCH /api/embedding/extraction': ['model-route'],
    'POST /api/calendar': ['feed-enable'],
    'POST /api/onboarding': ['profile-row'],
    'POST /api/openapi-connectors': ['tool-group-grant'],
    'PATCH /api/model-pools/:id': ['model-route'],
    'PATCH /api/openapi-connectors/:slug': ['tool-config'],
    'POST /api/peers': ['acting-login', 'peer-access'],
    'PATCH /api/peers/:id': ['peer-access'],
    'POST /api/peers/:id/rotate': ['peer-access'],
    'POST /api/peers/:id/shares': ['peer-share'],
    'PATCH /api/pending/:id': ['pending-call'],
    'POST /api/runs/:id': ['run-control'],
    'POST /api/settings/worker-groups': ['agent-group-grant'],
    'POST /api/skills': ['skill-text'],
    'POST /api/studio/prose': ['skill-text'],
    'POST /api/studio/reset': [
      'assistant-grant',
      'heartbeat-maker',
      'tool-config',
      'tool-group-grant',
    ],
    'POST /api/team-admin/invites': ['member-invite'],
    'PATCH /api/settings/worker-groups/:id': ['agent-group-grant'],
    'PATCH /api/skills/:id': ['skill-text'],
    'PATCH /api/team-admin/settings': ['profile-row'],
    'PATCH /api/telegram/chats/:id': ['telegram-responder'],
    'POST /api/tool-groups': ['tool-group-grant'],
    'POST /api/tools': ['tool-config'],
    'PUT /api/tools/settings': ['profile-row'],
    'PUT /api/tools/:id/external-access': ['tool-config'],
    'POST /api/users': ['login-credential'],
    'PATCH /api/tool-groups/:id': ['tool-config'],
    'PATCH /api/tools/:id': ['tool-config'],
    'PATCH /api/users/:id': ['login-credential'],
    'PUT /api/users/:id/agent': ['assistant-grant'],
    // The acting-login spot (0322): the definers that need the exit's
    // acting login (the structure items of the secrets, peers and email
    // contact routes, a Telegram chat's block or unpair, an assistant's
    // delete) run on the full route, where the gateway's SET carries it.
    'POST /api/agents/:id/telegram/chats': ['acting-login'],
    'POST /api/email/discover/contacts': ['acting-login'],
    'POST /api/secrets': ['acting-login'],
    'PATCH /api/secrets/:id': ['acting-login'],
    'DELETE /api/agents/:id': ['acting-login'],
    'DELETE /api/peers/:id': ['acting-login'],
    'DELETE /api/secrets/:id': ['acting-login'],
    // A switch turned on (0324: enabled, is_default and backup_enabled
    // only off on the narrow login): its spot.
    'POST /api/ai-workers/:id/default': ['model-route'],
    'PATCH /api/calendar/:id': ['feed-enable'],
    'PATCH /api/docs/collections/:id': ['docs-root'],
    'PATCH /api/microsoft/drives/:id': ['feed-enable'],
    'POST /api/users/:id/password': ['login-credential'],
    // 0327's hold on grants: a live grant of the owner rides on the client.
    'DELETE /api/mcp-clients/:id': ['login-credential'],
    'DELETE /api/mcp-connectors/:slug': ['tool-group-grant'],
    'DELETE /api/openapi-connectors/:slug': ['tool-group-grant'],
    'DELETE /api/tool-groups/:id': ['tool-group-grant'],
    'DELETE /api/users/:id': ['login-credential'],
    // 0327's hold on grants: the sample login is an Admin user.
    'DELETE /api/users/:id/devices/:jti': ['login-credential'],
    // 0327's hold: an Admin user's disable, and the owner's own sign-out
    // everywhere (its epoch, keys, grants and devices).
    [ADMIN_DISABLE]: ['login-credential'],
    [OWNER_LOGOUT_ALL]: ['login-credential'],
    [AZURE_PROVISION]: [
      'acting-login',
      'assistant-grant',
      'docs-root',
      'model-route',
      'profile-row',
      'tool-group-grant',
    ],
    [MS_CONNECT]: ['ms-account'],
  };

  it('pins the rows whose write runs at a spot, and which spots', () => {
    const on = Object.fromEntries([...spots.on].filter(([, s]) => s.length > 0));
    if (JSON.stringify(on) !== JSON.stringify(SPOT_ROWS)) {
      console.log(`narrow sweep: SPOT_ROWS now ${JSON.stringify(on, null, 1)}`);
    }
    expect(on).toEqual(SPOT_ROWS);
  });

  /**
   * The rows that do not answer 2xx, each with why. Every other row reaches its write and answers 2xx (the
   * fixture holds the row each path and body names). `after`: a refusal
   * the product answers once its write is done (the write is reached);
   * `offline`: the network or a box service is called before any write
   * (fetch throws here); `none`: the row has no database write of its own
   * (a provider probe, a child process).
   */
  const NOT_2XX: Readonly<Record<string, readonly ['after' | 'offline' | 'none', string]>> = {
    'GET /api/mcp-connectors/oauth/callback': [
      'after',
      'the pending authorization abandoned (tool_groups written), then the denial page',
    ],
    'POST /api/mcp-connectors/:slug/oauth/start': [
      'after',
      "the new pending state saved (tool_groups), then the provider's discovery fails",
    ],
    'POST /api/agents/:id/telegram': [
      'offline',
      "Telegram's getMe checks the bot token before the bot is saved",
    ],
    'POST /api/email/accounts': [
      'offline',
      'the IMAP login is tried before the account is saved (email_accounts is narrow all; PUT .../folders writes it on the narrow route)',
    ],
    'PATCH /api/email/accounts/:id': [
      'offline',
      'the IMAP login is tried before the change is saved',
    ],
    'POST /api/mcp-connectors/:slug/sync': [
      'offline',
      "the server's tool list is fetched before any write (the tool rows run at tool-group-grant)",
    ],
    'POST /api/openapi-connectors/:slug/sync': [
      'offline',
      'the spec is fetched before any write (the tool rows run at tool-group-grant)',
    ],
    'POST /api/openapi-connectors/preview': [
      'none',
      'reads a spec over the network, writes nothing',
    ],
    'GET /api/microsoft/oauth/callback': [
      'offline',
      'the table row sends no state cookie, so the sign-in is refused before any write (MS_CONNECT drives it with its cookies and Graph stubbed)',
    ],
    'POST /api/runners/:id': [
      'offline',
      "the runner engine's own system database (not this brain's) is not made here",
    ],
    'POST /api/dev-tools/mcp': [
      'none',
      'spawns the MCP server as a child process (its own pool), MANTLE_MCP_DIR not set here',
    ],
    'POST /api/debug/maintenance/run': [
      'none',
      'spawns a maintenance CLI as a child process (its own pool); the run row (maintenance_runs, narrow all) is not sent here',
    ],
    'POST /api/debug/maintenance/run/cancel': ['none', 'no run started here, so none to cancel'],
    'POST /api/agents/:id/test/chat': ['none', 'a provider probe (fetch throws), no write'],
    'POST /api/ai-workers/:id/test/chat': ['none', 'a provider probe, no write'],
    'POST /api/ai-workers/:id/test/decision': ['none', 'a provider probe, no write'],
    'POST /api/ai-workers/:id/test/document': ['none', 'a provider probe, no write'],
    'POST /api/ai-workers/:id/test/image': ['none', 'a provider probe, no write'],
    'POST /api/ai-workers/:id/test/stt': ['none', 'a provider probe, no write'],
    'POST /api/ai-workers/:id/test/tts': ['none', 'a provider probe, no write'],
    'POST /api/ai-workers/:id/test/vision': ['none', 'a provider probe, no write'],
    'POST /api/studio/sandbox': ['none', 'a no-persist sandbox turn: a provider call, no write'],
  };

  it('every row answers 2xx but the named ones, each with why', () => {
    const not2xx = [...answers.on].filter(([, a]) => !a.startsWith('2')).map(([k]) => k);
    expect(not2xx.sort()).toEqual(Object.keys(NOT_2XX).sort());
  });

  it('the Microsoft sign-in, a token refresh and a drive found, Graph stubbed: at the spot ms-account', () => {
    expect(ms.on).toEqual({
      callback: ms.on!.callback,
      discover: ms.on!.discover,
      account: true,
      refreshed: true,
      drive: 'found, enabled false',
    });
    expect(String(ms.on!.callback)).toMatch(/^30[27] connected$/);
    expect(String(ms.on!.discover)).toMatch(/^2/);
    expect(spots.on.get(MS_CONNECT)).toContain('ms-account');
    expect(denials.get(MS_CONNECT)).toEqual([]);
  });

  it('a documentation item from a real markdown file: made and updated', () => {
    // The reread updates the item in place: the same id, the new text,
    // none of the first left (upsertDocFromDisk through the definer).
    expect(docs.on).toEqual({
      made: 200,
      reread: 200,
      rereadOk: true,
      first: 1,
      left: 0,
      sameIds: true,
    });
    expect(docs.on!.first).toBeGreaterThan(0);
  });

  it('reports what each row answered (the handover reads the status counts)', () => {
    const counts: Record<string, number> = {};
    for (const a of answers.on.values()) {
      const s = a.slice(0, 1) + 'xx';
      counts[s] = (counts[s] ?? 0) + 1;
    }
    console.log(`narrow sweep: ${answers.on.size} rows driven; statuses`, counts);
    const report = process.env.MANTLE_SWEEP_REPORT;
    if (report) {
      const more = (k: string) => ({
        wrote: wrote.on.get(k) ?? [],
        spots: spots.on.get(k) ?? [],
      });
      const out: Record<string, unknown> = {};
      for (const [k, a] of answers.on) out[k] = { on: a, ...more(k) };
      for (const [k, a] of selfAnswers.on) out[`self ${k}`] = { on: a, ...more(`self ${k}`) };
      for (const [k, a] of readAnswers.on) out[`read ${k}`] = { on: a, ...more(`read ${k}`) };
      writeFileSync(report, JSON.stringify({ rows: out, docs }, null, 1));
    }
    expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(answers.on.size);
  });
});
