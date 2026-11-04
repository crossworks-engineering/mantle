import { describe, expect, it } from 'vitest';
import {
  checkedAddress,
  fromServices,
  inCidr,
  networkPlan,
  parseCidr,
  type Cidr,
  type Iface,
} from './upstream';

const def = parseCidr('172.18.0.0/16')!;
const svcNet = parseCidr('172.30.0.0/24')!;
const ifs: Iface[] = [
  { address: '172.18.0.9', cidr: def },
  { address: '172.30.0.3', cidr: svcNet },
];
const resolver =
  (map: Record<string, string[]>) =>
  async (h: string): Promise<string[]> => {
    if (!(h in map)) throw new Error('ENOTFOUND');
    return map[h]!;
  };

describe('parseCidr and inCidr', () => {
  it('reads a subnet and tests an address', () => {
    expect(parseCidr('10.1.2.3/8')).toMatchObject({ bits: 8, text: '10.0.0.0/8' });
    expect(parseCidr('nope')).toBeNull();
    expect(parseCidr('10.0.0.0/4')).toBeNull();
    expect(inCidr('172.30.0.9', svcNet)).toBe(true);
    expect(inCidr('172.18.0.9', svcNet)).toBe(false);
    expect(inCidr('::1', svcNet)).toBe(false);
  });
});

describe('networkPlan', () => {
  it('takes the configured subnets first', async () => {
    const r = await networkPlan('10.9.0.0/24, junk', ['postgres'], ifs);
    expect(r.cidrs.map((c) => c.text)).toEqual(['10.9.0.0/24']);
    expect(r.listen).toBeNull();
  });

  it("is every interface subnet but the stack's, and listens on the default one", async () => {
    const r = await networkPlan(
      undefined,
      ['postgres', 'web'],
      ifs,
      resolver({ postgres: ['172.18.0.2'] }),
    );
    expect(r.cidrs).toEqual([svcNet]);
    expect(r.listen).toBe('172.18.0.9');
    expect(r.own).toEqual(['172.18.0.9', '172.30.0.3']);
  });

  it('finds none (fail closed): one interface, no stack name resolves, none on a subnet', async () => {
    expect((await networkPlan(undefined, ['postgres'], [ifs[0]!])).cidrs).toEqual([]);
    expect((await networkPlan(undefined, ['postgres'], ifs, resolver({}))).cidrs).toEqual([]);
    expect(
      (await networkPlan(undefined, ['postgres'], ifs, resolver({ postgres: ['10.0.0.1'] }))).cidrs,
    ).toEqual([]);
  });

  it('fails closed when a service shadows a stack name on mantle_services', async () => {
    // A box service aliased `postgres` on the services network: its answer
    // marks that subnet default too, so no services subnet is left.
    const r = await networkPlan(
      undefined,
      ['postgres', 'web'],
      ifs,
      resolver({ postgres: ['172.18.0.2', '172.30.0.66'], web: ['172.18.0.5'] }),
    );
    expect(r.cidrs).toEqual([]);
    expect(r.listen).toBeNull();
  });
});

describe('checkedAddress', () => {
  const cidrs: Cidr[] = [svcNet];
  const own = ['172.30.0.3'];
  const map = resolver({
    'pcms-agent': ['172.30.0.7'],
    'two-nets': ['172.30.0.8', '172.18.0.8'],
    'on-default': ['172.18.0.5'],
    bridge: ['172.30.0.1'],
    self: ['172.30.0.3'],
    broadcast: ['172.30.0.255'],
  });

  it('answers an address on the services network', async () => {
    expect(await checkedAddress('pcms-agent', cidrs, own, map)).toBe('172.30.0.7');
  });

  it('refuses any answer off it, an IP, a name that does not resolve, no subnet', async () => {
    expect(await checkedAddress('on-default', cidrs, own, map)).toBeNull();
    expect(await checkedAddress('two-nets', cidrs, own, map)).toBeNull();
    expect(await checkedAddress('172.30.0.7', cidrs, own, map)).toBeNull();
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
    expect(fromServices('172.30.0.7', [svcNet])).toBe(true);
    expect(fromServices('::ffff:172.30.0.7', [svcNet])).toBe(true);
    expect(fromServices('172.18.0.2', [svcNet])).toBe(false);
    expect(fromServices(undefined, [svcNet])).toBe(false);
  });
});
