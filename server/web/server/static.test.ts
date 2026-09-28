import { Hono } from 'hono';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { mountStatic, trailingSlashRedirect } from './static';

describe('trailingSlashRedirect', () => {
  const app = new Hono();
  app.use('*', trailingSlashRedirect());
  app.get('/api/health', (c) => c.json({ ok: true }));
  app.get('/', (c) => c.text('root'));

  it('308-redirects trailing-slash paths, preserving the query (Next parity)', async () => {
    const res = await app.request('/api/health/?q=1');
    expect(res.status).toBe(308);
    expect(res.headers.get('location')).toBe('/api/health?q=1');
    // Multiple slashes collapse too.
    expect((await app.request('/api/health///')).headers.get('location')).toBe('/api/health');
  });

  it('leaves the bare root and slash-less paths alone', async () => {
    expect((await app.request('/')).status).toBe(200);
    expect((await app.request('/api/health')).status).toBe(200);
  });
});

describe('mountStatic /app-runtime', () => {
  // app.request() runs on the platform Response, the same one serve() now
  // leaves in place (overrideGlobalObjects: false). Headers set in serveStatic's
  // onFound hook never reached this Response, which is how the runtime lost
  // ACAO:* on every brain from v0.232.263.
  const dir = mkdtempSync(join(tmpdir(), 'mantle-static-'));
  mkdirSync(join(dir, 'app-runtime'));
  writeFileSync(join(dir, 'app-runtime', 'manifest.json'), '{"imports":{}}');
  writeFileSync(join(dir, 'app-runtime', 'react-abc123.js'), 'export {};');
  const app = new Hono();
  mountStatic(app, dir);
  app.notFound((c) => c.text('nope', 404));

  it('serves the manifest CORS-open and always revalidated', async () => {
    const res = await app.request('/app-runtime/manifest.json', { headers: { Origin: 'null' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('cache-control')).toBe('no-cache');
  });

  it('serves a hashed module CORS-open and immutable', async () => {
    const res = await app.request('/app-runtime/react-abc123.js', { headers: { Origin: 'null' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(res.headers.get('content-type') ?? '').toContain('javascript');
  });

  it('does not mark a miss immutable', async () => {
    const res = await app.request('/app-runtime/missing.js');
    expect(res.status).toBe(404);
    expect(res.headers.get('cache-control')).toBeNull();
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });
});
