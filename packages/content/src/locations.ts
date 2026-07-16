/**
 * Locations surface. A location is a `nodes` row with type='location' — a
 * RESOLVED place: coordinates the agent has reverse-geocoded into an address
 * and saved for reuse, so a later turn near the same spot doesn't re-hit the
 * geocoding API.
 *
 *   nodes.title          place name / short label (e.g. "Truth Coffee")
 *   nodes.data.body      free-text notes about the place (optional)
 *   nodes.data.latitude  decimal degrees
 *   nodes.data.longitude decimal degrees
 *   nodes.data.address   full reverse-geocoded address (place_name)
 *   nodes.data.source    which provider resolved it ('mapbox', 'locationiq', …)
 *   nodes.data.raw       the provider's raw feature (for re-formatting later)
 *   nodes.tags           freeform tags (e.g. 'home', 'cafe')
 *
 * All under the `locations` ltree root. Lazy-created on first write. `location`
 * is in the extractor's DEFAULT_EXTRACT_TYPES, so name + address are summarised
 * + embedded automatically — places become findable by `search_nodes` too.
 *
 * Proximity is plain haversine in TS (no PostGIS): at single-user scale the set
 * of saved places is small, so we fetch + rank in process. `haversineMeters` is
 * exported (pure, unit-tested) and reused by the geo builtins.
 */
import { and, desc, eq, ilike, or, sql } from 'drizzle-orm';
import { db, nodes, notifyNodeIngested, type Node } from '@mantle/db';

export const LOCATIONS_ROOT_LABEL = 'locations';

export type LocationRow = {
  id: string;
  title: string;
  body: string;
  latitude: number | null;
  longitude: number | null;
  address: string | null;
  source: string | null;
  tags: string[];
  summary: string | null;
  createdAt: string;
  updatedAt: string;
};

function str(d: Record<string, unknown>, k: string): string | null {
  const v = d[k];
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : null;
}
function numOrNull(d: Record<string, unknown>, k: string): number | null {
  const v = d[k];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function rowOf(n: Node): LocationRow {
  const d = (n.data ?? {}) as Record<string, unknown>;
  return {
    id: n.id,
    title: n.title,
    body: typeof d.body === 'string' ? d.body : '',
    latitude: numOrNull(d, 'latitude'),
    longitude: numOrNull(d, 'longitude'),
    address: str(d, 'address'),
    source: str(d, 'source'),
    tags: n.tags ?? [],
    summary: typeof d.summary === 'string' ? d.summary : null,
    createdAt: n.createdAt.toISOString(),
    updatedAt: n.updatedAt.toISOString(),
  };
}

async function ensureRoot(ownerId: string): Promise<void> {
  await db
    .insert(nodes)
    .values({
      ownerId,
      type: 'branch',
      title: 'Locations',
      slug: LOCATIONS_ROOT_LABEL,
      path: LOCATIONS_ROOT_LABEL,
      data: {
        description:
          'Resolved places — coordinates reverse-geocoded to addresses and saved for reuse. Indexed, embedded, and searchable.',
      },
    })
    .onConflictDoNothing({
      target: [nodes.ownerId, nodes.path],
      where: sql`${nodes.type} = 'branch'`,
    });
}

type ListLocationsOpts = {
  query?: string;
  tag?: string;
};

function locationConds(ownerId: string, opts: ListLocationsOpts) {
  const conds = [eq(nodes.ownerId, ownerId), eq(nodes.type, 'location')];
  if (opts.query?.trim()) {
    const q = `%${opts.query.trim()}%`;
    const c = or(
      ilike(nodes.title, q),
      sql`${nodes.data}->>'body' ilike ${q}`,
      sql`${nodes.data}->>'address' ilike ${q}`,
      sql`${nodes.data}->>'summary' ilike ${q}`,
    );
    if (c) conds.push(c);
  }
  if (opts.tag) conds.push(sql`${opts.tag} = ANY(${nodes.tags})`);
  return conds;
}

export async function listLocations(
  ownerId: string,
  opts: ListLocationsOpts & { limit?: number; offset?: number } = {},
): Promise<LocationRow[]> {
  const rows = await db
    .select()
    .from(nodes)
    .where(and(...locationConds(ownerId, opts)))
    .orderBy(desc(nodes.updatedAt))
    .limit(opts.limit ?? 500)
    .offset(opts.offset ?? 0);
  return rows.map(rowOf);
}

export async function countLocations(
  ownerId: string,
  opts: ListLocationsOpts = {},
): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(nodes)
    .where(and(...locationConds(ownerId, opts)));
  return row?.n ?? 0;
}

export async function listLocationTags(ownerId: string): Promise<{ tag: string; count: number }[]> {
  const rows = await db
    .select({ tags: nodes.tags })
    .from(nodes)
    .where(and(eq(nodes.ownerId, ownerId), eq(nodes.type, 'location')));
  const counts = new Map<string, number>();
  for (const r of rows) {
    for (const t of r.tags ?? []) counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

export async function getLocation(ownerId: string, id: string): Promise<LocationRow | null> {
  const [row] = await db
    .select()
    .from(nodes)
    .where(and(eq(nodes.id, id), eq(nodes.ownerId, ownerId), eq(nodes.type, 'location')))
    .limit(1);
  return row ? rowOf(row) : null;
}

export type CreateLocationInput = {
  title?: string;
  body?: string;
  latitude: number;
  longitude: number;
  address?: string;
  source?: string;
  raw?: unknown;
  tags?: string[];
};

export async function createLocation(
  ownerId: string,
  input: CreateLocationInput,
): Promise<LocationRow> {
  if (!Number.isFinite(input.latitude) || !Number.isFinite(input.longitude)) {
    throw new Error('latitude and longitude must be finite numbers');
  }
  await ensureRoot(ownerId);
  const data: Record<string, unknown> = {
    latitude: input.latitude,
    longitude: input.longitude,
  };
  if (input.body?.trim()) data.body = input.body.trim();
  if (input.address?.trim()) data.address = input.address.trim();
  if (input.source?.trim()) data.source = input.source.trim();
  if (input.raw !== undefined) data.raw = input.raw;
  const title =
    input.title?.trim() ||
    input.address?.trim() ||
    `${input.latitude.toFixed(5)}, ${input.longitude.toFixed(5)}`;
  const [row] = await db
    .insert(nodes)
    .values({
      ownerId,
      type: 'location',
      title: title.slice(0, 200),
      path: LOCATIONS_ROOT_LABEL,
      data,
      tags: dedupeTags(input.tags ?? []),
    })
    .returning();
  if (!row) throw new Error('createLocation: insert returned no row');
  return rowOf(row);
}

export type UpdateLocationInput = Partial<Omit<CreateLocationInput, 'latitude' | 'longitude'>> & {
  latitude?: number;
  longitude?: number;
};

export async function updateLocation(
  ownerId: string,
  id: string,
  input: UpdateLocationInput,
): Promise<LocationRow | null> {
  const [node] = await db
    .select()
    .from(nodes)
    .where(and(eq(nodes.id, id), eq(nodes.ownerId, ownerId), eq(nodes.type, 'location')))
    .limit(1);
  if (!node) return null;
  const oldData = (node.data ?? {}) as Record<string, unknown>;
  const newData: Record<string, unknown> = { ...oldData };
  let textChanged = false;

  if (input.latitude !== undefined && Number.isFinite(input.latitude))
    newData.latitude = input.latitude;
  if (input.longitude !== undefined && Number.isFinite(input.longitude))
    newData.longitude = input.longitude;
  if (input.body !== undefined) {
    const b = input.body.trim();
    if (b) newData.body = b;
    else delete newData.body;
    textChanged = true;
  }
  if (input.address !== undefined) {
    const a = input.address.trim();
    if (a) newData.address = a;
    else delete newData.address;
    textChanged = true;
  }
  if (input.source !== undefined) {
    const s = input.source.trim();
    if (s) newData.source = s;
    else delete newData.source;
  }
  if (input.raw !== undefined) newData.raw = input.raw;

  // title/address feed the embedding — invalidate the prior summary so the
  // extractor re-runs (mirrors journal/notes).
  if (textChanged) {
    delete newData.summary;
    delete newData.summary_model;
    delete newData.summary_at;
    delete newData.entities;
  }
  const [updated] = await db
    .update(nodes)
    .set({
      ...(input.title !== undefined
        ? { title: input.title.trim().slice(0, 200) || node.title }
        : {}),
      ...(input.tags !== undefined ? { tags: dedupeTags(input.tags) } : {}),
      data: newData,
      ...(textChanged ? { embedding: null } : {}),
      updatedAt: new Date(),
    })
    .where(eq(nodes.id, id))
    .returning();
  if (!updated) throw new Error('updateLocation: update returned no row');
  if (textChanged) await notifyNodeIngested(id);
  return rowOf(updated);
}

export async function deleteLocation(ownerId: string, id: string): Promise<boolean> {
  const [row] = await db
    .select({ id: nodes.id })
    .from(nodes)
    .where(and(eq(nodes.id, id), eq(nodes.ownerId, ownerId), eq(nodes.type, 'location')))
    .limit(1);
  if (!row) return false;
  await db.delete(nodes).where(eq(nodes.id, id));
  return true;
}

/**
 * Great-circle distance between two lat/lon points, in metres. Pure — exported
 * for the geo builtins (location_nearby / location_distance) and unit-tested.
 */
export function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6_371_000; // Earth radius, metres
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

export type NearbyLocation = LocationRow & { distanceMeters: number };

/**
 * Saved `location` nodes within `radiusMeters` of a point, nearest first.
 * Fetches the owner's georeferenced places and ranks in process (no PostGIS).
 * Used by the cache-reader half of the lazy-geocoding loop: if a saved place is
 * already close, the agent reuses its address instead of re-geocoding.
 */
export async function findNearbyLocations(
  ownerId: string,
  lat: number,
  lon: number,
  radiusMeters: number,
  limit = 10,
): Promise<NearbyLocation[]> {
  const rows = await db
    .select()
    .from(nodes)
    .where(
      and(
        eq(nodes.ownerId, ownerId),
        eq(nodes.type, 'location'),
        sql`${nodes.data}->>'latitude' is not null`,
        sql`${nodes.data}->>'longitude' is not null`,
      ),
    );
  const out: NearbyLocation[] = [];
  for (const n of rows) {
    const r = rowOf(n);
    if (r.latitude === null || r.longitude === null) continue;
    const distanceMeters = haversineMeters(lat, lon, r.latitude, r.longitude);
    if (distanceMeters <= radiusMeters) out.push({ ...r, distanceMeters });
  }
  out.sort((a, b) => a.distanceMeters - b.distanceMeters);
  return out.slice(0, limit);
}

function dedupeTags(tags: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of tags) {
    const t = raw.trim().toLowerCase();
    if (!t || t.length > 40 || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= 20) break;
  }
  return out;
}
