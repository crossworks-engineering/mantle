/**
 * The gateway's database guards: the pinned address, and a sign-in held to
 * SCRAM, against fake database servers on loopback.
 */
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import postgres from 'postgres';
import { afterEach, describe, expect, it } from 'vitest';
import { pinnedDatabase, pinnedSocket } from './db-pin';
import { parseCidr } from './upstream';

const def = parseCidr('172.18.0.0/16')!;
const svc = parseCidr('172.30.0.0/24')!;

describe('pinnedDatabase', () => {
  it('takes an answer on the default network', () => {
    expect(pinnedDatabase(['172.18.0.2'], [def], [svc])).toEqual({
      ok: true,
      address: '172.18.0.2',
    });
  });

  it('refuses an answer on mantle_services, off every default subnet, or none', () => {
    expect(pinnedDatabase(['172.18.0.2', '172.30.0.9'], [def], [svc])).toMatchObject({
      ok: false,
      error: expect.stringMatching(/mantle_services/),
    });
    expect(pinnedDatabase(['10.0.0.1'], [def], [svc])).toMatchObject({ ok: false });
    expect(pinnedDatabase([], [def], [svc])).toMatchObject({ ok: false });
    expect(pinnedDatabase(['::1'], [def], [svc])).toMatchObject({ ok: false });
  });
});

/** A fake database: answers the startup with one sign-in request and keeps
 *  every byte the client sent. */
function fakeDatabase(
  authCode: number,
): Promise<{ port: number; got: () => string; close: () => void }> {
  const received: Buffer[] = [];
  const server = net.createServer((s) => {
    s.on('data', (d: Buffer) => {
      received.push(d);
      if (received.length === 1) {
        const r = Buffer.alloc(13);
        r.write('R', 0);
        r.writeUInt32BE(authCode === 5 ? 12 : 8, 1);
        r.writeUInt32BE(authCode, 5);
        s.write(authCode === 5 ? r : r.subarray(0, 9));
      }
    });
    s.on('error', () => {});
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({
        port: (server.address() as AddressInfo).port,
        got: () => Buffer.concat(received).toString('latin1'),
        close: () => server.close(),
      }),
    ),
  );
}

const closers: Array<() => void> = [];
afterEach(() => {
  for (const c of closers.splice(0)) c();
});

describe('the SCRAM-only sign-in', () => {
  it.each([
    ['cleartext', 3],
    ['MD5', 5],
  ])('cuts a server that asks for the password as %s, before it is sent', async (_n, code) => {
    const db = await fakeDatabase(code);
    closers.push(db.close);
    const sql = postgres(`postgres://gw:never-sent-pw@db.invalid:5432/postgres`, {
      max: 1,
      connect_timeout: 3,
      // postgres.js takes `socket` (connection.js); its types leave it out.
      ...({ socket: pinnedSocket('127.0.0.1', db.port) } as object),
      onnotice: () => {},
    });
    await expect(sql`select 1`).rejects.toThrow();
    await sql.end({ timeout: 1 }).catch(() => {});
    await new Promise((r) => setTimeout(r, 50));
    // The startup went out (the user name); no password message did.
    expect(db.got()).toContain('gw');
    expect(db.got()).not.toContain('never-sent-pw');
    // Nothing after the startup message: no password message at all.
    const bytes = Buffer.from(db.got(), 'latin1');
    expect(bytes.length).toBe(bytes.readUInt32BE(0));
  });

  it('lets a SASL request through to the client', async () => {
    const db = await fakeDatabase(10);
    closers.push(db.close);
    const sql = postgres(`postgres://gw:pw@db.invalid:5432/postgres`, {
      max: 1,
      connect_timeout: 2,
      // postgres.js takes `socket` (connection.js); its types leave it out.
      ...({ socket: pinnedSocket('127.0.0.1', db.port) } as object),
      onnotice: () => {},
    });
    // The fake names no mechanism, so the client fails on its own; what
    // matters is that the guard passed the request on (the client read it).
    await expect(sql`select 1`).rejects.toThrow();
    await sql.end({ timeout: 1 }).catch(() => {});
    expect(db.got()).not.toContain('pw\0');
  });

  it('connects to the pinned address, whatever host the URL names', async () => {
    const db = await fakeDatabase(3);
    closers.push(db.close);
    const sql = postgres(`postgres://gw:pw@postgres.invalid:5432/postgres`, {
      max: 1,
      connect_timeout: 2,
      // postgres.js takes `socket` (connection.js); its types leave it out.
      ...({ socket: pinnedSocket('127.0.0.1', db.port) } as object),
      onnotice: () => {},
    });
    await expect(sql`select 1`).rejects.toThrow();
    await sql.end({ timeout: 1 }).catch(() => {});
    // The name never resolves (.invalid); the startup reached the pin.
    expect(db.got()).toContain('gw');
  });
});
