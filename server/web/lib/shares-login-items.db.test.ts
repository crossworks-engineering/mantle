/**
 * No share shows a login's own item (nodes.login_id; 0366, 0367), against a
 * real, migrated Postgres:
 *  - a contact share an Admin user made of a member's per-login note before
 *    0366: the gate answers it missing (before any code prompt) and the
 *    view has nothing, so neither the share page nor the view route shows
 *    the note's text;
 *  - an open link to one's own screenshot: missing too (no filename, type
 *    or size);
 *  - a share of a shared item is untouched;
 *  - 0367 revokes the live shares of login-own items, and only those.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run shares-login-items.db.test
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asSuperuser } from '@mantle/db/test-support';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('no share shows a login own item', () => {
  let m: typeof import('@mantle/db');
  let shares: typeof import('./shares');
  let gate: typeof import('./contact-share-gate');
  let sqlTag: typeof import('drizzle-orm').sql;
  let eqOf: typeof import('drizzle-orm').eq;
  const owner = randomUUID();
  const member = randomUUID();
  const tag = `login-items-${owner.slice(0, 8)}`;
  const id = {
    memberNote: randomUUID(),
    screenshot: randomUUID(),
    sharedNote: randomUUID(),
    contact: randomUUID(),
  };
  const tok = {
    contact: `${tag}-contact`,
    shot: `${tag}-shot`,
    shared: `${tag}-shared`,
  };
  const SECRET = 'my private reminder text';

  const shareRow = async (token: string) =>
    (
      (await m.db.execute(
        sqlTag`select id, revoked_at from shares where token = ${token}`,
      )) as unknown as {
        id: string;
        revoked_at: string | null;
      }[]
    )[0]!;

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    m = await import('@mantle/db');
    shares = await import('./shares');
    gate = await import('./contact-share-gate');
    sqlTag = (await import('drizzle-orm')).sql;
    eqOf = (await import('drizzle-orm')).eq;
    await asSuperuser()(sqlTag`
      insert into auth.users (id, email, password_hash, role) values
        (${owner}, ${`${tag}@example.invalid`}, 'x', 'admin'),
        (${member}, ${`${tag}-m@example.invalid`}, 'x', 'member')`);
    await m.db.execute(sqlTag`
      insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})`);
    await m.db.execute(sqlTag`
      insert into nodes (id, owner_id, type, title, path, login_id, data) values
        (${id.memberNote}, ${owner}, 'note', 'Reminder', 'notes', ${member},
         ${JSON.stringify({ content: SECRET })}::jsonb),
        (${id.screenshot}, ${owner}, 'file', 'screen-2026.png', 'files', ${owner},
         ${JSON.stringify({ filename: 'screen-2026.png', mime: 'image/png', size_bytes: 1234 })}::jsonb),
        (${id.sharedNote}, ${owner}, 'note', 'Shared note', 'notes', null,
         ${JSON.stringify({ content: 'for everyone' })}::jsonb),
        (${id.contact}, ${owner}, 'contact', 'Pat', 'contacts', null, '{}'::jsonb)`);
    // The shares as they stood before 0366 made new ones impossible.
    await asSuperuser()(sqlTag`
      insert into shares (token, owner_id, node_id, node_type, contact_id) values
        (${tok.contact}, ${owner}, ${id.memberNote}, 'note', ${id.contact}),
        (${tok.shot}, ${owner}, ${id.screenshot}, 'file', null),
        (${tok.shared}, ${owner}, ${id.sharedNote}, 'note', null)`);
  }, 60_000);

  afterAll(async () => {
    await asSuperuser()(sqlTag`delete from shares where owner_id = ${owner}`);
    await m.db.execute(sqlTag`delete from nodes where owner_id = ${owner}`);
    await m.db.execute(sqlTag`delete from spaces where id = ${owner} or login_id = ${owner}`);
    await asSuperuser()(sqlTag`delete from auth.users where id = ${owner} or id = ${member}`);
    await m.closeDb();
  });

  it("a contact share of a member's per-login note: the gate and the view give not found", async () => {
    const g = await m.asSystem(() => gate.gateShareCookie(null, tok.contact), 'test');
    // Missing, not the code prompt: nothing says the share is there.
    expect(g.kind).toBe('missing');
    // The token resolves to no share at all (the frame and code routes too).
    expect(
      await m.asSystem(() => shares.resolveActiveShareRowByToken(tok.contact), 'test'),
    ).toBeNull();
    // And the view, handed the row itself, shows nothing of it.
    const [row] = await m.systemDb.select().from(m.shares).where(eqOf(m.shares.token, tok.contact));
    expect(await m.asSystem(() => shares.loadShareView(row!), 'test')).toBeNull();
  });

  it('an open link to one own screenshot gives not found, its name, type and size with it', async () => {
    const g = await m.asSystem(() => gate.gateShareCookie(null, tok.shot), 'test');
    expect(g.kind).toBe('missing');
    const [row] = await m.systemDb.select().from(m.shares).where(eqOf(m.shares.token, tok.shot));
    expect(await m.asSystem(() => shares.loadShareView(row!), 'test')).toBeNull();
  });

  it('a link to a shared item is untouched', async () => {
    const g = await m.asSystem(() => gate.gateShareCookie(null, tok.shared), 'test');
    expect(g.kind).toBe('ok');
    const view = await m.asSystem(
      () => shares.loadShareView((g as { share: import('@mantle/db').Share }).share),
      'test',
    );
    expect(view).not.toBeNull();
    expect(JSON.stringify(view)).toContain('for everyone');
  });

  it('0367 revokes the live shares of login-own items, and only those', async () => {
    const migration = readFileSync(
      new globalThis.URL(
        '../../../packages/db/migrations/0367_login_item_shares_revoked.sql',
        import.meta.url,
      ),
      'utf8',
    );
    // The file's statements, one by one (its lock timeout aside).
    for (const st of migration.split('--> statement-breakpoint')) {
      const body = st.replace(/^--.*$/gm, '').trim();
      if (!body || body.startsWith('SET LOCAL')) continue;
      await asSuperuser()(sqlTag.raw(body));
    }
    expect((await shareRow(tok.contact)).revoked_at).not.toBeNull();
    expect((await shareRow(tok.shot)).revoked_at).not.toBeNull();
    expect((await shareRow(tok.shared)).revoked_at).toBeNull();
    // The rows stay (a revoke, not a delete).
    expect((await shareRow(tok.contact)).id).toBeTruthy();
  });
});
