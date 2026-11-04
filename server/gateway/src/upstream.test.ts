import { describe, expect, it } from 'vitest';
import {
  checkedAddress,
  fromServices,
  inCidr,
  listenAddress,
  parseCidr,
  servicesCidrs,
  type Cidr,
} from './upstream';

const svcNet = parseCidr('172.31.250.0/24')!;
const resolver =
  (map: Record<string, string[]>) =>
  async (h: string): Promise<string[]> => {
    if (!(h in map)) throw new Error('ENOTFOUND');
    return map[h]!;
  };

describe('parseCidr, inCidr and servicesCidrs', () => {
  it('reads a subnet and tests an address', () => {
    expect(parseCidr('10.1.2.3/8')).toMatchObject({ bits: 8, text: '10.0.0.0/8' });
    expect(parseCidr('nope')).toBeNull();
    expect(parseCidr('10.0.0.0/4')).toBeNull();
    expect(inCidr('172.31.250.9', svcNet)).toBe(true);
    expect(inCidr('172.18.0.9', svcNet)).toBe(false);
    expect(inCidr('::1', svcNet)).toBe(false);
  });

  it('reads GATEWAY_UPSTREAM_CIDRS; unset or junk is none (every upstream refused)', () => {
    expect(servicesCidrs('172.31.250.0/24, junk').map((c) => c.text)).toEqual(['172.31.250.0/24']);
    expect(servicesCidrs(undefined)).toEqual([]);
    expect(servicesCidrs('junk')).toEqual([]);
  });
});

describe('listenAddress', () => {
  it('is the one own address outside the services subnet', () => {
    expect(listenAddress(['172.18.0.9', '172.31.250.3'], [svcNet])).toBe('172.18.0.9');
    expect(listenAddress(['172.31.250.3'], [svcNet])).toBeNull();
    expect(listenAddress(['172.18.0.9', '10.0.0.4', '172.31.250.3'], [svcNet])).toBeNull();
  });
});

describe('checkedAddress', () => {
  const cidrs: Cidr[] = [svcNet];
  const own = ['172.31.250.3'];
  const map = resolver({
    'pcms-agent': ['172.31.250.7'],
    'two-nets': ['172.31.250.8', '172.18.0.8'],
    'on-default': ['172.18.0.5'],
    bridge: ['172.31.250.1'],
    self: ['172.31.250.3'],
    broadcast: ['172.31.250.255'],
  });

  it('answers an address on the services network', async () => {
    expect(await checkedAddress('pcms-agent', cidrs, own, map)).toBe('172.31.250.7');
  });

  it('refuses any answer off it, an IP, a name that does not resolve, no subnet', async () => {
    expect(await checkedAddress('on-default', cidrs, own, map)).toBeNull();
    expect(await checkedAddress('two-nets', cidrs, own, map)).toBeNull();
    expect(await checkedAddress('172.31.250.7', cidrs, own, map)).toBeNull();
    expect(await checkedAddress('nowhere', cidrs, own, map)).toBeNull();
    expect(await checkedAddress('pcms-agent', [], own, map)).toBeNull();
  });

  it("refuses the bridge's host address, the gateway itself and the broadcast", async () => {
    expect(await checkedAddress('bridge', cidrs, own, map)).toBeNull();
    expect(await checkedAddress('self', cidrs, own, map)).toBeNull();
    expect(await checkedAddress('broadcast', cidrs, own, map)).toBeNull();
  });
});

describe('fromServices', () => {
  it('names a connection from a services subnet, mapped or not', () => {
    expect(fromServices('172.31.250.7', [svcNet])).toBe(true);
    expect(fromServices('::ffff:172.31.250.7', [svcNet])).toBe(true);
    expect(fromServices('172.18.0.2', [svcNet])).toBe(false);
    expect(fromServices(undefined, [svcNet])).toBe(false);
  });
});
