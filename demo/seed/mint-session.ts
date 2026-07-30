/**
 * Mint the long-lived session cookie the demo edge injects for every visitor.
 *
 * Caddy cannot SIGN a session — the cookie is an HMAC over SESSION_SECRET — so
 * the value is minted once here and baked into the edge config. A visitor
 * therefore arrives already authenticated as the demo owner and never sees a
 * login screen, without the app knowing anything about "demo mode".
 *
 * This is safe ONLY because of what the session can reach: a brain of entirely
 * fictional content, behind an edge that refuses every write, on a database
 * role that cannot write anyway. The cookie is the least sensitive credential
 * in the fleet — it is closer to a public URL than to a password.
 *
 * TTL is one year, which ties re-minting to the quarterly re-seed rather than
 * making it a separate thing to remember.
 *
 *   pnpm -C server/web exec tsx ../../demo/seed/mint-session.ts
 */
import { createHmac } from 'node:crypto';
import postgres from '../../server/web/node_modules/postgres/src/index.js';
import type { Sql } from './lib/types.ts';

const DB = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@127.0.0.1:56432/postgres';
const OWNER_EMAIL = process.env.DEMO_OWNER_EMAIL ?? 'alex@harbourlabs.example.com';
const SECRET = process.env.SESSION_SECRET;
const TTL_SECONDS = 365 * 24 * 60 * 60;

const b64url = (b: Buffer) => b.toString('base64url');

async function main() {
  if (!SECRET) {
    console.error('✗ SESSION_SECRET must be set — it must be the SAME secret the demo app runs with.');
    process.exit(1);
  }
  const sql = postgres(DB, { onnotice: () => {} }) as unknown as Sql;
  const rows = await sql`select id from auth.users where email = ${OWNER_EMAIL} limit 1`;
  const uid = rows[0]?.id;
  if (!uid) {
    console.error(`✗ no owner ${OWNER_EMAIL} on this database — seed it first.`);
    process.exit(1);
  }

  const exp = Math.floor(Date.now() / 1000) + TTL_SECONDS;
  const payload = b64url(Buffer.from(JSON.stringify({ uid: String(uid), exp }), 'utf8'));
  const sig = b64url(createHmac('sha256', SECRET).update(payload).digest());

  // Value only — the caller decides how it reaches the edge config, so the
  // cookie never has to be pasted anywhere by hand.
  process.stdout.write(`${payload}.${sig}\n`);
  await sql.end();
}

main().catch((err) => {
  console.error('✗ mint-session failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
