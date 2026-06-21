/**
 * LocationPing — the universal (iOS + Android) device-location object the
 * companion app attaches to every message it POSTs to /api/assistant/turn.
 *
 * It is stored verbatim on the inbound `assistant_messages.data` JSONB
 * (`{ location: LocationPing }`) and rendered into the per-turn volatile
 * context via `buildLocationContextLine`, so the agent is location-aware on
 * every turn. Reverse-geocoding (lat/lon → address) is LAZY: the agent calls
 * the Mapbox tools only when an address/proximity answer is actually needed,
 * caching the result as a `location` node (see ./locations.ts).
 *
 * No zod here — @mantle/content carries no zod dependency, so we validate the
 * same way the rest of the package does (manual coercion + range guards). The
 * sanitizer is deliberately TOLERANT: a malformed field is dropped, not fatal,
 * because a bad GPS value must never break a chat turn. It returns null only
 * when lat/lon are unusable (there's nothing location-aware to say without
 * coordinates).
 */

/** Where the OS sourced the fix — drives how much the agent should trust it. */
export type LocationSource = 'gps' | 'network' | 'fused' | 'other';

export type LocationPing = {
  /** Decimal degrees, −90..90. */
  latitude: number;
  /** Decimal degrees, −180..180. */
  longitude: number;
  /** ISO 8601 instant the fix was captured (defaults to now if absent). */
  timestamp: string;
  /** Horizontal accuracy radius, metres (smaller = better). */
  accuracy?: number;
  /** Metres above sea level. */
  altitude?: number;
  /** Vertical accuracy, metres. */
  altitudeAccuracy?: number;
  /** Ground speed, m/s. */
  speed?: number;
  /** Course over ground, degrees 0..360 (0 = north). */
  heading?: number;
  /** Battery level as a 0..1 fraction (100-scale inputs are normalised). */
  battery?: number;
  /** OS location provider, when reported. */
  source?: LocationSource;
  /** True when the OS flagged the fix as mocked/simulated — do not trust. */
  isMock?: boolean;
};

const SOURCES: ReadonlySet<string> = new Set(['gps', 'network', 'fused', 'other']);

function finite(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Read a property tolerating snake_case + camelCase keys from the wire. */
function pick(o: Record<string, unknown>, ...keys: string[]): unknown {
  for (const k of keys) if (o[k] !== undefined && o[k] !== null) return o[k];
  return undefined;
}

/**
 * Coerce an arbitrary wire value into a clean LocationPing, or null if it has
 * no usable coordinates. Accepts both camelCase and snake_case keys so the
 * mobile client can send whichever its platform plugin produces. Out-of-range
 * or non-finite optional fields are silently dropped.
 */
export function sanitizeLocationPing(raw: unknown): LocationPing | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;

  const lat = finite(pick(o, 'latitude', 'lat'));
  const lon = finite(pick(o, 'longitude', 'lon', 'lng'));
  if (lat === null || lon === null) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;

  // Timestamp: accept an ISO string or epoch ms; default to now if unusable so
  // a missing/garbled clock never costs us the fix.
  let timestamp = new Date().toISOString();
  const ts = pick(o, 'timestamp', 'time', 'ts');
  if (typeof ts === 'string' && !Number.isNaN(Date.parse(ts))) {
    timestamp = new Date(ts).toISOString();
  } else if (typeof ts === 'number' && Number.isFinite(ts)) {
    timestamp = new Date(ts).toISOString();
  }

  const out: LocationPing = { latitude: lat, longitude: lon, timestamp };

  const accuracy = finite(pick(o, 'accuracy', 'horizontalAccuracy', 'horizontal_accuracy'));
  if (accuracy !== null && accuracy >= 0) out.accuracy = accuracy;

  const altitude = finite(pick(o, 'altitude', 'elevation'));
  if (altitude !== null) out.altitude = altitude;

  const altAcc = finite(pick(o, 'altitudeAccuracy', 'altitude_accuracy', 'verticalAccuracy'));
  if (altAcc !== null && altAcc >= 0) out.altitudeAccuracy = altAcc;

  const speed = finite(pick(o, 'speed'));
  if (speed !== null && speed >= 0) out.speed = speed;

  const heading = finite(pick(o, 'heading', 'course', 'bearing'));
  if (heading !== null && heading >= 0 && heading <= 360) out.heading = heading;

  // Battery: normalise a 0..100 percentage to a 0..1 fraction; clamp.
  const batteryRaw = finite(pick(o, 'battery', 'batteryLevel', 'battery_level'));
  if (batteryRaw !== null && batteryRaw >= 0) {
    const frac = batteryRaw > 1 ? batteryRaw / 100 : batteryRaw;
    out.battery = Math.max(0, Math.min(1, frac));
  }

  const source = pick(o, 'source', 'provider');
  if (typeof source === 'string' && SOURCES.has(source)) out.source = source as LocationSource;

  const isMock = pick(o, 'isMock', 'is_mock', 'mocked');
  if (typeof isMock === 'boolean') out.isMock = isMock;

  return out;
}

/** Accuracy above this (metres) is "approximate" and the agent is told so. */
const LOW_ACCURACY_M = 100;

function fmt(n: number, digits = 0): string {
  return n.toFixed(digits);
}

/**
 * Render a one-line "Current location" block for the per-turn volatile context
 * (sits beside the time line — see apps/web/lib/assistant.ts). Returns '' for a
 * null ping so callers can `.filter(Boolean)` it out. Written for the model to
 * reason over, not for display: it names the units and tells the agent how to
 * act on the fix (resolve an address / find nearby places only when relevant).
 */
export function buildLocationContextLine(ping: LocationPing | null): string {
  if (!ping) return '';
  const parts: string[] = [`Current location: ${fmt(ping.latitude, 5)}, ${fmt(ping.longitude, 5)}`];
  if (ping.accuracy !== undefined) parts.push(`±${fmt(ping.accuracy)}m`);
  if (ping.altitude !== undefined) parts.push(`altitude ${fmt(ping.altitude)}m`);
  if (ping.speed !== undefined && ping.speed >= 0.5) {
    const heading = ping.heading !== undefined ? ` heading ${fmt(ping.heading)}°` : '';
    parts.push(`moving ${fmt(ping.speed, 1)} m/s${heading}`);
  }
  if (ping.battery !== undefined) parts.push(`battery ${fmt(ping.battery * 100)}%`);

  let line = parts.join(', ') + `. Captured ${ping.timestamp}.`;

  const flags: string[] = [];
  if (ping.isMock) flags.push('reported as a MOCK/simulated location — do not trust it');
  if (ping.accuracy !== undefined && ping.accuracy > LOW_ACCURACY_M) {
    flags.push(`low accuracy (±${fmt(ping.accuracy)}m) — treat as approximate`);
  }
  if (ping.source && ping.source !== 'gps') flags.push(`source: ${ping.source}`);
  if (flags.length) line += ` [${flags.join('; ')}]`;

  line +=
    ' Use the location tools (location_nearby / mapbox_reverse_geocode / mapbox_search /' +
    ' location_distance) when the user asks where they are, how far something is, or what is nearby —' +
    ' do not guess coordinates into prose.';
  return line;
}
