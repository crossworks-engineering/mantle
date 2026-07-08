/**
 * Location builtins — the local (no-API) half of Mantle's geo awareness.
 *
 * The agent receives the device's "Current location" in the per-turn volatile
 * context (see @mantle/content buildLocationContextLine). When it needs an
 * address or proximity answer, the LAZY loop is:
 *
 *   1. location_nearby — is a saved place already close? Reuse its address.
 *   2. else mapbox_reverse_geocode (an HTTP tool, seeded at install) → address.
 *   3. location_save — persist the resolved place as a `location` node so the
 *      next nearby turn skips the API call.
 *
 * location_distance is the reliable "how far" primitive — haversine in TS so the
 * model never hallucinates the arithmetic. save/nearby/distance are pure compute
 * / DB writes (no secrets); the API key only matters to the Mapbox HTTP tools.
 *
 * route_map is the exception: it takes the encoded polyline from the swappable
 * `mapbox_directions` HTTP tool and renders an overview PNG via the Mapbox
 * Static Images API (fetched server-side with the vault key) — emitted as an
 * image artifact so both chat surfaces show the route inline. See its own note.
 */

import {
  createLocation,
  findNearbyLocations,
  haversineMeters,
  type NearbyLocation,
} from '@mantle/content';
import { getApiKey } from '@mantle/api-keys';
import { recordIngest } from '@mantle/tracing';
import type { BuiltinToolDef } from './types';

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}
function strOpt(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined;
}
function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function compactNearby(n: NearbyLocation) {
  return {
    id: n.id,
    title: n.title,
    address: n.address,
    latitude: n.latitude,
    longitude: n.longitude,
    distance_meters: Math.round(n.distanceMeters),
    tags: n.tags,
  };
}

const location_save: BuiltinToolDef = {
  slug: 'location_save',
  name: 'Save a resolved place',
  description:
    "Persist a place (coordinates + reverse-geocoded address) as a `location` node so future turns near the same spot can reuse it without re-calling the geocoding API. Call this AFTER mapbox_reverse_geocode resolves an address for coordinates you don't already have saved (check location_nearby first). The place is indexed into the brain (searchable via search_nodes). `title` defaults to the address; pass a friendly label (e.g. 'home', 'the office') and `tags` when you know them.",
  inputSchema: {
    type: 'object',
    properties: {
      latitude: { type: 'number', description: 'decimal degrees, −90..90' },
      longitude: { type: 'number', description: 'decimal degrees, −180..180' },
      address: { type: 'string', description: 'reverse-geocoded address (place_name)' },
      title: { type: 'string', description: "optional label; defaults to the address" },
      source: { type: 'string', description: "provider that resolved it, e.g. 'mapbox'" },
      body: { type: 'string', description: 'optional notes about the place' },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: "Labels for organisation and filtering, e.g. ['work'].",
      },
    },
    required: ['latitude', 'longitude'],
  },
  handler: async (input, ctx) => {
    const latitude = num(input.latitude);
    const longitude = num(input.longitude);
    if (latitude === null || longitude === null) {
      return { ok: false, error: 'latitude and longitude must be finite numbers' };
    }
    try {
      const row = await createLocation(ctx.ownerId, {
        latitude,
        longitude,
        address: strOpt(input.address),
        title: strOpt(input.title),
        source: strOpt(input.source),
        body: strOpt(input.body),
        tags: Array.isArray(input.tags)
          ? (input.tags as unknown[]).filter((t): t is string => typeof t === 'string')
          : [],
      });
      ctx.step?.setOutput({ id: row.id, title: row.title });
      void recordIngest({
        source: 'agent_tool',
        ownerId: ctx.ownerId,
        nodeId: row.id,
        summary: `Location saved by tool: ${row.title}`,
        payload: {
          via: 'location_save_tool',
          ...(row.source ? { provider: row.source } : {}),
          ...(ctx.agent ? { invokingAgent: ctx.agent.slug } : {}),
        },
        snippet: row.address ?? `${latitude}, ${longitude}`,
      });
      return { ok: true, output: row };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
};

const location_nearby: BuiltinToolDef = {
  slug: 'location_nearby',
  name: 'Find saved places nearby',
  description:
    "Return the user's previously-saved `location` places within `radius_meters` of a point, nearest first (with the distance to each). Call this FIRST when you need an address for coordinates — if a saved place is close enough, reuse its address instead of calling the geocoding API. Also answers 'have I been near here before?' / 'what saved places are around me?'. Defaults to the device's current coordinates is NOT automatic — pass the lat/lon you care about (usually the Current location from context).",
  inputSchema: {
    type: 'object',
    properties: {
      latitude: { type: 'number', description: 'latitude of the point to search around, e.g. -33.918' },
      longitude: { type: 'number', description: 'longitude of the point to search around, e.g. 18.423' },
      radius_meters: { type: 'number', description: 'search radius in metres (default 150)', default: 150 },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 50,
        default: 10,
        description: 'Max results to return. Default 10, cap 50.',
      },
    },
    required: ['latitude', 'longitude'],
  },
  handler: async (input, ctx) => {
    const latitude = num(input.latitude);
    const longitude = num(input.longitude);
    if (latitude === null || longitude === null) {
      return { ok: false, error: 'latitude and longitude must be finite numbers' };
    }
    const radius = num(input.radius_meters) ?? 150;
    const limit = Math.min(Math.max(1, num(input.limit) ?? 10), 50);
    try {
      const rows = await findNearbyLocations(ctx.ownerId, latitude, longitude, radius, limit);
      ctx.step?.setOutput({ count: rows.length });
      return { ok: true, output: { count: rows.length, places: rows.map(compactNearby) } };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
};

const location_distance: BuiltinToolDef = {
  slug: 'location_distance',
  name: 'Distance between two points',
  description:
    "Great-circle (straight-line) distance in metres between two lat/lon points. Use this to answer 'how far is X from me' reliably — do NOT estimate distances from coordinates yourself. Note this is as-the-crow-flies, not travel distance; say so when it matters.",
  inputSchema: {
    type: 'object',
    properties: {
      from_latitude: { type: 'number', description: 'start point latitude, e.g. -33.918' },
      from_longitude: { type: 'number', description: 'start point longitude, e.g. 18.423' },
      to_latitude: { type: 'number', description: 'end point latitude, e.g. -34.357' },
      to_longitude: { type: 'number', description: 'end point longitude, e.g. 18.474' },
    },
    required: ['from_latitude', 'from_longitude', 'to_latitude', 'to_longitude'],
  },
  handler: async (input, ctx) => {
    const a1 = num(input.from_latitude);
    const o1 = num(input.from_longitude);
    const a2 = num(input.to_latitude);
    const o2 = num(input.to_longitude);
    if (a1 === null || o1 === null || a2 === null || o2 === null) {
      return { ok: false, error: 'all four coordinates must be finite numbers' };
    }
    const meters = haversineMeters(a1, o1, a2, o2);
    ctx.step?.setOutput({ meters: Math.round(meters) });
    return {
      ok: true,
      output: {
        meters: Math.round(meters),
        kilometers: Math.round(meters / 10) / 100,
        straight_line: true,
      },
    };
  },
};

// ── route_map ────────────────────────────────────────────────────────────────
//
// The one provider-coupled binary step. The routing DATA comes from the
// swappable `mapbox_directions` HTTP tool (API console); this builtin turns its
// encoded polyline into an inline PNG via the Mapbox Static Images API, fetched
// SERVER-SIDE so the key never reaches the client, and emits it as an image
// artifact — the channel both chat surfaces already render (web ArtifactView,
// companion base64→temp-file→Image.file). Mirrors generate_image. Swapping the
// static-image provider is an edit here (the style/base constants), while the
// routing itself stays swappable in the console.

const STATIC_MAP_STYLE = 'mapbox/streets-v12';
const STATIC_MAP_BASE = 'https://api.mapbox.com/styles/v1';
const ROUTE_STROKE = { width: 5, color: '2563eb', opacity: 0.85 }; // route line (literal — a PNG can't read the app theme)
const STATIC_MAX_URL = 8192; // Mapbox Static Images URL cap
const STATIC_TIMEOUT_MS = 15_000;

function coord(lon: number, lat: number): string {
  // Static Images wants lon,lat; trim to ~5dp to keep the URL short.
  return `${Number(lon.toFixed(6))},${Number(lat.toFixed(6))}`;
}

const route_map: BuiltinToolDef = {
  slug: 'route_map',
  name: 'Plot a route on a map',
  description:
    "Render an overview map PNG of a route and show it inline in the chat. Pass the `polyline` returned by mapbox_directions (its `geometry`, an encoded polyline) plus the origin (`from_longitude`/`from_latitude`) and destination (`to_longitude`/`to_latitude`) for the start/end pins. The path is auto-fitted to the image. Optionally pass `from_label`/`to_label`, `distance_meters`, `duration_seconds`, `profile` to caption it. Call this AFTER mapbox_directions to show the user where a place is and the way there — it's a static overview, not live navigation. Requires a Mapbox key (Settings → API keys, service 'mapbox'); returns the map as an image the user sees inline.",
  inputSchema: {
    type: 'object',
    properties: {
      polyline: { type: 'string', description: "encoded polyline (precision 5) from mapbox_directions `geometry`" },
      from_longitude: { type: 'number', description: 'origin longitude' },
      from_latitude: { type: 'number', description: 'origin latitude' },
      to_longitude: { type: 'number', description: 'destination longitude' },
      to_latitude: { type: 'number', description: 'destination latitude' },
      from_label: { type: 'string', description: "optional caption label for the start (e.g. 'You')" },
      to_label: { type: 'string', description: "optional caption label for the destination" },
      distance_meters: { type: 'number', description: "optional route distance for the caption" },
      duration_seconds: { type: 'number', description: "optional route duration for the caption" },
      profile: { type: 'string', description: "optional: 'driving' | 'walking', for the caption" },
    },
    required: ['polyline', 'from_longitude', 'from_latitude', 'to_longitude', 'to_latitude'],
  },
  handler: async (input, ctx) => {
    const polyline = str(input.polyline);
    const fromLon = num(input.from_longitude);
    const fromLat = num(input.from_latitude);
    const toLon = num(input.to_longitude);
    const toLat = num(input.to_latitude);
    if (!polyline) return { ok: false, error: 'polyline is required (pass mapbox_directions geometry)' };
    if (fromLon === null || fromLat === null || toLon === null || toLat === null) {
      return { ok: false, error: 'from/to longitude and latitude must be finite numbers' };
    }

    const key = await getApiKey(ctx.ownerId, 'mapbox', 'default');
    if (!key) {
      return {
        ok: false,
        error: "No Mapbox key on file. Add one under Settings → API keys (service 'mapbox', label 'default') to plot routes.",
      };
    }

    // path overlay (encoded polyline must be URL-encoded) + start/end pins.
    const path = `path-${ROUTE_STROKE.width}+${ROUTE_STROKE.color}-${ROUTE_STROKE.opacity}(${encodeURIComponent(polyline)})`;
    const pins = `pin-s-a+2563eb(${coord(fromLon, fromLat)}),pin-s-b+ef4444(${coord(toLon, toLat)})`;
    const w = 600;
    const h = 400;
    const buildUrl = (overlays: string) =>
      `${STATIC_MAP_BASE}/${STATIC_MAP_STYLE}/static/${overlays}/auto/${w}x${h}@2x?padding=40&access_token=${encodeURIComponent(key)}`;

    let url = buildUrl(`${path},${pins}`);
    let droppedPath = false;
    if (url.length > STATIC_MAX_URL) {
      // Route too long to encode in the URL — fall back to start/end pins only.
      url = buildUrl(pins);
      droppedPath = true;
    }

    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), STATIC_TIMEOUT_MS);
      let res: Response;
      try {
        res = await fetch(url, { signal: ctrl.signal });
      } finally {
        clearTimeout(timer);
      }
      if (!res.ok) {
        const body = (await res.text().catch(() => '')).slice(0, 200);
        return { ok: false, error: `Mapbox static images ${res.status}: ${body}` };
      }
      const mimeType = res.headers.get('content-type')?.split(';')[0] || 'image/png';
      const bytes = Buffer.from(await res.arrayBuffer());

      const km = num(input.distance_meters) !== null ? Math.round((input.distance_meters as number) / 100) / 10 : null;
      const mins = num(input.duration_seconds) !== null ? Math.round((input.duration_seconds as number) / 60) : null;
      const fromLabel = strOpt(input.from_label);
      const toLabel = strOpt(input.to_label);
      const captionParts = [
        fromLabel && toLabel ? `${fromLabel} → ${toLabel}` : 'Route',
        km !== null ? `${km} km` : null,
        mins !== null ? `${mins} min` : null,
        strOpt(input.profile),
      ].filter(Boolean);
      const caption = captionParts.join(' · ');

      ctx.step?.setOutput({ bytes: bytes.length, droppedPath });
      return {
        ok: true,
        output: {
          rendered: true,
          width: w,
          height: h,
          ...(droppedPath ? { note: 'route line omitted (too long for a static URL); pins only' } : {}),
        },
        artifacts: [
          {
            kind: 'image',
            mimeType,
            base64: bytes.toString('base64'),
            caption,
            producedBy: 'route_map',
          },
        ],
      };
    } catch (err) {
      const msg = err instanceof Error && err.name === 'AbortError' ? 'static map request timed out' : err instanceof Error ? err.message : String(err);
      return { ok: false, error: msg };
    }
  },
};

export const LOCATION_TOOLS: BuiltinToolDef[] = [
  location_save,
  location_nearby,
  location_distance,
  route_map,
];

export const LOCATION_TOOL_SLUGS: readonly string[] = LOCATION_TOOLS.map((t) => t.slug);
