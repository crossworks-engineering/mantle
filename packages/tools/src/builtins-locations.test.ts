/**
 * route_map — turns a Directions polyline into an inline map PNG via the Mapbox
 * Static Images API. The invariants that matter: the key is read from the vault
 * and injected SERVER-SIDE (never returned to the model), the polyline + pins are
 * encoded into a valid static URL, an over-long URL falls back to pins-only, and
 * the PNG comes back as an image artifact (the channel both chat surfaces render).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const getApiKey = vi.fn();
vi.mock('@mantle/api-keys', () => ({ getApiKey: (...a: unknown[]) => getApiKey(...a) }));
// recordIngest isn't exercised here but builtins-locations imports it.
vi.mock('@mantle/tracing', () => ({ recordIngest: vi.fn() }));

import { LOCATION_TOOLS } from './builtins-locations';
import type { ToolHandlerResult } from './types';

const route_map = LOCATION_TOOLS.find((t) => t.slug === 'route_map')!;
const ctx = { ownerId: 'owner-1' } as never;

const baseInput = {
  polyline: 'abcd~efg', // a short fake encoded polyline
  from_longitude: 18.4241,
  from_latitude: -33.9249,
  to_longitude: 18.45,
  to_latitude: -33.9,
};

function pngResponse() {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'image/png' }),
    arrayBuffer: async () => new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer, // "\x89PNG"
    text: async () => '',
  } as unknown as Response;
}

afterEach(() => {
  vi.restoreAllMocks();
  getApiKey.mockReset();
});

describe('route_map', () => {
  it('builds a static-images URL with the path + pins and returns a PNG image artifact', async () => {
    getApiKey.mockResolvedValue('pk.SECRET-KEY');
    let calledUrl = '';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        calledUrl = url;
        return pngResponse();
      }),
    );

    const res = (await route_map.handler(
      {
        ...baseInput,
        from_label: 'You',
        to_label: 'Truth Coffee',
        distance_meters: 3200,
        duration_seconds: 480,
        profile: 'driving',
      },
      ctx,
    )) as Extract<ToolHandlerResult, { ok: true }>;

    expect(res.ok).toBe(true);
    // URL: server-side key injection + the route overlay + auto viewport.
    expect(calledUrl).toContain('https://api.mapbox.com/styles/v1/mapbox/streets-v12/static/');
    expect(calledUrl).toContain('path-5+2563eb-0.85(');
    expect(calledUrl).toContain('pin-s-a');
    expect(calledUrl).toContain('pin-s-b');
    expect(calledUrl).toContain('/auto/600x400@2x');
    expect(calledUrl).toContain('access_token=pk.SECRET-KEY');
    // The encoded polyline is URL-encoded into the path overlay (the `~` escapes).
    expect(calledUrl).toContain(encodeURIComponent('abcd~efg'));

    // Artifact: a PNG, captioned, NOT leaking the key/url in the model-visible output.
    expect(res.artifacts).toHaveLength(1);
    expect(res.artifacts![0]).toMatchObject({
      kind: 'image',
      mimeType: 'image/png',
      producedBy: 'route_map',
    });
    expect(res.artifacts![0]!.base64.length).toBeGreaterThan(0);
    expect(res.artifacts![0]!.caption).toContain('You → Truth Coffee');
    expect(JSON.stringify(res.output)).not.toContain('pk.SECRET-KEY');
  });

  it('falls back to pins-only when the route URL would exceed the static-images cap', async () => {
    getApiKey.mockResolvedValue('pk.SECRET-KEY');
    let calledUrl = '';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        calledUrl = url;
        return pngResponse();
      }),
    );

    const huge = 'a'.repeat(9000); // pushes the path overlay past the 8192 cap
    const res = (await route_map.handler({ ...baseInput, polyline: huge }, ctx)) as Extract<
      ToolHandlerResult,
      { ok: true }
    >;

    expect(res.ok).toBe(true);
    expect(calledUrl).not.toContain('path-5+'); // path dropped
    expect(calledUrl).toContain('pin-s-a'); // pins kept
    expect((res.output as { note?: string }).note).toMatch(/route line omitted/i);
  });

  it('returns a clear error (no fetch) when no Mapbox key is on file', async () => {
    getApiKey.mockResolvedValue(null);
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const res = await route_map.handler(baseInput, ctx);

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/mapbox key/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('surfaces a Mapbox HTTP error instead of emitting an artifact', async () => {
    getApiKey.mockResolvedValue('pk.SECRET-KEY');
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          ({
            ok: false,
            status: 422,
            headers: new Headers(),
            arrayBuffer: async () => new ArrayBuffer(0),
            text: async () => 'Not Found',
          }) as unknown as Response,
      ),
    );

    const res = await route_map.handler(baseInput, ctx);

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('422');
  });
});
