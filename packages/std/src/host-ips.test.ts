/**
 * hostIps / withHostIps: the IP line under a Fleet box address
 * (docs/control-center.md). A fake lookup stands in for DNS.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearHostIpCache, hostIps, withHostIps, type HostLookup } from './host-ips';

afterEach(() => clearHostIpCache());

const answer =
  (rows: { address: string; family: number }[]): HostLookup =>
  async () =>
    rows;

describe('hostIps', () => {
  it('gives IPv4 first, then IPv6, with no repeats', async () => {
    const lookup = answer([
      { address: '2001:db8::1', family: 6 },
      { address: '192.0.2.10', family: 4 },
      { address: '192.0.2.11', family: 4 },
      { address: '192.0.2.10', family: 4 },
    ]);
    expect(await hostIps('https://box.example.com', { lookup })).toEqual([
      '192.0.2.10',
      '192.0.2.11',
      '2001:db8::1',
    ]);
  });

  it('gives nothing for a host that is already an IP, and never looks it up', async () => {
    const lookup = vi.fn(answer([{ address: '192.0.2.99', family: 4 }]));
    expect(await hostIps('https://192.0.2.10', { lookup })).toEqual([]);
    expect(await hostIps('https://[2001:db8::5]:8443', { lookup })).toEqual([]);
    expect(lookup).not.toHaveBeenCalled();
  });

  it('gives nothing for a failed lookup or a bad URL, never an error', async () => {
    const lookup: HostLookup = () => Promise.reject(new Error('ENOTFOUND'));
    expect(await hostIps('https://gone.example.com', { lookup })).toEqual([]);
    expect(await hostIps('not a url', { lookup })).toEqual([]);
  });

  it('gives nothing after the timeout, and the late answer fills the cache', async () => {
    let release!: () => void;
    const slow: HostLookup = () =>
      new Promise((done) => {
        release = () => done([{ address: '192.0.2.20', family: 4 }]);
      });
    expect(await hostIps('https://slow.example.com', { lookup: slow, timeoutMs: 10 })).toEqual([]);
    release();
    const never = vi.fn(answer([]));
    expect(await hostIps('https://slow.example.com', { lookup: never })).toEqual(['192.0.2.20']);
    expect(never).not.toHaveBeenCalled();
  });

  it('keeps an answer for 5 minutes, per host, then looks again', async () => {
    const lookup = vi.fn(answer([{ address: '192.0.2.30', family: 4 }]));
    const t0 = 1_000_000;
    await hostIps('https://a.example.com', { lookup, now: t0 });
    await hostIps('https://a.example.com/x', { lookup, now: t0 + 4 * 60_000 });
    expect(lookup).toHaveBeenCalledTimes(1);
    await hostIps('https://b.example.com', { lookup, now: t0 });
    expect(lookup).toHaveBeenCalledTimes(2);
    await hostIps('https://a.example.com', { lookup, now: t0 + 6 * 60_000 });
    expect(lookup).toHaveBeenCalledTimes(3);
  });
});

describe('withHostIps', () => {
  it('adds ips to each row, all hosts at once, and keeps the rest of the row', async () => {
    const seen: string[] = [];
    const lookup: HostLookup = async (host) => {
      seen.push(host);
      return host === 'a.example.com' ? [{ address: '192.0.2.1', family: 4 }] : [];
    };
    const rows = await withHostIps(
      [
        { id: '1', url: 'https://a.example.com' },
        { id: '2', url: 'https://b.example.com' },
        { id: '3', url: 'https://192.0.2.7' },
      ],
      { lookup },
    );
    expect(rows).toEqual([
      { id: '1', url: 'https://a.example.com', ips: ['192.0.2.1'] },
      { id: '2', url: 'https://b.example.com', ips: [] },
      { id: '3', url: 'https://192.0.2.7', ips: [] },
    ]);
    expect(seen.sort()).toEqual(['a.example.com', 'b.example.com']);
  });
});
