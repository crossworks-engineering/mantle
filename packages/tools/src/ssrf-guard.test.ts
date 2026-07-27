import { describe, expect, it } from 'vitest';
import { assertFetchableUrl, isBlockedIp } from './ssrf-guard';

describe('isBlockedIp', () => {
  it('blocks loopback, private, link-local, CGNAT, and metadata', () => {
    for (const ip of [
      '127.0.0.1',
      '127.5.5.5',
      '10.0.0.1',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '169.254.169.254', // cloud metadata
      '100.64.0.1', // CGNAT / tailscale
      '0.0.0.0',
    ]) {
      expect(isBlockedIp(ip), ip).toBe(true);
    }
  });

  it('allows ordinary public addresses', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.32.0.1', '11.0.0.1']) {
      expect(isBlockedIp(ip), ip).toBe(false);
    }
  });

  it('handles IPv6 loopback, ULA, link-local, and IPv4-mapped', () => {
    expect(isBlockedIp('::1')).toBe(true);
    expect(isBlockedIp('fc00::1')).toBe(true);
    expect(isBlockedIp('fd12:3456::1')).toBe(true);
    expect(isBlockedIp('fe80::1')).toBe(true);
    expect(isBlockedIp('::ffff:127.0.0.1')).toBe(true);
    expect(isBlockedIp('::ffff:8.8.8.8')).toBe(false);
    expect(isBlockedIp('2606:4700:4700::1111')).toBe(false);
  });

  it('fails closed on unparseable input', () => {
    expect(isBlockedIp('not-an-ip')).toBe(true);
  });
});

describe('assertFetchableUrl', () => {
  it('rejects non-http(s) schemes', async () => {
    await expect(assertFetchableUrl('file:///etc/passwd')).rejects.toThrow();
    await expect(assertFetchableUrl('gopher://x')).rejects.toThrow();
  });

  it('rejects literal private/metadata IPs', async () => {
    await expect(assertFetchableUrl('http://169.254.169.254/latest/meta-data')).rejects.toThrow(
      /private\/internal/,
    );
    await expect(assertFetchableUrl('http://127.0.0.1:5432')).rejects.toThrow();
    await expect(assertFetchableUrl('http://[::1]/')).rejects.toThrow();
  });

  it('rejects localhost (resolves to loopback)', async () => {
    await expect(assertFetchableUrl('http://localhost:3000/')).rejects.toThrow();
  });

  describe('the sandboxd proxy exemption (the ONE deliberate carve)', () => {
    const base = 'http://sandboxd:8090';
    const withEnv = async (value: string | undefined, fn: () => Promise<void>) => {
      const prev = process.env.SANDBOXD_URL;
      if (value === undefined) delete process.env.SANDBOXD_URL;
      else process.env.SANDBOXD_URL = value;
      try {
        await fn();
      } finally {
        if (prev === undefined) delete process.env.SANDBOXD_URL;
        else process.env.SANDBOXD_URL = prev;
      }
    };

    it('allows the data-plane proxy path on the exact sandboxd origin', async () => {
      await withEnv(base, async () => {
        await expect(
          assertFetchableUrl(`${base}/svc/11111111-2222-4333-8444-555555555555/8000/calc`),
        ).resolves.toBeUndefined();
      });
    });

    it("does NOT expose sandboxd's control plane (/sandboxes)", async () => {
      await withEnv(base, async () => {
        await expect(assertFetchableUrl(`${base}/sandboxes`)).rejects.toThrow();
        await expect(assertFetchableUrl(`${base}/healthz`)).rejects.toThrow();
      });
    });

    it('does NOT leak to other private hosts, even with /svc/ paths', async () => {
      await withEnv(base, async () => {
        await expect(assertFetchableUrl('http://postgres:5432/svc/x')).rejects.toThrow();
        await expect(assertFetchableUrl('http://127.0.0.1:8090/svc/x')).rejects.toThrow();
      });
    });

    it('is inert when SANDBOXD_URL is unset', async () => {
      await withEnv(undefined, async () => {
        await expect(assertFetchableUrl(`${base}/svc/x/8000/`)).rejects.toThrow();
      });
    });
  });

  it('allows a public literal IP', async () => {
    await expect(assertFetchableUrl('https://1.1.1.1/')).resolves.toBeUndefined();
  });
});
