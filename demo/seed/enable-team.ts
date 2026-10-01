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
 *      studio is five people besides the owner, so all five get one: the
 *      Team screen then shows a team, not a row.
 *   2. An item is shown to the team by its LEVEL. Folders carry most of it
 *      (the seeder shares the Studio Handbook with the team). Tables have no
 *      shared folder here, so two of them are set to team level one by one
 *      (`PATCH /api/access/nodes/:id`). Tasks and events can no longer be
 *      shown to a member at all: they are admin-only kinds on main.
 *   3. The member chat opens when the `team-responder` agent is at team
 *      level, and the brain refuses that while the agent holds a tool group
 *      above team level (`group_above_agent`). On a FRESH brain all three of
 *      its groups are admin level (migration 0159 lowered `team-read` and
 *      `formulas-eval` only on brains that existed then). So, in the order
 *      the rule asks for: the admin-only group comes off the agent, the two
 *      member-facing groups go to team level, then the agent does. The seed
 *      changes; the brain's rule does not.
 *   4. One client login, for the person who approves the PUMPHOUSE procedure
 *      revisions, which sit in the folder the seeder shares with clients. The
 *      brain refuses a client login until an admin has acknowledged the list
 *      of everything clients can read, so this reads that list and
 *      acknowledges exactly it (by its fingerprint), as the dialog does.
 *
 * Membership alone would be an empty room, so the script signs in AS a member
 * at the end and fails when that member's Library is empty.
 *
 * Everything goes through the real endpoints, so the brain ends up in a state
 * an owner could have reached from the UI. Safe to run again: a login that is
 * already there is a 409, which is treated as done.
 *
 *   pnpm -C server/web exec tsx ../../demo/seed/enable-team.ts
 */
const SERVER = process.env.DEMO_SERVER_URL ?? 'http://127.0.0.1:3902';
const OWNER_EMAIL = process.env.DEMO_OWNER_EMAIL ?? 'alex@harbourlabs.example.com';
const OWNER_PASSWORD = process.env.DEMO_OWNER_PASSWORD ?? 'demo-brain-not-a-real-password';
// Fictional people on a documentation domain, on a brain that holds only
// generated content: like the owner's, this is not a secret.
const MEMBER_PASSWORD = process.env.DEMO_MEMBER_PASSWORD ?? 'demo-member-not-a-real-password';
// The client contact who gets the one client login (demo/world/world.json).
const CLIENT_EMAIL = process.env.DEMO_CLIENT_EMAIL ?? 'g.bekker@meridianww.example.org';
// Tables a colleague would work in. Shown to the team by level; everything
// else the team sees comes from the shared handbook folder.
const TEAM_TABLES = ['Studio risk register', 'PS3 snag list'];

const TEAM_RESPONDER = 'team-responder';

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

  // ── 2. Team-level tables ──────────────────────────────────────────────────
  const tables = (await json<{ tables?: Array<{ id: string; title: string }> }>(owner, '/api/tables?limit=100')).tables ?? [];
  for (const title of TEAM_TABLES) {
    const t = tables.find((x) => x.title === title);
    if (!t) throw new Error(`table "${title}" is not on this brain (the generator renamed it?)`);
    const res = await call(owner, 'PATCH', `/api/access/nodes/${t.id}`, { audience: 'team' });
    if (!res.ok) throw new Error(`table "${title}" → team: ${res.status} ${(await res.text()).slice(0, 200)}`);
    console.log(`· team level: table "${title}"`);
  }

  // ── 3. The member chat ────────────────────────────────────────────────────
  // An agent may hold only tool groups at or below its own level. So the
  // admin-only group comes off, the groups it keeps go to team level, and
  // only then does the agent. Any other order is refused
  // (`group_above_agent`).
  const agents = (await json<{ agents?: Array<{ id: string; slug: string; toolGroupSlugs?: string[] }> }>(owner, '/api/agents')).agents ?? [];
  const responder = agents.find((a) => a.slug === TEAM_RESPONDER);
  if (!responder) throw new Error(`no '${TEAM_RESPONDER}' agent on this brain`);
  const keep = (responder.toolGroupSlugs ?? []).filter((g) => g !== 'team-read-admin');
  let res = await call(owner, 'PATCH', `/api/agents/${responder.id}`, { toolGroupSlugs: keep });
  if (!res.ok) throw new Error(`${TEAM_RESPONDER} tool groups: ${res.status} ${(await res.text()).slice(0, 200)}`);
  for (const slug of keep) {
    res = await call(owner, 'PATCH', `/api/access/tool-groups/${slug}`, { audience: 'team' });
    if (!res.ok) throw new Error(`tool group ${slug} → team: ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
  res = await call(owner, 'PATCH', `/api/access/agents/${TEAM_RESPONDER}`, { audience: 'team' });
  if (!res.ok) throw new Error(`${TEAM_RESPONDER} → team: ${res.status} ${(await res.text()).slice(0, 200)}`);
  console.log(`· member chat open: ${TEAM_RESPONDER} at team level, tool groups ${keep.join(', ') || '(none)'}`);

  // ── 4. One client login ───────────────────────────────────────────────────
  const clientContact = contacts.find((c) => emailOf(c) === CLIENT_EMAIL.toLowerCase());
  if (!clientContact) throw new Error(`no contact with ${CLIENT_EMAIL}: nobody to make a client login for`);
  const report = await json<{ total: number; acknowledged: boolean; fingerprint?: string }>(owner, '/api/access/client-report');
  if (report.total === 0) {
    // A client login with nothing to read is the empty room again.
    throw new Error('nothing is at client level: the seeder shares a folder with clients, did that step run?');
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

  // ── 5. Prove it from the member's side ────────────────────────────────────
  const first = colleagues[0]!;
  const member: Jar = { cookie: '' };
  await login(member, emailOf(first), MEMBER_PASSWORD);
  const library = await json<{ total: number }>(member, '/api/member/library');
  const chat = await json<{ agent: { slug: string } | null }>(member, '/api/member/chat');
  if (library.total === 0) {
    // Zero is the failure that would present as a working-but-empty portal.
    throw new Error(`${first.title} signs in to an empty Library: nothing is at team level`);
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
