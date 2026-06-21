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
 * model never hallucinates the arithmetic. These are pure compute / DB writes
 * (no secrets); the API key only matters to the Mapbox HTTP tools.
 */

import {
  createLocation,
  findNearbyLocations,
  haversineMeters,
  type NearbyLocation,
} from '@mantle/content';
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
      tags: { type: 'array', items: { type: 'string' } },
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
      latitude: { type: 'number' },
      longitude: { type: 'number' },
      radius_meters: { type: 'number', description: 'search radius in metres (default 150)', default: 150 },
      limit: { type: 'integer', minimum: 1, maximum: 50, default: 10 },
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
      from_latitude: { type: 'number' },
      from_longitude: { type: 'number' },
      to_latitude: { type: 'number' },
      to_longitude: { type: 'number' },
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

export const LOCATION_TOOLS: BuiltinToolDef[] = [location_save, location_nearby, location_distance];

export const LOCATION_TOOL_SLUGS: readonly string[] = LOCATION_TOOLS.map((t) => t.slug);
