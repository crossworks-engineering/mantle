# Handover — Companion location integration

_Written 2026-06-21 · backend shipped in **v0.27.0** (live on prod)._

This is the contract the **Mantle Companion** app (Flutter, `~/Projects/mantle-companion`)
implements to send device location to Mantle. The backend half is **done and
deployed** — this doc tells the mobile side exactly what to send, where, and what
happens to it. Nothing new server-side is required to start sending.

## TL;DR for the app

- Attach a `location` object to the **existing chat-turn request** — there is **no
  new endpoint**. Location rides *on the message*.
- `POST /api/assistant/turn`, same `Authorization: Bearer <mobile token>` as every
  other companion call.
- **JSON turn:** add a `location` key to the body.
  **Multipart turn** (image/file attached): add a `location` form field whose value
  is `JSON.stringify(locationObject)`.
- Only `latitude` + `longitude` are required; everything else is best-effort.
- The response shape is **unchanged** — location doesn't alter the reply payload.

## The request

### JSON (text-only turn)
```jsonc
POST /api/assistant/turn
Authorization: Bearer <mobile token>
Content-Type: application/json

{
  "text": "where am I?",
  "agentSlug": "assistant",          // optional, as today
  "location": {
    "latitude": -33.92490,
    "longitude": 18.42410,
    "accuracy": 8.0,
    "altitude": 52.0,
    "altitudeAccuracy": 3.0,
    "speed": 1.4,
    "heading": 180.0,
    "battery": 0.84,
    "source": "fused",
    "timestamp": "2026-06-21T14:30:00.000Z",
    "isMock": false
  }
}
```

### Multipart (when sending an image/file)
Same as today (`text`, optional `agentSlug`, `image`/`file`), **plus** one field:
```
location = {"latitude":-33.9249,"longitude":18.4241,"accuracy":8,"timestamp":"2026-06-21T14:30:00.000Z"}
```
(i.e. the same object, JSON-encoded into a single form field named `location`.)

## The fields (`LocationPing`)

Canonical shape: `packages/content/src/location-ping.ts`. The server sanitizes
every ping — **malformed/out-of-range optional fields are dropped, never fatal**;
a ping is only rejected (ignored) if `latitude`/`longitude` are missing or out of
range. Send whatever the platform gives you.

| Field | Type | Unit | Required | Notes / accepted aliases |
|---|---|---|---|---|
| `latitude` | number | ° (−90..90) | **yes** | `lat` |
| `longitude` | number | ° (−180..180) | **yes** | `lon`, `lng` |
| `timestamp` | string\|number | ISO 8601 or epoch ms | no* | `time`, `ts`. *Defaults to server-now if absent/garbled — but send it. |
| `accuracy` | number | metres (horizontal radius) | no | `horizontalAccuracy`, `horizontal_accuracy`. Smaller = better. |
| `altitude` | number | metres ASL | no | `elevation` |
| `altitudeAccuracy` | number | metres | no | `altitude_accuracy`, `verticalAccuracy` |
| `speed` | number | m/s (≥0) | no | — |
| `heading` | number | ° (0..360) | no | `course`, `bearing` |
| `battery` | number | 0..1 fraction | no | `batteryLevel`, `battery_level`. A 0..100 value is auto-normalised. |
| `source` | enum | — | no | `provider`. One of `gps` \| `network` \| `fused` \| `other`. |
| `isMock` | boolean | — | no | `is_mock`, `mocked`. True = OS flagged the fix as simulated. |

Both `camelCase` and `snake_case` keys are accepted, so you can forward most
platform payloads with minimal remapping.

## Flutter mapping (geolocator + battery_plus)

`geolocator`'s `Position` maps almost 1:1:

```dart
final p = await Geolocator.getCurrentPosition();
final battery = await Battery().batteryLevel;   // battery_plus: 0..100

final location = {
  'latitude': p.latitude,
  'longitude': p.longitude,
  'accuracy': p.accuracy,                         // metres
  'altitude': p.altitude,
  'altitudeAccuracy': p.altitudeAccuracy,
  'speed': p.speed,                               // m/s
  'heading': p.heading,                           // degrees
  'battery': battery,                             // 0..100 → server normalises to 0..1
  'source': Platform.isAndroid ? 'fused' : 'gps', // geolocator gives no provider; pick sensibly
  'timestamp': p.timestamp.toUtc().toIso8601String(),
  'isMock': p.isMocked,
};
```

Then add `location` to the JSON body, or `jsonEncode(location)` as the `location`
multipart field.

## What the backend does with it

1. **Sanitises** the ping (`sanitizeLocationPing`) and **stores it on the inbound
   turn** — `assistant_messages.data = { location }`. So every located message
   carries its fix; the history is queryable.
2. **Injects a "Current location:" line** into the agent's per-turn context (next
   to the time line), with accuracy/altitude/speed and flags for low accuracy or
   `isMock`. The agent is location-aware on that turn.
3. **Lazy geocoding.** Only when an answer needs an address does the agent act:
   it checks saved places (`location_nearby`), else reverse-geocodes via **Mapbox**
   (`mapbox_reverse_geocode`), then caches the result as a **`location` node** so
   the next nearby turn is free. "How far is X?" uses `mapbox_search` +
   `location_distance` (haversine). This is taught by the `location_awareness`
   skill.

The agent always knows the raw coordinates from context; **address resolution +
nearby search require a Mapbox key** (Settings → API keys → service `mapbox`).
Until that key exists those tools are dormant — the agent will say it can't resolve
an address rather than guess.

## Behaviour the app should follow

- **Cadence:** the intended design is "location with every message post." That's
  fine cost-wise — geocoding is lazy, so frequent pings don't cost API calls. Send
  the freshest fix you have at send time.
- **Permissions & consent:** request *when-in-use* location; only attach `location`
  when the user has granted it and (ideally) opted in. Omit the field entirely when
  you have no permission/fix — the turn works exactly as before without it.
- **Freshness:** include `timestamp`. A stale fix is still useful (the agent caveats
  it), but don't hold a turn waiting for a perfect fix — send last-known if needed.
- **Quality signals help:** `accuracy`, `source`, and `isMock` let the agent decide
  how much to trust the fix. An emulator/dev build should set `isMock` honestly.
- **No retry coupling:** location is metadata on the turn; if you retry a turn
  (idempotency-key), resend the same `location`.

## Verify end-to-end

1. Prod must be **≥ 0.27.0** — it is (`GET /api/version`).
2. Add a `mapbox` key (Settings → API keys → Custom / other API → `mapbox`/`default`).
3. From the app (or curl with a mobile bearer), POST a turn with a real `location`
   and `text:"where am I?"` → the reply should name your address.
4. Confirm it persisted: the inbound `assistant_messages` row has
   `data.location`; a `location` node appears under the `locations` root after the
   first reverse-geocode, and a second turn at the same spot reuses it (no new
   node).

## References

- Wire schema + sanitizer + context line: `packages/content/src/location-ping.ts`
- Ingestion: `apps/web/app/api/assistant/turn/route.ts` → `apps/web/lib/assistant.ts`
- `location` node type + cache: `packages/content/src/locations.ts`
- Geo tools: `packages/tools/src/builtins-locations.ts` (+ seeded Mapbox HTTP tools)
- Agent skill: `location_awareness` (`apps/web/lib/system-manifest/prompts.ts`)
- Companion auth/route conventions: [`mobile-companion-backend.md`](./mobile-companion-backend.md)
- Why dev runs against this over the tailnet: [`split-ui-core.md`](./split-ui-core.md)
