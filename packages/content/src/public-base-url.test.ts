import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The localhost fallback is not a dev convenience — it is permanent damage
 * wherever it lands. Every tool result hands the assistant `url: nodeUrl(id)`,
 * and the assistant writes those links into content that is then stored;
 * nothing re-resolves them. A brain that ran turns once without a public origin
 * keeps localhost links in its content forever.
 *
 * Module state is per-import (the warning fires once per process), so each case
 * re-imports with a fresh registry.
 */
const ENV_KEYS = ['MANTLE_PUBLIC_URL', 'NEXT_PUBLIC_APP_URL'] as const;

describe('publicBaseUrl', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    vi.resetModules();
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    vi.restoreAllMocks();
  });

  it('warns exactly once when nothing is configured, naming the permanence', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { publicBaseUrl } = await import('./shares');

    expect(publicBaseUrl()).toBe('http://localhost:3000');
    publicBaseUrl();
    publicBaseUrl();

    expect(warn).toHaveBeenCalledTimes(1);
    // The message has to say what is actually at stake, or it reads as noise
    // and gets ignored — which is how this went unnoticed in the first place.
    expect(warn.mock.calls[0]?.[0]).toMatch(/STORED content/);
    expect(warn.mock.calls[0]?.[0]).toMatch(/never re-resolved/);
  });

  it('stays silent when an origin is configured, and trims a trailing slash', async () => {
    process.env.MANTLE_PUBLIC_URL = 'https://brain.example.com/';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { publicBaseUrl } = await import('./shares');

    expect(publicBaseUrl()).toBe('https://brain.example.com');
    expect(warn).not.toHaveBeenCalled();
  });

  it('accepts the NEXT_PUBLIC_APP_URL fallback without warning', async () => {
    process.env.NEXT_PUBLIC_APP_URL = 'https://app.example.com';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { publicBaseUrl } = await import('./shares');

    expect(publicBaseUrl()).toBe('https://app.example.com');
    expect(warn).not.toHaveBeenCalled();
  });
});
