/**
 * People: the one gate of
 * every person-to-person read, and the card a login shares with its team.
 *
 * Mantle is a team system and every login is approved by hand, so what a
 * person shares with the team (its name, its description, avatar, photo and
 * presence; later a status, a time zone, a location shared on purpose) is
 * open to the team: the UI, the API and the agents. The description says
 * who the person is to the team ("Developer", "Jason's wife"), so an agent
 * asked to message "the developer" can tell who that is. It reaches a caller through this
 * module only. The rule, for a caller C and a login L:
 *
 *   C sees L when L is C itself; or L is in C's directory (a usable login,
 *   a mailbox and not disabled, that shares a live workspace with C; for an
 *   Admin user every usable login); or L is a person of a chat C is in, as
 *   C may see that room (never one who left before C joined; for a chat C
 *   left, only those added before it left; a disabled login stays visible
 *   there).
 *
 * Each read asks first whether the caller is an Admin user (loginIsAdmin),
 * then runs its one statement ("one query" below counts that statement).
 * Everything here reads on the system pool, by name: the caller is always
 * the authenticated login (the session's, or the MCP actor's), never an id
 * taken from a request, and every query names it in its own WHERE. Not
 * visible and not existing read the same (an empty list, null, false), so
 * a route answers both with its one 404. Agents are not logins: an agent's
 * card is the messenger's (the agents a login may chat with).
 */
import { sql, type SQL } from 'drizzle-orm';
import { liveWorkspaceSql, systemDb } from '@mantle/db';
import { isUuid } from '@mantle/std';
import { projectPersonDescription } from '@mantle/client-types/person-description';
import {
  logoVersion,
  projectAvatarParts,
  projectAvatarPhotoType,
  projectLogoKey,
  readAvatarStyle,
} from '@mantle/content-core/profile-projections';

// ── Limits ───────────────────────────────────────────────────────────────────

/** "Online": the login's stream beat within this long (login_presence). */
export const PEOPLE_ONLINE_MS = 2 * 60 * 1000;
/** The most ids one presence poll answers (GET /api/people/presence). */
export const PEOPLE_PRESENCE_MAX = 200;
/** The most cards one list answers (GET /api/people). */
export const PEOPLE_LIST_MAX = 1000;

// ── Types ────────────────────────────────────────────────────────────────────

/** Who asks: the authenticated login, in the brain `ownerId`. */
export type PeopleCaller = { ownerId: string; loginId: string };

/** An avatar drawn in the brain's one style: the shape GET /api/shell gives
 *  for the caller's own. */
export type PersonAvatarView = { style: string; seed: string; parts: unknown };

/** Idle and busy come with step 2 of section 23; this step sends online or
 *  offline only. */
export type PersonPresenceState = 'online' | 'idle' | 'busy' | 'offline';

export type PersonPresenceView = { state: PersonPresenceState; lastActiveAt: string | null };

/** A person as the team sees it (GET /api/people). */
export type PersonCardView = {
  id: string;
  name: string;
  /** Who the person is to the team, as they or an admin wrote it (the
   *  profile key `description`); null: none set. */
  description: string | null;
  /** null: the client draws initials. */
  avatar: PersonAvatarView | null;
  /** The uploaded photo's version, the `v` of GET /api/people/:id/photo;
   *  null when it has none. The photo outranks the avatar. */
  photoVersion: string | null;
  presence: PersonPresenceView;
  /** A status the person set (step 2: no column yet, always null). */
  status: { text: string; until: string | null } | null;
};

// ── Small helpers ────────────────────────────────────────────────────────────

type Exec = { execute: (q: SQL) => Promise<unknown> };

async function q<T>(on: Exec, query: SQL): Promise<T[]> {
  return (await on.execute(query)) as unknown as T[];
}

function uuidArray(ids: readonly string[]): SQL {
  return sql`${`{${ids.join(',')}}`}::uuid[]`;
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** The presence of a login_presence time, now. */
export function presenceOf(lastActiveAt: Date | null, now = Date.now()): PersonPresenceView {
  return {
    state: lastActiveAt && now - lastActiveAt.getTime() < PEOPLE_ONLINE_MS ? 'online' : 'offline',
    lastActiveAt: lastActiveAt ? lastActiveAt.toISOString() : null,
  };
}

// ── Faces: the avatar and the photo ──────────────────────────────────────────

/** The brain's one avatar style (Settings > Appearance), from the anchor's
 *  profile row: a brain-level key (BRAIN_PREFERENCE_KEYS). A subquery each
 *  face query carries, so a face costs no extra round trip. */
const BRAIN_STYLE = (ownerId: string) =>
  sql`(select b.preferences->'avatarStyle' from profiles b where b.user_id = ${ownerId}::uuid)`;

/** The face columns of a login's own profile row `pr` (left joined): its
 *  seed, builder parts and photo pointer, the brain's style, and the
 *  description the card carries next to the face. */
const LOGIN_FACE_COLUMNS = (ownerId: string) =>
  sql`pr.preferences->'avatarSeed' as seed, pr.preferences->'avatarParts' as parts,
      pr.preferences->'avatarPhotoKey' as photo_key, pr.preferences->'avatarPhotoType' as photo_type,
      ${BRAIN_STYLE(ownerId)} as style, pr.preferences->'description' as description`;

/** A login's description as text, for a search to match ('' when none). */
const LOGIN_DESCRIPTION = sql`coalesce(pr.preferences->>'description', '')`;

/** A login's shown name: its display name, else the mailbox part. */
const LOGIN_NAME = sql`coalesce(nullif(btrim(u.display_name), ''), split_part(coalesce(u.email, ''), '@', 1), 'User')`;

type LoginFaceRow = {
  seed: unknown;
  parts: unknown;
  photo_key: unknown;
  photo_type: unknown;
  style: unknown;
  description: unknown;
};

/** A login's avatar and photo version, as GET /api/shell projects its own:
 *  no seed is initials (a real choice), and a photo counts only when its
 *  key and type both project (else the photo route answers 404). */
function loginFace(r: LoginFaceRow): {
  avatar: PersonAvatarView | null;
  photoVersion: string | null;
  description: string | null;
} {
  const seed = typeof r.seed === 'string' && r.seed.length > 0 ? r.seed : null;
  const key = projectLogoKey(r.photo_key);
  return {
    avatar: seed
      ? { style: readAvatarStyle(r.style), seed, parts: projectAvatarParts(r.parts) ?? null }
      : null,
    photoVersion: key && projectAvatarPhotoType(r.photo_type) ? logoVersion(key) : null,
    description: projectPersonDescription(r.description),
  };
}

/** An agent's avatar (agents.avatar) in the brain's style: the seed, else
 *  the slug (what GET /api/agents/:id/avatar draws); null when the agent
 *  has none. */
function agentFace(avatar: unknown, slug: string, style: unknown): PersonAvatarView | null {
  if (!avatar || typeof avatar !== 'object' || Array.isArray(avatar)) return null;
  const a = avatar as { seed?: unknown; parts?: unknown };
  const seed = typeof a.seed === 'string' && a.seed.length > 0 ? a.seed : slug;
  return { style: readAvatarStyle(style), seed, parts: projectAvatarParts(a.parts) ?? null };
}

/**
 * The names and faces of the logins of `ids` that `caller` may see (the
 * messenger's room people), one query through the gate (after the Admin
 * check, loginIsAdmin): an id outside it
 * is left out, as an unknown one is. `caller` must be the authenticated
 * login.
 */
export async function loginFaces(
  caller: PeopleCaller,
  ids: readonly string[],
): Promise<
  Map<
    string,
    {
      name: string;
      avatar: PersonAvatarView | null;
      photoVersion: string | null;
      description: string | null;
    }
  >
> {
  const wanted = ids.filter(isUuid);
  if (wanted.length === 0) return new Map();
  const admin = await loginIsAdmin(caller.loginId);
  const rows = await q<{ id: string; name: string } & LoginFaceRow>(
    systemDb,
    sql`select u.id::text as id, ${LOGIN_NAME} as name, ${LOGIN_FACE_COLUMNS(caller.ownerId)}
          from auth.users u
          left join profiles pr on pr.user_id = u.id
         where u.id = any(${uuidArray(wanted)}) and ${visible(caller, admin)}`,
  );
  return new Map(rows.map((r) => [r.id, { name: r.name, ...loginFace(r) }]));
}

/** Agents' names and faces, one query (the agents a gated read returned,
 *  of the brain `ownerId`). Agents are not people: no gate of this module
 *  holds them. */
export async function agentFaces(
  ownerId: string,
  ids: readonly string[],
): Promise<Map<string, { name: string; avatar: PersonAvatarView | null }>> {
  const wanted = ids.filter(isUuid);
  if (wanted.length === 0) return new Map();
  const rows = await q<{ id: string; name: string; slug: string; avatar: unknown; style: unknown }>(
    systemDb,
    sql`select a.id::text as id, a.name, a.slug, a.avatar, ${BRAIN_STYLE(ownerId)} as style
          from agents a
         where a.id = any(${uuidArray(wanted)}) and a.owner_id = ${ownerId}::uuid`,
  );
  return new Map(
    rows.map((r) => [r.id, { name: r.name, avatar: agentFace(r.avatar, r.slug, r.style) }]),
  );
}

// ── The gate ─────────────────────────────────────────────────────────────────

/** Whether a login is an Admin user (a user of the live Admin workspace). */
export async function loginIsAdmin(loginId: string): Promise<boolean> {
  const [row] = await q<{ admin: boolean }>(
    systemDb,
    sql`select coalesce("public"."mantle_login_is_admin"(${loginId}::uuid), false) as admin`,
  );
  return row?.admin === true;
}

/**
 * The people of each conversation `loginId` is in, as it may see them (the
 * rows of mantle_messenger_people, migration 0336, which answers the same
 * for a workspace scope's own login): never one who left before it joined;
 * for a conversation it left, only those added before it left, and a later
 * leave shown as not yet. Judged by seqs. Named by the login, for the
 * system pool. `cs` is a uuid[] expression.
 */
export function roomPeopleSql(loginId: string, cs: SQL): SQL {
  return sql`(select p.conversation_id, p.kind, coalesce(p.login_id, p.agent_id) as id, p.admin,
                     p.joined_at,
                     case when me.left_seq is null or p.left_seq <= me.left_seq
                          then p.left_at end as left_at
                from messenger_participants me
                join messenger_participants p on p.conversation_id = me.conversation_id
               where me.kind = 'login' and me.login_id = ${loginId}::uuid
                 and me.conversation_id = any(${cs})
                 and (me.left_seq is null or p.from_seq < me.left_seq)
                 and (p.left_seq is null or p.left_seq > me.from_seq))`;
}

/** The directory part of the rule as a condition on `u` (auth.users): a
 *  usable login other than the caller that shares a live workspace with it
 *  (every usable login for an Admin user: `admin`, loginIsAdmin's answer
 *  for the caller). */
function directoryReach(caller: PeopleCaller, admin: boolean): SQL {
  const shared = admin
    ? sql``
    : sql`and exists (
            select 1 from workspace_users mine
              join workspace_users theirs on theirs.workspace_id = mine.workspace_id
              join workspaces w on w.id = mine.workspace_id and ${liveWorkspaceSql('w')}
             where mine.login_id = ${caller.loginId}::uuid and theirs.login_id = u.id)`;
  return sql`(u.id <> ${caller.loginId}::uuid and u.email is not null and u.disabled_at is null ${shared})`;
}

/** Every login `caller` may see (the rule above), as a condition on `u`
 *  (auth.users): itself, its directory, the people of its chats. */
function visible(caller: PeopleCaller, admin: boolean): SQL {
  const myChats = sql`array(select me.conversation_id from messenger_participants me
                              join messenger_conversations c on c.id = me.conversation_id
                             where me.kind = 'login' and me.login_id = ${caller.loginId}::uuid
                               and c.owner_id = ${caller.ownerId}::uuid)`;
  return sql`(u.id = ${caller.loginId}::uuid
              or ${directoryReach(caller, admin)}
              or u.id in (select x.id from ${roomPeopleSql(caller.loginId, myChats)} x
                           where x.kind = 'login'))`;
}

/**
 * The caller's directory: who it may start a chat with or add to a group.
 * The usable logins that share a live workspace with it, or every usable
 * login for an Admin user; never itself. One query, with each login's face
 * and presence time. `caller` must be the authenticated login.
 */
export async function peopleVisibleTo(
  caller: PeopleCaller,
  opts: { only?: readonly string[]; q?: string; limit?: number } = {},
): Promise<
  {
    id: string;
    name: string;
    lastActiveAt: Date | null;
    avatar: PersonAvatarView | null;
    photoVersion: string | null;
    description: string | null;
  }[]
> {
  const admin = await loginIsAdmin(caller.loginId);
  const only = opts.only ? sql`and u.id = any(${uuidArray(opts.only)})` : sql``;
  // The name the caller is shown or the description the card carries
  // ("developer" finds the developer), never the mailbox behind them: an
  // address is not something a person shares with the team.
  const pattern = opts.q ? '%' + escapeLike(opts.q) + '%' : '';
  const like = opts.q
    ? sql`and (${LOGIN_NAME} ilike ${pattern} or ${LOGIN_DESCRIPTION} ilike ${pattern})`
    : sql``;
  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 500);
  const rows = await q<{ id: string; name: string; last_active_at: Date | null } & LoginFaceRow>(
    systemDb,
    sql`select u.id::text as id, ${LOGIN_NAME} as name,
               p.last_active_at, ${LOGIN_FACE_COLUMNS(caller.ownerId)}
          from auth.users u
          left join login_presence p on p.login_id = u.id
          left join profiles pr on pr.user_id = u.id
         where ${directoryReach(caller, admin)} ${only} ${like}
         order by 2
         limit ${limit}`,
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    lastActiveAt: r.last_active_at ? new Date(r.last_active_at) : null,
    ...loginFace(r),
  }));
}

/**
 * Whether `caller` may see `loginId` (the rule above). false for an id that
 * is no uuid, an unknown login and an agent id. One query, no face read.
 * `caller` must be the authenticated login.
 */
export async function loginVisibleTo(caller: PeopleCaller, loginId: string): Promise<boolean> {
  if (!isUuid(loginId)) return false;
  const target = loginId.toLowerCase();
  if (target === caller.loginId.toLowerCase()) return true;
  const admin = await loginIsAdmin(caller.loginId);
  const [hit] = await q<{ ok: number }>(
    systemDb,
    sql`select 1 as ok from auth.users u
         where u.id = ${target}::uuid and ${visible(caller, admin)}
         limit 1`,
  );
  return !!hit;
}

/**
 * The cards of every login `caller` may see (GET /api/people), or of the
 * ones of `only` it may see (GET /api/people/:id), itself included, by
 * name. One query.
 */
export async function personCards(
  caller: PeopleCaller,
  opts: { only?: readonly string[] } = {},
): Promise<PersonCardView[]> {
  const ids = opts.only?.filter(isUuid).map((id) => id.toLowerCase());
  if (ids && ids.length === 0) return [];
  const admin = await loginIsAdmin(caller.loginId);
  const only = ids ? sql`and u.id = any(${uuidArray(ids)})` : sql``;
  const rows = await q<{ id: string; name: string; last_active_at: Date | null } & LoginFaceRow>(
    systemDb,
    sql`select u.id::text as id, ${LOGIN_NAME} as name,
               p.last_active_at, ${LOGIN_FACE_COLUMNS(caller.ownerId)}
          from auth.users u
          left join login_presence p on p.login_id = u.id
          left join profiles pr on pr.user_id = u.id
         where ${visible(caller, admin)} ${only}
         order by 2, 1
         limit ${PEOPLE_LIST_MAX}`,
  );
  const now = Date.now();
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    ...loginFace(r),
    presence: presenceOf(r.last_active_at ? new Date(r.last_active_at) : null, now),
    status: null,
  }));
}

/**
 * The presence of the logins of `ids` that `caller` may see (GET
 * /api/people/presence, the cheap poll): the others are left out, as an
 * unknown id is. At most PEOPLE_PRESENCE_MAX ids (the caller cuts the
 * list); ids that are no uuid are dropped. One query.
 */
export async function peoplePresence(
  caller: PeopleCaller,
  ids: readonly string[],
): Promise<({ id: string } & PersonPresenceView)[]> {
  const wanted = [...new Set(ids.filter(isUuid).map((id) => id.toLowerCase()))].slice(
    0,
    PEOPLE_PRESENCE_MAX,
  );
  if (wanted.length === 0) return [];
  const admin = await loginIsAdmin(caller.loginId);
  const rows = await q<{ id: string; last_active_at: Date | null }>(
    systemDb,
    sql`select u.id::text as id, p.last_active_at
          from auth.users u
          left join login_presence p on p.login_id = u.id
         where u.id = any(${uuidArray(wanted)}) and ${visible(caller, admin)}`,
  );
  const now = Date.now();
  return rows.map((r) => ({
    id: r.id,
    ...presenceOf(r.last_active_at ? new Date(r.last_active_at) : null, now),
  }));
}

/**
 * The uploaded photo of `loginId` as `caller` may fetch it (GET
 * /api/people/:id/photo): the stored pointer (a content key and a raster
 * type, both projected) when the caller sees that login and it has a
 * photo; null otherwise, with no difference between "no such login", "not
 * yours to see" and "no photo" (the route's one 404). One query: the
 * pointer is read only in the row the gate let through.
 */
export async function personPhoto(
  caller: PeopleCaller,
  loginId: string,
): Promise<{ key: string; type: string; version: string } | null> {
  if (!isUuid(loginId)) return null;
  const admin = await loginIsAdmin(caller.loginId);
  const [row] = await q<{ photo_key: unknown; photo_type: unknown }>(
    systemDb,
    sql`select pr.preferences->'avatarPhotoKey' as photo_key,
               pr.preferences->'avatarPhotoType' as photo_type
          from auth.users u
          left join profiles pr on pr.user_id = u.id
         where u.id = ${loginId.toLowerCase()}::uuid and ${visible(caller, admin)}`,
  );
  const key = projectLogoKey(row?.photo_key);
  const type = projectAvatarPhotoType(row?.photo_type);
  const version = logoVersion(key);
  return key && type && version ? { key, type, version } : null;
}
