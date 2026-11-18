/**
 * The Sync sidecar's skeleton (M1): what each route answers, and that the
 * compose health check reaches the port and path the sidecar serves.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENV_NUMBERS } from '@mantle/config';
import { describe, expect, it } from 'vitest';
import { parseRcloneVersion } from './rclone';
import { syncReply } from './server';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '../../..');

describe('the sync sidecar routes', () => {
  it('is healthy only when rclone ran at boot', () => {
    expect(syncReply('GET', '/health', { rclone: 'v1.76.0' })).toEqual({
      status: 200,
      body: { ok: true },
    });
    expect(syncReply('GET', '/health', { rclone: null }).status).toBe(503);
  });

  it('says what it is and the providers it serves', () => {
    expect(syncReply('GET', '/status', { rclone: 'v1.76.0' })).toEqual({
      status: 200,
      body: { service: 'sync', rclone: 'v1.76.0', providers: ['imap', 'ics', 'microsoft'] },
    });
  });

  it('answers 404 for any other path and 405 for any other method', () => {
    expect(syncReply('GET', '/', { rclone: 'v1.76.0' }).status).toBe(404);
    expect(syncReply('POST', '/health', { rclone: 'v1.76.0' }).status).toBe(405);
  });
});

describe('rclone version', () => {
  it('reads the first line of `rclone version`', () => {
    expect(parseRcloneVersion('rclone v1.76.0\n- os/version: alpine\n')).toBe('v1.76.0');
    expect(parseRcloneVersion('rclone v1.76.0-beta.1\n')).toBe('v1.76.0-beta.1');
    expect(parseRcloneVersion('not rclone')).toBeNull();
  });
});

describe('the compose service', () => {
  const compose = readFileSync(join(root, 'docker-compose.yml'), 'utf8');
  const start = compose.indexOf('\n  sync:\n');
  const block = compose.slice(start, compose.indexOf('\n\n  #', start));

  it('is behind the sync profile, on its own image', () => {
    expect(block).toContain("profiles: ['sync']");
    expect(block).toContain('/mantle-sync:');
    expect(block).toContain('container_name: mantle_sync');
  });

  it("checks /health on the sidecar's port", () => {
    expect(block).toContain(`fetch('http://127.0.0.1:${ENV_NUMBERS.SYNC_PORT.default}/health')`);
  });
});
