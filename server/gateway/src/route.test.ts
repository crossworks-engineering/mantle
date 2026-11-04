import { describe, expect, it } from 'vitest';
import { decide, isRefusal, parseTarget, REFUSALS, underPrefix } from './route';

const svc = {
  slug: 'pcms',
  upstream: 'pcms-agent:8080',
  pathPrefixes: ['/mcp', '/api/'],
  methods: ['GET', 'POST'],
  enabled: true,
};

describe('parseTarget', () => {
  it('reads the slug, the path below it and the query', () => {
    expect(parseTarget('/svc/pcms/mcp?x=1')).toEqual({ slug: 'pcms', path: '/mcp', query: '?x=1' });
    expect(parseTarget('/svc/pcms')).toEqual({ slug: 'pcms', path: '/', query: '' });
    expect(parseTarget('/svc/pcms/')).toEqual({ slug: 'pcms', path: '/', query: '' });
    expect(parseTarget('/svc/pcms/api/rows/')).toEqual({
      slug: 'pcms',
      path: '/api/rows/',
      query: '',
    });
  });

  it('serves nothing outside /svc/', () => {
    for (const t of ['/', '/healthz', '/svcx/a', '/api/svc/a', 'http://x/svc/a']) {
      expect(parseTarget(t), t).toBe(REFUSALS.notGateway);
    }
  });

  it('refuses a slug the registry could never hold', () => {
    for (const t of ['/svc//x', '/svc/PCMS/x', '/svc/-a/x', `/svc/${'a'.repeat(41)}/x`]) {
      expect(parseTarget(t), t).toBe(REFUSALS.unknown);
    }
  });

  it('refuses a path the service would read differently', () => {
    for (const t of [
      '/svc/pcms/../newton/x',
      '/svc/pcms/./mcp',
      '/svc/pcms/a//b',
      '/svc/pcms/%2e%2e/newton',
      '/svc/pcms/a%2Fb',
      '/svc/pcms/a%5cb',
      '/svc/pcms/a\\b',
      '/svc/pcms/a%00b',
      '/svc/pcms/..',
      '/svc/pcms/api/..;/admin',
      '/svc/pcms/api;x',
      '/svc/pcms/api/%252e%252e/admin',
      '/svc/pcms/api/%25',
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
