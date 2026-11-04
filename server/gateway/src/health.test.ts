/**
 * The health check must reach a listener that exists: the
 * gateway listens on its default-network address only, so compose's check
 * on 127.0.0.1 needs the loopback health listener. Pinned three ways: the
 * compose check's target, the rule that picks the loopback listener, and
 * the listener itself.
 */
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENV_NUMBERS } from '@mantle/config';
import { describe, expect, it } from 'vitest';
import { createHealthServer, healthListenerHost } from './server';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '../../..');

describe('the gateway health check', () => {
  it("compose checks 127.0.0.1 on the gateway's port", () => {
    const compose = readFileSync(join(root, 'docker-compose.yml'), 'utf8');
    const start = compose.indexOf('\n  gateway:\n');
    const block = compose.slice(start, compose.indexOf('\n  # Browser sidecar', start));
    expect(block).toContain('container_name: mantle_gateway');
    expect(block).toContain(
      `fetch('http://127.0.0.1:${ENV_NUMBERS.GATEWAY_PORT.default}/healthz')`,
    );
  });

  it('main serves loopback health whenever it listens on one other address', () => {
    expect(healthListenerHost('172.18.0.9')).toBe('127.0.0.1');
    expect(healthListenerHost('0.0.0.0')).toBeNull();
    expect(healthListenerHost('127.0.0.1')).toBeNull();
    const main = readFileSync(join(root, 'server/gateway/src/main.ts'), 'utf8');
    expect(main).toContain('healthListenerHost(host)');
  });

  it('the loopback listener answers /healthz and nothing else', async () => {
    const s = createHealthServer();
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
    try {
      const base = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
      expect((await fetch(`${base}/healthz`)).status).toBe(200);
      expect((await fetch(`${base}/svc/billing/mcp`)).status).toBe(404);
      expect((await fetch(`${base}/healthz`, { method: 'POST' })).status).toBe(404);
    } finally {
      s.closeAllConnections();
      s.close();
    }
  });
});
