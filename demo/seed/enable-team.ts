/**
 * Give the demo a team and a client, the way main does it now.
 *
 * Until v0.232.200 a team member was a CONTACT with a token (`POST
 * /api/contacts/:id/team`), admitted to a portal by its own cookie, and an
 * item was shown to the team by a share link in `team` mode. Main retired all
 * three (member logins, migrations 0162 to 0178): the route answers 404, the
 * `contact_team_tokens` table is dropped, and `PATCH /api/shares/:id { mode:
 * 'team' }` is refused. What replaced them, and what this script does:
 *
 *   1. A team member IS a login with role `member` (`POST /api/users`). The
 *      studio is two engineers besides the owner, and both get one.
 *   2. An item is shown to the team or to clients by the FOLDER it sits in:
 *      the seeder shares each workspace's Team and Client folders
 *      (generator/content/folders.mjs). Tasks, events, contacts and secrets
 *      can never be shown to a member: they are admin-only kinds on main.
 *   3. The member chat opens when the `team-responder` agent is at team
 *      level, and the brain refuses that while the agent holds a tool group
 *      above team level (`group_above_agent`). On a FRESH brain all three of
 *      its groups are admin level (migration 0159 lowered `team-read` and
 *      `formulas-eval` only on brains that existed then). So, in the order
 *      the rule asks for: every group that is not on the member allowlist
 *      comes off the agent, the two member-facing groups go to team level,
 *      then the agent does. The seed
 *      changes; the brain's rule does not.
 *   4. One client login, for Gordon Bekker at Meridian, who approves the
 *      procedure revisions in the Client folders. The
 *      brain refuses a client login until an admin has acknowledged the list
 *      of everything clients can read, so this reads that list and
 *      acknowledges exactly it (by its fingerprint), as the dialog does.
 *
 * Membership alone would be an empty room, so the script signs in AS a member
 * at the end and fails when that member's Library is not exactly what the
 * generator shared.
 *
 * Everything goes through the real endpoints, so the brain ends up in a state
 * an owner could have reached from the UI. Safe to run again: a login that is
 * already there is a 409, which is treated as done.
 *
 *   pnpm -C server/web exec tsx ../../demo/seed/enable-team.ts
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { memberPassword, ownerPassword } from './lib/secrets.ts';
import type { Manifest } from './lib/types.ts';

const MANIFEST = join(dirname(fileURLToPath(import.meta.url)), '..', 'generator', 'out', 'manifest.json');

const SERVER = process.env.DEMO_SERVER_URL ?? 'http://127.0.0.1:3902';
const OWNER_EMAIL = process.env.DEMO_OWNER_EMAIL ?? 'alex@harbourlabs.example.com';
const OWNER_PASSWORD = ownerPassword();
// One password for the five member logins, made per checkout like the
// owner's (demo/scripts/lib/secrets.sh) and never committed.
const MEMBER_PASSWORD = memberPassword();
// The client contact who gets the one client login (demo/world/world.json).
const CLIENT_EMAIL = process.env.DEMO_CLIENT_EMAIL ?? 'g.bekker@meridianww.example.org';
const TEAM_RESPONDER = 'team-responder';
// The tool groups a member-facing responder keeps. An ALLOWLIST: lowering
// "whatever it holds" would hand a team-level agent any group a later
// release adds to it. (A fresh brain has these two at admin level; when main
// seeds them at team level, lowering them here becomes a no-op.)
const MEMBER_TOOL_GROUPS = ['team-read', 'formulas-eval'];

type Jar = { cookie: string };
const owner: Jar = { cookie: '' };

async function api(jar: Jar, path: string, init: RequestInit = {}) {
  const res = await fetch(`${SERVER}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(jar.cookie ? { cookie: jar.cookie } : {}),
      ...(init.headers ?? {}),
    },
  });
  const sc = res.headers.getSetCookie?.() ?? [];
  if (sc.length) jar.cookie = sc.map((c) => c.split(';')[0]).join('; ');
  return res;
}
const call = (jar: Jar, method: string, path: string, body?: unknown) =>
  api(jar, path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

async function json<T>(jar: Jar, path: string): Promise<T> {
  const res = await api(jar, path);
  if (!res.ok) throw new Error(`GET ${path} → ${res.status} ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as T;
}

async function login(jar: Jar, email: string, password: string) {
  const res = await call(jar, 'POST', '/api/auth/login', { email, password });
  if (!res.ok) throw new Error(`login ${email} → ${res.status} ${(await res.text()).slice(0, 160)}`);
}

type Contact = { id: string; title: string; emails?: string[] };

async function main() {
  // WHAT may be shown to whom comes from the generator, never from this
  // script and never from "whatever the brain reports": how many items each
  // shared folder reaches. Every count below is compared with these, and a
  // difference stops the script before it acknowledges or confirms anything.
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8')) as Manifest;
  const folders = manifest.folders ?? [];
  const sharedWith = (share: 'team' | 'client') => new Set(folders.filter((f) => f.share === share).map((f) => f.id));
  // Every item that can sit in a tree, with its node type and folder.
  const placedItems: Array<{ type: string; folder: string | null }> = [
    ...manifest.nodes.map((n) => ({ type: n.kind, folder: n.meta.folder ?? null })),
    ...manifest.tables.map((t) => ({ type: 'table', folder: t.folder ?? null })),
    ...manifest.files.map((f) => ({ type: 'file', folder: f.folder ?? null })),
    ...(manifest.draws ?? []).map((d) => ({ type: 'draw', folder: d.folder ?? null })),
    ...(manifest.apps ?? []).map((a) => ({ type: 'app', folder: a.folder ?? null })),
  ];
  const countIn = (ids: Set<string>, types?: string[]) =>
    placedItems.filter((x) => x.folder && ids.has(x.folder) && (!types || types.includes(x.type))).length;
  const expectClientItems = countIn(sharedWith('client'));
  // The Library lists these kinds only (MEMBER_ITEM_KINDS on main).
  const LIBRARY_KINDS = ['page', 'note', 'draw', 'table', 'file'];
  const expectLibrary = countIn(sharedWith('team'), LIBRARY_KINDS) + countIn(sharedWith('client'), LIBRARY_KINDS);
  if (!expectClientItems || !expectLibrary) {
    throw new Error('the manifest shares no folders: regenerate (node demo/generator/gen.mjs)');
  }

  await login(owner, OWNER_EMAIL, OWNER_PASSWORD);

  const contacts = (await json<{ contacts?: Contact[] }>(owner, '/api/contacts?limit=100')).contacts ?? [];
  if (!contacts.length) throw new Error('no contacts on this brain: seed it first');
  const emailOf = (c: Contact) => (c.emails ?? [])[0]?.toLowerCase() ?? '';

  // ── 1. The team: the owner's own colleagues ───────────────────────────────
  // By email domain, not by sort order: the first contact by name is only a
  // colleague by luck, and a client's contact must never become a member.
  const domain = OWNER_EMAIL.split('@')[1]!.toLowerCase();
  const colleagues = contacts
    .filter((c) => emailOf(c).endsWith(`@${domain}`) && emailOf(c) !== OWNER_EMAIL.toLowerCase())
    .sort((a, b) => a.title.localeCompare(b.title));
  if (!colleagues.length) throw new Error(`no contact on ${domain} besides the owner: nobody to make a member`);
  for (const c of colleagues) {
    const res = await call(owner, 'POST', '/api/users', {
      email: emailOf(c),
      password: MEMBER_PASSWORD,
      displayName: c.title,
      role: 'member',
      contactId: c.id,
    });
    // 409: the login (or a login for this contact) is already there.
    if (!res.ok && res.status !== 409) {
      throw new Error(`member ${c.title}: ${res.status} ${(await res.text()).slice(0, 200)}`);
    }
    console.log(`· member: ${c.title}${res.status === 409 ? ' (already a login)' : ''}`);
  }

  // ── 2. The member chat ────────────────────────────────────────────────────
  // An agent may hold only tool groups at or below its own level. So the
  // admin-only group comes off, the groups it keeps go to team level, and
  // only then does the agent. Any other order is refused
  // (`group_above_agent`).
  const agents = (await json<{ agents?: Array<{ id: string; slug: string; toolGroupSlugs?: string[] }> }>(owner, '/api/agents')).agents ?? [];
  const responder = agents.find((a) => a.slug === TEAM_RESPONDER);
  if (!responder) throw new Error(`no '${TEAM_RESPONDER}' agent on this brain`);
  const keep = (responder.toolGroupSlugs ?? []).filter((g) => MEMBER_TOOL_GROUPS.includes(g));
  if (!keep.length) throw new Error(`${TEAM_RESPONDER} holds none of ${MEMBER_TOOL_GROUPS.join(', ')}: it would answer with no tools`);
  let res = await call(owner, 'PATCH', `/api/agents/${responder.id}`, { toolGroupSlugs: keep });
  if (!res.ok) throw new Error(`${TEAM_RESPONDER} tool groups: ${res.status} ${(await res.text()).slice(0, 200)}`);
  for (const slug of keep) {
    res = await call(owner, 'PATCH', `/api/access/tool-groups/${slug}`, { audience: 'team' });
    if (!res.ok) throw new Error(`tool group ${slug} → team: ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
  res = await call(owner, 'PATCH', `/api/access/agents/${TEAM_RESPONDER}`, { audience: 'team' });
  if (!res.ok) throw new Error(`${TEAM_RESPONDER} → team: ${res.status} ${(await res.text()).slice(0, 200)}`);
  console.log(`· member chat open: ${TEAM_RESPONDER} at team level, tool groups ${keep.join(', ') || '(none)'}`);

  // ── 3. One client login ───────────────────────────────────────────────────
  const clientContact = contacts.find((c) => emailOf(c) === CLIENT_EMAIL.toLowerCase());
  if (!clientContact) throw new Error(`no contact with ${CLIENT_EMAIL}: nobody to make a client login for`);
  const report = await json<{ total: number; acknowledged: boolean; fingerprint?: string }>(owner, '/api/access/client-report');
  // Acknowledging the report says "an admin read this list and it is right".
  // Nobody reads it here, so the script may only acknowledge the list the
  // generator intended: exactly the items of the client-shared folders. One
  // more would be something published to clients that nobody chose; fewer
  // (or none) means the share step did not run.
  if (report.total !== expectClientItems) {
    throw new Error(
      `the client report lists ${report.total} item(s) at client level, the generator intends ${expectClientItems}. ` +
        'NOT acknowledged, and no client login made.',
    );
  }
  if (!report.acknowledged) {
    if (!report.fingerprint) throw new Error('the client report carries no fingerprint to acknowledge');
    res = await call(owner, 'POST', '/api/access/client-report/ack', { fingerprint: report.fingerprint });
    if (!res.ok) throw new Error(`client report ack: ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
  res = await call(owner, 'POST', '/api/team-admin/clients', { contactId: clientContact.id });
  if (!res.ok && res.status !== 409) {
    throw new Error(`client login ${clientContact.title}: ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
  console.log(
    `· client login: ${clientContact.title}${res.status === 409 ? ' (already there)' : ''}, ${report.total} item(s) at client level, list acknowledged`,
  );

  // ── 4. Prove it from the member's side ────────────────────────────────────
  const first = colleagues[0]!;
  const member: Jar = { cookie: '' };
  await login(member, emailOf(first), MEMBER_PASSWORD);
  const library = await json<{ total: number }>(member, '/api/member/library');
  const chat = await json<{ agent: { slug: string } | null }>(member, '/api/member/chat');
  // A member's Library holds the team items and the client items of the
  // Library kinds. Exactly what was intended: zero is a working-but-empty
  // portal, and more is an item a colleague can read that nobody meant to share.
  if (library.total !== expectLibrary) {
    throw new Error(`${first.title}'s Library holds ${library.total} item(s); intended ${expectLibrary} (pages, notes, drawings, tables and files in the team and client folders)`);
  }
  if (!chat.agent) throw new Error(`${first.title} signs in, but the member chat is not open`);
  // A member must NOT reach an owner route: the same cookie name carries both.
  const refused = await api(member, '/api/contacts?limit=1');
  if (refused.ok) throw new Error('a member login can read /api/contacts: it was made an admin');
  console.log(
    `✓ team enabled: ${colleagues.length} member login(s); ${first.title} sees ${library.total} Library item(s) and the chat with ${chat.agent.slug}`,
  );
}

main().catch((err) => {
  console.error('✗ enable-team failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
