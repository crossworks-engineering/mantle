/**
 * Mint the team-chat cookie the demo edge injects, so a visitor arrives at
 * /team and /hub already admitted as a member instead of meeting a token box.
 *
 * The sibling of mint-session.ts, and it exists for the same reason: the value
 * is an HMAC over SESSION_SECRET, so Caddy cannot sign one. The payload shape
 * is fixed by verifyTeamChatValue in server/web/lib/auth.ts —
 * `{ k:'c', own, cid, exp }` — and a mismatch fails closed, silently, as a
 * plain 401.
 *
 * The signature is only half of admission: `isTeamMember()` re-queries
 * contact_team_tokens on every call, so this mints for a contact that is
 * ALREADY a live member (demo/seed/enable-team.ts makes one) and refuses
 * otherwise rather than emitting a cookie that will be rejected.
 *
 * Safe here for the same reasons the owner session is: a brain of entirely
 * fictional content, an edge that refuses every write, and a database role that
 * cannot write anyway. It does mean every visitor is simultaneously the owner
 * on the app and a named member on the portal — deliberate, and the point of
 * the demo.
 *
 *   pnpm -C server/web exec tsx ../../demo/seed/mint-team-cookie.ts
 */
import { createHmac } from 'node:crypto';
import postgres from '../../server/web/node_modules/postgres/src/index.js';
import type { Sql } from './lib/types.ts';

const DB = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@127.0.0.1:56432/postgres';
const OWNER_EMAIL = process.env.DEMO_OWNER_EMAIL ?? 'alex@harbourlabs.example.com';
const SECRET = process.env.SESSION_SECRET;
const TTL_SECONDS = 365 * 24 * 60 * 60; // matches the owner session — one re-mint per re-seed

const b64url = (b: Buffer) => b.toString('base64url');

async function main() {
  if (!SECRET) {
    console.error('✗ SESSION_SECRET must be set — the SAME secret the demo app runs with.');
    process.exit(1);
  }
  const sql = postgres(DB, { onnotice: () => {} }) as unknown as Sql;

  const owner = await sql`select id from auth.users where email = ${OWNER_EMAIL} limit 1`;
  const ownerId = owner[0]?.id;
  if (!ownerId) {
    console.error(`✗ no owner ${OWNER_EMAIL} on this database — seed it first.`);
    process.exit(1);
  }

  // The oldest membership, so a re-mint is stable across runs rather than
  // hopping between members if more are ever enabled.
  const member = await sql`
    select contact_id from contact_team_tokens
    where owner_id = ${ownerId}
    order by created_at asc
    limit 1`;
  const contactId = member[0]?.contact_id;
  if (!contactId) {
    console.error('✗ no team member on this brain — run demo/seed/enable-team.ts first.');
    console.error('  (a signed cookie for a non-member is refused by the liveness check)');
    process.exit(1);
  }

  const exp = Math.floor(Date.now() / 1000) + TTL_SECONDS;
  const payload = b64url(
    Buffer.from(JSON.stringify({ k: 'c', own: String(ownerId), cid: String(contactId), exp }), 'utf8'),
  );
  const sig = b64url(createHmac('sha256', SECRET).update(payload).digest());

  // Value only, never logged elsewhere — the caller decides how it reaches the
  // edge config, so the cookie is never pasted by hand.
  process.stdout.write(`${payload}.${sig}\n`);
  await sql.end();
}

main().catch((err) => {
  console.error('✗ mint-team-cookie failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
