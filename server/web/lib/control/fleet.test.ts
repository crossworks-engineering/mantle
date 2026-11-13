/**
 * fleetOverview (GET /api/fleet): each linked box carries `ips`, the IPs
 * this Control Center resolves its URL host to (docs/control-center.md).
 * The rows and DNS are fakes; @mantle/std/host-ips is the real code.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@mantle/db/control-center', () => ({
  controlServiceState: vi.fn(async () => null),
  listControlBans: vi.fn(async () => []),
  listControlResults: vi.fn(async () => []),
  listControlBoxes: vi.fn(async () => [
    { id: 'b1', url: 'https://one.example.com' },
    { id: 'b2', url: 'https://two.example.com' },
    { id: 'b3', url: 'https://[2001:db8::9]' },
  ]),
}));

vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async (host: string) => {
    if (host === 'one.example.com') return [{ address: '192.0.2.1', family: 4 }];
    throw new Error('ENOTFOUND');
  }),
}));

const { fleetOverview } = await import('./fleet');

describe('fleetOverview', () => {
  it('gives each box its IPs; a failed lookup or an IP host gives none, and the list still answers', async () => {
    const r = await fleetOverview();
    expect(r.boxes).toEqual([
      { id: 'b1', url: 'https://one.example.com', ips: ['192.0.2.1'] },
      { id: 'b2', url: 'https://two.example.com', ips: [] },
      { id: 'b3', url: 'https://[2001:db8::9]', ips: [] },
    ]);
    expect(r.envLines).toBeNull();
  });
});
