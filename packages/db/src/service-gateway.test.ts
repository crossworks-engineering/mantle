/**
 * The service gateway's registry rules (checkGatewayService): what a row may
 * hold, for every writer. No database.
 */
import { describe, expect, it } from 'vitest';
import { checkGatewayService, pathPrefixRefusal, upstreamRefusal } from './service-gateway';

describe('upstreamRefusal', () => {
  it("takes a service's container name and port", () => {
    for (const u of ['pcms-agent:8080', 'snapdb_agent:9000', 'a:1']) {
      expect(upstreamRefusal(u), u).toBeNull();
    }
  });

  it('refuses a dotted name, an IP, a stack service, loopback and odd shapes', () => {
    for (const u of [
      'pcms.example.com:443', // a public name could answer any address
      '172-30-0-1.sslip.io:22',
      '10.0.0.5:80',
      '1234:80',
      'postgres:5432',
      'objectstore:9000',
      'web:3000',
      'worker_files:1',
      'mantle_pg:5432',
      'localhost:80',
      'gateway:8097',
      'PCMS:80',
      'pcms',
      'pcms:0',
      'pcms:70000',
      'pcms:80/x',
      'user@pcms:80',
    ]) {
      expect(upstreamRefusal(u), u).not.toBeNull();
    }
  });
});

describe('pathPrefixRefusal', () => {
  it('takes a plain absolute path', () => {
    for (const p of ['/', '/mcp', '/api/', '/api/v1/rows'])
      expect(pathPrefixRefusal(p), p).toBeNull();
  });

  it('refuses dot or empty segments, percent, semicolon, query and relative paths', () => {
    for (const p of [
      'mcp',
      '/a/../b',
      '/a/./b',
      '/a//b',
      '/a%2fb',
      '/a;b',
      '/a?b',
      '/a#b',
      '/a\\b',
    ]) {
      expect(pathPrefixRefusal(p), p).not.toBeNull();
    }
  });
});

describe('checkGatewayService', () => {
  it('fills the defaults: all paths, GET only, reads-only, on', () => {
    expect(checkGatewayService({ slug: 'pcms', upstream: 'pcms-agent:8080' })).toEqual({
      ok: true,
      value: {
        slug: 'pcms',
        name: 'pcms',
        upstream: 'pcms-agent:8080',
        pathPrefixes: ['/'],
        methods: ['GET'],
        readsOnly: true,
        enabled: true,
        note: null,
      },
    });
  });

  it('refuses a bad slug or method, and names the fix', () => {
    expect(checkGatewayService({ slug: 'PCMS', upstream: 'a:1' })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/slug must be/),
    });
    expect(
      checkGatewayService({ slug: 'pcms', upstream: 'a:1', methods: ['GET', 'TRACE'] }),
    ).toMatchObject({ ok: false, error: expect.stringMatching(/TRACE/) });
    expect(checkGatewayService({ slug: 'pcms', upstream: 'a:1', pathPrefixes: [] })).toMatchObject({
      ok: false,
    });
  });
});
