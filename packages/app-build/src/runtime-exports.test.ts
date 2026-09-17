/**
 * The manifest lookup must not depend on the working directory. app_build runs
 * from BOTH server/web (Next) and server/mcp (the agent's MCP server); a bare
 * cwd-relative path works in the first and resolves to nothing in the second,
 * which took every agent-driven build down with ENOENT until it was fixed.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadRuntimeExports, manifestCandidates } from './runtime-exports';

const ENV = 'MANTLE_APP_RUNTIME_MANIFEST';
let saved: string | undefined;

beforeEach(() => {
  saved = process.env[ENV];
});
afterEach(() => {
  if (saved === undefined) delete process.env[ENV];
  else process.env[ENV] = saved;
});

describe('manifestCandidates', () => {
  it('includes a package-relative path that does not depend on cwd', () => {
    delete process.env[ENV];
    const [pkgRelative] = manifestCandidates();
    expect(path.isAbsolute(pkgRelative!)).toBe(true);
    expect(pkgRelative).toContain(path.join('server', 'web', 'public', 'app-runtime'));
  });

  it('puts an explicit override ahead of everything else', () => {
    process.env[ENV] = '/tmp/somewhere/manifest.json';
    expect(manifestCandidates()[0]).toBe('/tmp/somewhere/manifest.json');
  });

  it('still offers the cwd convention as a fallback', () => {
    delete process.env[ENV];
    expect(manifestCandidates()).toContain(path.resolve('public/app-runtime/manifest.json'));
  });
});

describe('loadRuntimeExports', () => {
  it('reads the exports map from the override path', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mantle-mf-'));
    const file = path.join(dir, 'manifest.json');
    fs.writeFileSync(file, JSON.stringify({ imports: {}, exports: { '@host': ['host'] } }));
    process.env[ENV] = file;
    try {
      await expect(loadRuntimeExports()).resolves.toEqual({ '@host': ['host'] });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws and names every path it tried when nothing is found', async () => {
    // Candidates are injected: the real list always resolves inside this repo,
    // so the not-found path cannot be reached through the environment alone.
    const missing = [
      path.join(os.tmpdir(), 'nope-a', 'manifest.json'),
      path.join(os.tmpdir(), 'nope-b', 'manifest.json'),
    ];
    await expect(loadRuntimeExports(missing)).rejects.toThrow(/manifest not found[\s\S]*Tried:/);
    for (const m of missing) {
      await expect(loadRuntimeExports(missing)).rejects.toThrow(m);
    }
  });

  it('does not fall through to another candidate when one is present but broken', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mantle-mf-'));
    const broken = path.join(dir, 'manifest.json');
    fs.writeFileSync(broken, JSON.stringify({ imports: {} }));
    const good = path.join(dir, 'good.json');
    fs.writeFileSync(good, JSON.stringify({ exports: { '@host': ['host'] } }));
    try {
      // A stale copy further down the list must never win over a broken one.
      await expect(loadRuntimeExports([broken, good])).rejects.toThrow(/no 'exports' map/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a manifest that exists but carries no exports map', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mantle-mf-'));
    const file = path.join(dir, 'manifest.json');
    fs.writeFileSync(file, JSON.stringify({ imports: { react: '/x.js' } }));
    process.env[ENV] = file;
    try {
      await expect(loadRuntimeExports()).rejects.toThrow(/no 'exports' map/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
