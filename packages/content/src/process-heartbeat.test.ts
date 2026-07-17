import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { heartbeatFilePath, startProcessHeartbeat } from './process-heartbeat';

describe('heartbeatFilePath', () => {
  const orig = process.env.MANTLE_HEARTBEAT_FILE;
  afterEach(() => {
    if (orig === undefined) delete process.env.MANTLE_HEARTBEAT_FILE;
    else process.env.MANTLE_HEARTBEAT_FILE = orig;
  });

  it('defaults to /tmp/mantle-heartbeat', () => {
    delete process.env.MANTLE_HEARTBEAT_FILE;
    expect(heartbeatFilePath()).toBe('/tmp/mantle-heartbeat');
  });

  it('honors the env override (trimmed)', () => {
    process.env.MANTLE_HEARTBEAT_FILE = '  /var/run/hb  ';
    expect(heartbeatFilePath()).toBe('/var/run/hb');
  });
});

describe('startProcessHeartbeat', () => {
  it('writes the heartbeat file immediately and stops cleanly', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'mantle-hb-'));
    const file = path.join(dir, 'beat');
    process.env.MANTLE_HEARTBEAT_FILE = file;
    const stop = startProcessHeartbeat(10_000);
    // The immediate touch is async (fs write) — let the IO settle.
    await new Promise((r) => setTimeout(r, 25));
    const body = await readFile(file, 'utf8');
    expect(Number(body.trim())).toBeGreaterThan(0);
    stop();
    delete process.env.MANTLE_HEARTBEAT_FILE;
    await rm(dir, { recursive: true, force: true });
  });
});
