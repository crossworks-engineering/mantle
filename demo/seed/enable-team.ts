/**
 * Give the demo a team member, and give that member something to look at.
 *
 * The team portal (/team, /hub) is gated by a credential the edge CANNOT fake,
 * unlike the owner session. Two independent conditions have to hold:
 *
 *   1. `mantle_team_chat` is an HMAC over SESSION_SECRET, so Caddy cannot sign
 *      one — it is minted by demo/seed/mint-team-cookie.ts, same as the owner
 *      session is minted by mint-session.ts.
 *   2. `isTeamMember()` re-queries `contact_team_tokens` on EVERY call, by
 *      design, so removing someone locks them out mid-session. A perfectly
 *      signed cookie for a contact with no row is refused.
 *
 * So a visitor cannot be let in by cookie alone: one of the seeded contacts has
 * to genuinely become a member. That is a write, done here at seed time under
 * the owner role — the serve-time reader stays read-only.
 *
 * Membership alone would only move the demo from an honest locked door to an
 * empty room: the portal lists SHARED content, and a freshly seeded brain
 * shares nothing. So this also shares a representative slice of the brain with
 * the team, which is what makes the portal worth opening.
 *
 * Everything goes through the REAL endpoints — POST /api/contacts/:id/team and
 * the shares API — so the brain ends up in a state an owner could have reached
 * from the UI, the same principle enable-runs.ts follows.
 *
 *   pnpm -C server/web exec tsx ../../demo/seed/enable-team.ts
 */
const SERVER = process.env.DEMO_SERVER_URL ?? 'http://127.0.0.1:3902';
const OWNER_EMAIL = process.env.DEMO_OWNER_EMAIL ?? 'alex@harbourlabs.example.com';
const OWNER_PASSWORD = process.env.DEMO_OWNER_PASSWORD ?? 'demo-brain-not-a-real-password';

// How much of each kind to put in front of the member. Enough that every tab
// has something, not so much that the portal looks like the owner's whole
// brain — a member sees a deliberate slice, and the demo should show that.
const SHARE_COUNTS: Record<string, number> = {
  note: 6,
  page: 4,
  table: 2,
  task: 5,
  event: 3,
};

// Which list endpoint yields which node type, and the key its array sits under.
const SOURCES: { type: string; path: string; key: string }[] = [
  { type: 'note', path: '/api/notes?limit=40', key: 'notes' },
  { type: 'page', path: '/api/pages?limit=40', key: 'pages' },
  { type: 'table', path: '/api/tables?limit=40', key: 'tables' },
  { type: 'task', path: '/api/tasks?limit=40', key: 'tasks' },
  { type: 'event', path: '/api/events?limit=40', key: 'events' },
  // NO files. The portal's Files section is fed by shared FOLDERS (`branch` in
  // TEAM_WORKSPACE_TYPES) — `file` is not a member-surface type at all, so
  // sharing individual files creates links that appear nowhere in the portal.
  // The seeded brain has no folders, so that section stays honestly empty
  // until the generator grows one. Sharing files anyway would have looked like
  // progress in this script's output while changing nothing a visitor sees.
];

let cookie = '';
async function api(path: string, init: RequestInit = {}) {
  const res = await fetch(`${SERVER}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(cookie ? { cookie } : {}),
      ...(init.headers ?? {}),
    },
  });
  const sc = res.headers.getSetCookie?.() ?? [];
  if (sc.length) cookie = sc.map((c) => c.split(';')[0]).join('; ');
  return res;
}

async function json(path: string): Promise<Record<string, unknown> | null> {
  const res = await api(path);
  if (!res.ok) return null;
  return (await res.json().catch(() => null)) as Record<string, unknown> | null;
}

async function main() {
  const login = await api('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: OWNER_EMAIL, password: OWNER_PASSWORD }),
  });
  if (!login.ok) {
    console.error(`✗ login failed: ${login.status} ${(await login.text()).slice(0, 160)}`);
    process.exit(1);
  }

  // ── The member ────────────────────────────────────────────────────────────
  // Deterministic pick: contacts sorted by name, first one. A random member
  // would make the demo's "who am I" change on every re-seed.
  const contacts = (await json('/api/contacts?limit=100'))?.contacts as
    | { id: string; title: string; emails?: string[] }[]
    | undefined;
  if (!contacts?.length) {
    console.error('✗ no contacts on this brain — seed it first.');
    process.exit(1);
  }
  // Exclude the owner's own contact card. It sorts first alphabetically in the
  // seeded cast, and making the owner their own team member would show a
  // visitor the portal as the very person whose brain it is — which tells them
  // nothing about what a colleague sees.
  const candidates = contacts.filter(
    (c) => !(c.emails ?? []).some((e) => e.toLowerCase() === OWNER_EMAIL.toLowerCase()),
  );
  if (!candidates.length) {
    console.error('✗ the only contact is the owner — nobody to make a member.');
    process.exit(1);
  }
  const member = [...candidates].sort((a, b) => a.title.localeCompare(b.title))[0]!;

  const enable = await api(`/api/contacts/${member.id}/team`, {
    method: 'POST',
    body: JSON.stringify({ action: 'enable' }),
  });
  // 409 means they are already a member. `enable` deliberately refuses to
  // rotate a live token, so re-running this script must treat that as done
  // rather than as a failure — a seed step that breaks on its second run is
  // a seed step nobody can re-run.
  if (!enable.ok && enable.status !== 409) {
    console.error(`✗ enable team member failed: ${enable.status} ${(await enable.text()).slice(0, 200)}`);
    process.exit(1);
  }
  // The plaintext token crosses the wire exactly once here and is deliberately
  // NOT printed: nothing downstream needs it. The injected cookie is signed
  // from (ownerId, contactId), and the stored hash exists only so the liveness
  // check passes.
  console.log(`· member: ${member.title}${enable.status === 409 ? ' (already a member)' : ''}`);

  // ── Something for them to see ─────────────────────────────────────────────
  let created = 0;
  for (const src of SOURCES) {
    const want = SHARE_COUNTS[src.type] ?? 0;
    const body = await json(src.path);
    const items = (body?.[src.key] as { id: string }[] | undefined) ?? [];
    if (!items.length) {
      console.log(`  ${src.type.padEnd(6)} — nothing seeded, skipped`);
      continue;
    }
    let made = 0;
    for (const item of items.slice(0, want)) {
      const res = await api('/api/shares', { method: 'POST', body: JSON.stringify({ nodeId: item.id }) });
      if (!res.ok) continue;
      const out = (await res.json().catch(() => ({}))) as { share?: { id: string; mode?: string } };
      const shareId = out.share?.id;
      if (!shareId) continue;
      // Shares are born public; the portal is for TEAM admission.
      const patch = await api(`/api/shares/${shareId}`, {
        method: 'PATCH',
        body: JSON.stringify({ mode: 'team' }),
      });
      if (patch.ok) made++;
    }
    created += made;
    console.log(`  ${src.type.padEnd(6)} ${made} shared with the team`);
  }

  if (created === 0) {
    // Zero shares is the failure that would present as a working-but-empty
    // portal, which is exactly the shape of bug this demo keeps producing.
    console.error('✗ no shares created — the portal would open onto nothing.');
    process.exit(1);
  }
  console.log(`✓ team enabled: ${member.title}, ${created} shared items`);
}

main().catch((err) => {
  console.error('✗ enable-team failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
