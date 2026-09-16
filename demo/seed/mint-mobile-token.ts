/**
 * Mint the phone-app bearer the demo edge hands to store reviewers.
 *
 * The phone app signs in with POST /api/auth/mobile-login, which the read-only
 * edge refuses and the read-only database role could not honour anyway. So,
 * exactly like the visitor session (mint-session.ts), the credential is minted
 * once here and baked into the edge: Caddy answers the sign-in call itself
 * with this token, for any username and password. The token is a real mobile
 * bearer for the demo owner (signed with the demo SESSION_SECRET, jti row in
 * mobile_tokens), so every read works and every write still meets the edge's
 * 403. Same safety argument as the session cookie: fictional brain, no writes.
 *
 * Prints the token value; the caller substitutes __DEMO_MOBILE_TOKEN__ in
 * deploy/Caddyfile.demo. Run against the demo database as postgres, with the
 * SAME SESSION_SECRET the demo app runs with:
 *
 *   SESSION_SECRET=... pnpm -C server/web exec tsx ../../demo/seed/mint-mobile-token.ts
 */
import { createHmac, randomUUID } from 'node:crypto';
import postgres from '../../server/web/node_modules/postgres/src/index.js';
import type { Sql } from './lib/types.ts';

const DB = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@127.0.0.1:56432/postgres';
const OWNER_EMAIL = process.env.DEMO_OWNER_EMAIL ?? 'alex@harbourlabs.example.com';
const SECRET = process.env.SESSION_SECRET;
const TTL_SECONDS = 365 * 24 * 60 * 60;
const LABEL = 'Store reviewer (demo)';

const b64url = (b: Buffer) => b.toString('base64url');

async function main() {
  if (!SECRET) {
    console.error('✗ SESSION_SECRET must be set, the SAME secret the demo app runs with.');
    process.exit(1);
  }
  const sql = postgres(DB, { onnotice: () => {} }) as unknown as Sql;
  const rows = await sql`select id from auth.users where email = ${OWNER_EMAIL} limit 1`;
  const uid = rows[0]?.id;
  if (!uid) {
    console.error(`✗ no owner ${OWNER_EMAIL} on this database, seed it first.`);
    process.exit(1);
  }
  const jti = randomUUID();
  const exp = Math.floor(Date.now() / 1000) + TTL_SECONDS;
  // Wire format of server/web/lib/auth/tokens.ts signClaims: base64url(JSON).base64url(HMAC-SHA256).
  const payload = b64url(Buffer.from(JSON.stringify({ uid: String(uid), jti, k: 'm', exp }), 'utf8'));
  const sig = b64url(createHmac('sha256', SECRET).update(payload).digest());
  await sql`insert into mobile_tokens (id, user_id, label, expires_at)
            values (${jti}, ${String(uid)}, ${LABEL}, ${new Date(exp * 1000)})`;
  process.stdout.write(`${payload}.${sig}\n`);
  await sql.end();
}

main().catch((err) => {
  console.error('✗ mint-mobile-token failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
