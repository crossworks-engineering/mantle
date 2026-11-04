import { describe, expect, it } from 'vitest';
import { checkedAddress, inCidr, parseCidr, servicesCidrs, type Cidr } from './upstream';

const def = parseCidr('172.18.0.0/16')!;
const svcNet = parseCidr('172.30.0.0/24')!;
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

describe('servicesCidrs', () => {
  it('takes the configured subnets first', async () => {
    const r = await servicesCidrs('10.9.0.0/24, junk', 'postgres', [def, svcNet]);
    expect(r.cidrs.map((c) => c.text)).toEqual(['10.9.0.0/24']);
  });

  it("is every interface subnet but the database's", async () => {
    const r = await servicesCidrs(
      undefined,
      'postgres',
      [def, svcNet],
      resolver({ postgres: ['172.18.0.2'] }),
    );
    expect(r.cidrs).toEqual([svcNet]);
  });

  it('finds none (fail closed) with one interface or an unknown database host', async () => {
    expect((await servicesCidrs(undefined, 'postgres', [def])).cidrs).toEqual([]);
    expect((await servicesCidrs(undefined, 'postgres', [def, svcNet], resolver({}))).cidrs).toEqual(
      [],
    );
    expect(
      (
        await servicesCidrs(
          undefined,
          'postgres',
          [def, svcNet],
          resolver({ postgres: ['10.0.0.1'] }),
        )
      ).cidrs,
    ).toEqual([]);
    expect((await servicesCidrs(undefined, null, [def, svcNet])).cidrs).toEqual([]);
  });
});

describe('checkedAddress', () => {
  const cidrs: Cidr[] = [svcNet];
  const map = resolver({
    'pcms-agent': ['172.30.0.7'],
    'two-nets': ['172.30.0.8', '172.18.0.8'],
    'on-default': ['172.18.0.5'],
  });

  it('answers an address on the services network', async () => {
    expect(await checkedAddress('pcms-agent', cidrs, map)).toBe('172.30.0.7');
  });

  it('refuses any answer off it, an IP, a name that does not resolve, no subnet', async () => {
    expect(await checkedAddress('on-default', cidrs, map)).toBeNull();
    expect(await checkedAddress('two-nets', cidrs, map)).toBeNull();
    expect(await checkedAddress('172.30.0.7', cidrs, map)).toBeNull();
    expect(await checkedAddress('nowhere', cidrs, map)).toBeNull();
    expect(await checkedAddress('pcms-agent', [], map)).toBeNull();
  });
});
