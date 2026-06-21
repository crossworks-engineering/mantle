# Handover — Navigation (routes + inline maps)

_Written 2026-06-21 · lands in the next release. Builds directly on
[Location](./handover-companion-location.md)._

The assistant can now answer "where's the nearest coffee shop and how do I get
there?" — it finds the place, **finds a route**, **plots it on a map shown inline
in chat**, and gives a short driving/walking **overview** (distance + time + a few
key turns). It is deliberately **not** live turn-by-turn navigation.

## TL;DR for the Companion app

- **Nothing to build.** No new endpoint, no new request fields, no new render
  code. Keep attaching `location` to `POST /api/assistant/turn` exactly as the
  [Location handover](./handover-companion-location.md) describes.
- The map arrives as an ordinary **image artifact** on the turn response
  (`artifacts[]`, `kind: "image"`, a PNG in `base64`) — the same channel a
  generated image or a TTS voice note already uses. The companion already writes
  image artifacts to a temp file and renders them inline
  (`_attachmentsFromArtifacts` → `Image.file`). A route map is just another image.
- Same for the web `/assistant` — the PNG renders via the existing `ArtifactView`.

## Why this shape (no SDKs, API-only, provider-swappable)

This mirrors the Location split exactly:

| Piece | Kind | Why |
|---|---|---|
| `mapbox_directions` | **Declarative HTTP tool** (API console) | Provider-swappable like `mapbox_reverse_geocode`/`_search`. Returns route JSON: distance, duration, encoded polyline, maneuver steps. |
| `route_map` | **Builtin** (`packages/tools/src/builtins-locations.ts`) | HTTP tools return JSON; they can't carry a binary PNG into the artifact channel. So the image is a builtin (like `generate_image`): it calls the **Static Images API** server-side and emits the PNG as an artifact. |
| `navigation` | **Skill** | Orchestrates the lazy loop. Attached to the `assistant` persona alongside `location_awareness`. |

No map SDK on either surface — the map is a static PNG, so there's no
`mapbox-gl-js` (web) or Flutter map plugin to bundle. Interactive pan/zoom is
explicitly out of scope.

## What happens on a turn

1. **Origin** = the device's Current location (already injected into the turn
   context from the `location` you send). No location → the agent asks or uses a
   saved place; it won't invent one. Mock/low-accuracy/stale fixes are caveated
   per `location_awareness`.
2. **Destination** — for a named place/category the agent calls `mapbox_search`
   (proximity-biased to the current location) and takes the best match's centre.
3. **Profile** — `driving` (default) or `walking`, chosen from the wording.
4. **Route** — `mapbox_directions(profile, from, to)` → distance, duration,
   `geometry` (an encoded polyline, precision 5), and step instructions.
5. **Plot** — `route_map(polyline, from/to)` builds a Static Images URL
   (`path-…(polyline)` + start/end pins, `auto` viewport), **fetches it
   server-side with the vault key**, and returns the PNG as an image artifact.
6. **Overview** — the agent writes a short human summary (≈X km, ≈Y min, a few
   key turns) and notes it's an overview, not live navigation.

## Security / cost notes

- **The Mapbox key never reaches the client.** `route_map` fetches the static
  image server-side and ships only the rendered PNG bytes; no token appears in any
  URL the app or browser sees. (The geocoding/directions HTTP tools likewise
  resolve the key from the encrypted vault at dispatch time.)
- **Lazy + cheap.** A static map is one request only when a route is actually
  drawn. Directions use `overview=simplified&geometries=polyline` so the response
  is small (well under the 32 KB inline cap) and the polyline fits the Static
  Images URL (8 KB cap; `route_map` falls back to start/end pins if a route is too
  long to encode).
- **Dormant until keyed.** Everything needs a Mapbox key (Settings → API keys,
  service `mapbox`, label `default`). Without it the tools report they can't map
  the route rather than guessing. One default public token covers geocoding,
  directions, and `styles:tiles` (static images).

## Other surfaces

On **Telegram / voice** there's no inline image — the agent skips `route_map`
(or notes the map isn't shown) and gives the overview in words; on voice it stays
plain and spoken. (`navigation` skill enforces this.)

## Verify end-to-end

1. Add a `mapbox` key (Settings → API keys → service `mapbox`, label `default`).
2. From the app (or curl with a mobile bearer), POST a turn with a real
   `location` and `text:"nearest coffee shop — how do I get there?"`.
3. The reply should name the place, include a **map image** (the artifact), and a
   short "≈X km, ≈Y min by car, head … then …" overview.
4. Confirm the companion renders the artifact inline (it writes
   `artifact-*.png` to its temp dir and shows it like any image).

## References

- Directions HTTP tool + skill registration: `apps/web/lib/system-manifest/manifest.ts`
- `route_map` builtin (Static Images → image artifact): `packages/tools/src/builtins-locations.ts`
- `navigation` skill body: `apps/web/lib/system-manifest/prompts.ts`
- Artifact channel (how tools emit inline media): `packages/tools/src/types.ts` (`ToolArtifact`)
- Companion artifact rendering: `mantle-companion/lib/data/chat/chat_api.dart` (`_attachmentsFromArtifacts`)
- Location foundation this builds on: [`handover-companion-location.md`](./handover-companion-location.md)
- Backfill onto an existing brain: `pnpm -C apps/web seed:location`
