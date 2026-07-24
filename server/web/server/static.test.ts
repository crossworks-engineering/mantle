import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { trailingSlashRedirect } from './static';

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
