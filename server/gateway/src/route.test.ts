import { describe, expect, it } from 'vitest';
import { decide, isRefusal, parseTarget, REFUSALS, underPrefix } from './route';

const svc = {
  slug: 'billing',
  upstream: 'billing-agent:8080',
  pathPrefixes: ['/mcp', '/api/'],
  methods: ['GET', 'POST'],
  enabled: true,
};

describe('parseTarget', () => {
  it('reads the slug, the path below it and the query', () => {
    expect(parseTarget('/svc/billing/mcp?x=1')).toEqual({
      slug: 'billing',
      path: '/mcp',
      query: '?x=1',
    });
    expect(parseTarget('/svc/billing')).toEqual({ slug: 'billing', path: '/', query: '' });
    expect(parseTarget('/svc/billing/')).toEqual({ slug: 'billing', path: '/', query: '' });
    expect(parseTarget('/svc/billing/api/rows/')).toEqual({
      slug: 'billing',
      path: '/api/rows/',
      query: '',
    });
  });

  it('takes the safe percent codes a tool sends for plain values', () => {
    expect(parseTarget('/svc/billing/api/rows/a%20b%3Ac%40d?x=%2F')).toEqual({
      slug: 'billing',
      path: '/api/rows/a%20b%3Ac%40d',
      query: '?x=%2F',
    });
  });

  it('serves nothing outside /svc/', () => {
    for (const t of ['/', '/healthz', '/svcx/a', '/api/svc/a', 'http://x/svc/a']) {
      expect(parseTarget(t), t).toBe(REFUSALS.notGateway);
    }
  });

  it('refuses a slug the registry could never hold', () => {
    for (const t of ['/svc//x', '/svc/BILLING/x', '/svc/-a/x', `/svc/${'a'.repeat(41)}/x`]) {
      expect(parseTarget(t), t).toBe(REFUSALS.unknown);
    }
  });

  it('refuses a path the service would read differently', () => {
    for (const t of [
      '/svc/billing/../payroll/x',
      '/svc/billing/./mcp',
      '/svc/billing/a//b',
      '/svc/billing/%2e%2e/payroll',
      '/svc/billing/a%2Fb',
      '/svc/billing/a%5cb',
      '/svc/billing/a\\b',
      '/svc/billing/a%00b',
      '/svc/billing/..',
      '/svc/billing/api/..;/admin',
      '/svc/billing/api;x',
      '/svc/billing/api/%252e%252e/admin',
      '/svc/billing/api/%25',
      '/svc/billing/api/%c0%ae%c0%ae/admin', // overlong UTF-8 dot
      '/svc/billing/api/%e0%80%ae', // a longer overlong dot
      '/svc/billing/api/%ef%bc%8e%ef%bc%8e/admin', // fullwidth dots
      '/svc/billing/api/%u002e%u002e/admin', // IIS-style escape
      '/svc/billing/api/%3B',
      '/svc/billing/api/%0a',
      '/svc/billing/api/%7f',
      '/svc/billing/api/caf\u00e9', // a raw byte past ASCII
      '/svc/billing/api/a b',
      '/svc/billing/api/%',
      '/svc/billing/api/%2',
    ]) {
      expect(parseTarget(t), t).toBe(REFUSALS.badPath);
    }
  });
});

describe('underPrefix', () => {
  it('matches on a segment boundary', () => {
    expect(underPrefix('/mcp', '/mcp')).toBe(true);
    expect(underPrefix('/mcp/x', '/mcp')).toBe(true);
    expect(underPrefix('/mcpx', '/mcp')).toBe(false);
    expect(underPrefix('/api/x', '/api/')).toBe(true);
    expect(underPrefix('/api', '/api/')).toBe(false);
    expect(underPrefix('/anything', '/')).toBe(true);
  });
});

describe('decide', () => {
  it('allows a registered method and path', () => {
    expect(decide(svc, 'POST', '/mcp')).toEqual({ ok: true });
    expect(decide(svc, 'get', '/api/rows')).toEqual({ ok: true });
  });

  it('refuses an unknown or switched-off service, a method, a path', () => {
    expect(decide(null, 'GET', '/mcp')).toBe(REFUSALS.unknown);
    expect(decide({ ...svc, enabled: false }, 'GET', '/mcp')).toBe(REFUSALS.disabled);
    expect(decide(svc, 'DELETE', '/mcp')).toBe(REFUSALS.method);
    expect(decide(svc, 'GET', '/admin')).toBe(REFUSALS.pathNotAllowed);
    expect(decide(svc, 'GET', '/')).toBe(REFUSALS.pathNotAllowed);
    expect(isRefusal(decide(svc, 'GET', '/mcpx'))).toBe(true);
  });
});
