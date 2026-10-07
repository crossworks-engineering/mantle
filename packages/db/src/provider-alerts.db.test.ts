/**
 * Provider alerts (migration 0230) on a real, migrated Postgres: the store's
 * rules (permanent shows at once, transient after 10 min, a permanent reason
 * survives a later blip, a resolved row starts over) and the trigger (the
 * admin `needs_you_changed` event fires when what an admin sees changes, and
 * not on the per-error counters). Events are matched by this file's own
 * random owner id, so the shared test database is fine.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/db/src/provider-alerts.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;
const CHANNEL = 'needs_you_changed';
const MIN = 60_000;

describe.skipIf(!URL)('provider alerts: store rules and the admin event', () => {
  type Db = typeof import('./index');
  let m: Db;
  let ts: typeof import('./test-support');
  let admin: Parameters<Db['ensureViewerRoles']>[0];
  let unlisten: (() => Promise<void>) | undefined;
  const events: string[] = [];
  const owner = randomUUID();
  const t0 = new Date('2026-10-04T08:00:00Z');
  const at = (ms: number) => new Date(t0.getTime() + ms);

  const quota = {
    code: 'quota',
    permanent: true,
    reason: 'The provider account has no credits or quota left.',
    provider: 'openai',
    model: 'text-embedding-3-large',
  };
  const network = {
    code: 'network',
    permanent: false,
    reason: 'The brain cannot reach the provider.',
    provider: 'local',
    model: 'embeddinggemma:latest',
  };

  /** What `fn` sent for this owner, drained before and after. */
  const sent = async (fn: () => Promise<unknown>): Promise<number> => {
    const drain = async () => {
      await ts.notifyBarrier(admin, CHANNEL, { seen: (s) => events.includes(s) });
    };
    await drain();
    events.length = 0;
    await fn();
    await drain();
    return events.filter((e) => e === owner).length;
  };
  const row = async (subject: 'embedding' | 'extraction') =>
    (await m.listProviderAlerts(owner)).find((r) => r.subject === subject);

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    m = await import('./index');
    ts = await import('./test-support');
    admin = (m.systemDb as unknown as { $client: typeof admin }).$client;
    const sub = await admin.listen(CHANNEL, (p: string) => events.push(p));
    unlisten = () => sub.unlisten();
  }, 60_000);

  afterAll(async () => {
    await unlisten?.();
    if (admin) await admin`delete from provider_alerts where owner_id = ${owner}`;
  });

  it('a permanent failure opens a shown alert at once, and tells the admins', async () => {
    expect(await sent(() => m.recordProviderFailure(owner, 'embedding', quota, t0))).toBe(1);
    const r = (await row('embedding'))!;
    expect(r).toMatchObject({ code: 'quota', permanent: true, visible: true, errorCount: 1 });
    expect(r.resolvedAt).toBeNull();
    expect(m.isAlertShown(r)).toBe(true);
  });

  it('more failures count up quietly; a later blip keeps the permanent reason', async () => {
    expect(
      await sent(async () => {
        await m.recordProviderFailure(owner, 'embedding', quota, at(MIN));
        await m.recordProviderFailure(owner, 'embedding', network, at(2 * MIN));
      }),
    ).toBe(0);
    const r = (await row('embedding'))!;
    expect(r).toMatchObject({ code: 'quota', permanent: true, errorCount: 3, provider: 'openai' });
    expect(r.failingSince.toISOString()).toBe(t0.toISOString());
  });

  it('pausing and the probe schedule are recorded; pausing tells the admins', async () => {
    expect(await sent(() => m.setProviderAlertPaused(owner, 'embedding', true, at(5 * MIN)))).toBe(
      1,
    );
    expect(await sent(() => m.recordProviderProbeFailure(owner, 'embedding', at(15 * MIN)))).toBe(
      0,
    );
    expect(await row('embedding')).toMatchObject({ paused: true, probeAttempts: 1 });
    expect(await m.requestProviderProbeNow(owner)).toBe(1);
    expect((await row('embedding'))!.nextProbeAt!.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('resolving closes it (the admins are told) and a new failure starts over', async () => {
    expect(await sent(() => m.resolveProviderAlert(owner, 'embedding', at(20 * MIN)))).toBe(1);
    expect(await m.resolveProviderAlert(owner, 'embedding')).toBe(false);
    expect(m.isAlertShown((await row('embedding'))!)).toBe(false);
    expect(await m.listOpenProviderAlerts(owner)).toEqual([]);

    await m.recordProviderFailure(owner, 'embedding', network, at(30 * MIN));
    const r = (await row('embedding'))!;
    expect(r).toMatchObject({
      code: 'network',
      permanent: false,
      errorCount: 1,
      probeAttempts: 0,
      paused: false,
      visible: false,
    });
    expect(r.failingSince.toISOString()).toBe(at(30 * MIN).toISOString());
  });

  it('a transient failure shows only once it has lasted 10 min, and that tells the admins', async () => {
    expect(
      await sent(() => m.recordProviderFailure(owner, 'embedding', network, at(35 * MIN))),
    ).toBe(0);
    expect((await row('embedding'))!.visible).toBe(false);
    expect(
      await sent(() => m.recordProviderFailure(owner, 'embedding', network, at(41 * MIN))),
    ).toBe(1);
    expect((await row('embedding'))!.visible).toBe(true);
  });

  it('the subjects are separate rows', async () => {
    await m.recordProviderFailure(owner, 'extraction', { ...quota, code: 'auth' }, t0);
    const open = await m.listOpenProviderAlerts(owner);
    expect(open.map((r) => r.subject).sort()).toEqual(['embedding', 'extraction']);
  });

  it('a subject outside the two is refused by the table', async () => {
    await expect(
      admin`insert into provider_alerts (owner_id, subject, code, permanent, reason)
            values (${owner}, 'chat', 'quota', true, 'x')`,
    ).rejects.toThrow();
  });
});
