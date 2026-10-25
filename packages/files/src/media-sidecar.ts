import { env, serviceEnabled } from '@mantle/config';
import { errorMessage, NET_TIMEOUTS, timeoutSignal } from '@mantle/std';

/**
 * Client for the media sidecar (infra/media-sidecar) — yt-dlp + ffmpeg behind
 * a narrow bearer-authed HTTP interface, compose profile `media`.
 *
 * Posture mirrors the sandboxd client, not Tika's never-throws: the caller is
 * the `video_ingest` TOOL, and the LLM needs to distinguish failure modes to
 * explain them ("no captions" vs "site broke" vs "too long"), so every call
 * returns a typed `MediaResult` with the sidecar's error code — it never
 * throws and never silently returns ''. That contract covers the WHOLE
 * exchange: body collection and JSON parsing are guarded too, and the abort
 * timer stays armed until the body is fully consumed, not just until headers
 * arrive. Unconfigured (no URL/token) is its own first-class state so the
 * tool can say "not enabled on this box".
 *
 * Wire contract: text headers (X-Media-Title) arrive percent-encoded as one
 * single-line ASCII token; numeric headers are plain digits. (RFC 2047 was
 * tried first — its folding produced multi-line headers undici rejects.)
 */

export type MediaErrorCode =
  | 'not_enabled'
  | 'unreachable'
  | 'unauthorized'
  | 'bad_request'
  | 'blocked_url'
  | 'no_captions'
  | 'extraction_failed'
  | 'duration_exceeded'
  | 'size_exceeded'
  | 'timeout'
  | 'busy';

export type MediaResult<T> =
  { ok: true; value: T } | { ok: false; code: MediaErrorCode; message: string };

export type MediaProbe = {
  title: string | null;
  durationSeconds: number | null;
  channel: string | null;
  uploadDate: string | null;
  extractor: string | null;
  isLive: boolean;
  captions: { manual: string[]; auto: string[] };
  filesizeApprox: number | null;
};

export type MediaCaptions = {
  source: 'manual' | 'auto';
  lang: string;
  content: string;
};

export type MediaBytes = {
  bytes: Buffer;
  durationSeconds: number | null;
  title: string | null;
};

// Mirror of the sidecar's per-op subprocess budgets (infra/media-sidecar/app.py).
const BACKSTOP_MS = 30_000;
const T_PROBE = 60_000 + BACKSTOP_MS;
const T_CAPTIONS = 120_000 + BACKSTOP_MS;
const T_AUDIO = 900_000 + BACKSTOP_MS;
const T_EXTRACT = 600_000 + BACKSTOP_MS;
const T_VIDEO = 1_500_000 + BACKSTOP_MS;

function config(): { url: string; token: string } | null {
  const url = env('MEDIA_SIDECAR_URL');
  const token = env('MEDIA_SIDECAR_TOKEN');
  // The profile, not just the token: a box that switched media off keeps its
  // token, and every box gets one pre-provisioned (@mantle/config services).
  if (!url || !token || !serviceEnabled('media')) return null;
  return { url: url.replace(/\/$/, ''), token };
}

/** True when the media service is switched on for this box (profile active
 *  + URL and token set). Says nothing about whether it answers. */
export function mediaSidecarEnabled(): boolean {
  return config() != null;
}

const NOT_ENABLED: MediaResult<never> = {
  ok: false,
  code: 'not_enabled',
  message:
    'Media ingestion is not enabled on this box (the `media` service is switched off). An admin can switch Media on in Settings > Services (see docs/video-ingest.md).',
};

/** Sidecar text headers are percent-encoded single-line ASCII. */
function decodeHeader(raw: string | null): string | null {
  if (!raw) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function asFailure(err: unknown, timeoutMs: number): MediaResult<never> {
  // The deadline (timeoutSignal) raises a TimeoutError; a bare abort, AbortError.
  const aborted =
    err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');
  return {
    ok: false,
    code: aborted ? 'timeout' : 'unreachable',
    message: aborted
      ? `media sidecar did not answer within ${Math.round(timeoutMs / 1000)}s`
      : `media sidecar unreachable: ${errorMessage(err)}`,
  };
}

/** Parse a non-2xx envelope into the typed result; tolerate junk bodies. */
async function envelopeError(res: Response): Promise<MediaResult<never>> {
  let code: MediaErrorCode = 'extraction_failed';
  let message = `media sidecar answered ${res.status}`;
  try {
    const body = (await res.json()) as { error?: { code?: string; message?: string } };
    if (body?.error?.code) code = body.error.code as MediaErrorCode;
    if (body?.error?.message) message = body.error.message;
  } catch {
    /* keep the status-line fallback */
  }
  return { ok: false, code, message };
}

/**
 * One full exchange: fetch + status check + `consume` (json parse or byte
 * collection), all under ONE abort timer that is cleared only after the body
 * has been consumed — a stalled body times out instead of hanging forever.
 * Any throw anywhere becomes a typed failure; this function upholds the
 * module's never-throws contract by construction.
 */
async function exchange<T>(
  path: string,
  init: RequestInit,
  timeoutMs: number,
  consume: (res: Response) => Promise<MediaResult<T>>,
): Promise<MediaResult<T>> {
  const cfg = config();
  if (!cfg) return NOT_ENABLED;
  const signal = timeoutSignal(timeoutMs);
  try {
    const res = await fetch(`${cfg.url}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${cfg.token}`,
        ...(init.headers ?? {}),
      },
      signal,
    });
    if (!res.ok) return await envelopeError(res);
    return await consume(res);
  } catch (err) {
    return asFailure(err, timeoutMs);
  }
}

/** Byte-counted body collection — defence in depth over the sidecar's caps. */
async function collectBytes(res: Response, maxBytes: number): Promise<MediaResult<Buffer>> {
  const reader = res.body?.getReader();
  if (!reader) return { ok: false, code: 'extraction_failed', message: 'empty response body' };
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return {
        ok: false,
        code: 'size_exceeded',
        message: `response exceeded the ${maxBytes}-byte cap`,
      };
    }
    chunks.push(Buffer.from(value));
  }
  return { ok: true, value: Buffer.concat(chunks) };
}

async function consumeJson<T>(
  res: Response,
  map: (body: Record<string, unknown>) => MediaResult<T>,
): Promise<MediaResult<T>> {
  let body: Record<string, unknown>;
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    return { ok: false, code: 'extraction_failed', message: 'sidecar returned non-JSON on a 200' };
  }
  return map(body);
}

function consumeMedia(maxBytes: number) {
  return async (res: Response): Promise<MediaResult<MediaBytes>> => {
    const bytes = await collectBytes(res, maxBytes);
    if (!bytes.ok) return bytes;
    const dur = res.headers.get('x-media-duration-seconds');
    const parsed = dur == null ? NaN : Number(dur);
    return {
      ok: true,
      value: {
        bytes: bytes.value,
        durationSeconds: Number.isFinite(parsed) ? parsed : null,
        title: decodeHeader(res.headers.get('x-media-title')),
      },
    };
  };
}

const JSON_HEADERS = { 'Content-Type': 'application/json' };

/** /healthz — never-throws, `up: null` when unconfigured (system-health shape). */
export async function mediaSidecarHealth(timeoutMs: number = NET_TIMEOUTS.localProbe): Promise<{
  up: boolean | null;
  ytDlpVersion: string | null;
  ffmpegVersion: string | null;
  /** null on images built before the CAD tier (v0.232.92) — the signal that
   *  DWF renders will fail and thumbnails are all this box can produce. */
  ezdwfVersion: string | null;
  /** null on images built before the DWG tier (v0.232.99) — DWG parsing and
   *  rendering both need the sidecar, so absence means the whole format. */
  dwg2dxfVersion: string | null;
  ezdxfVersion: string | null;
}> {
  const down = {
    ytDlpVersion: null,
    ffmpegVersion: null,
    ezdwfVersion: null,
    dwg2dxfVersion: null,
    ezdxfVersion: null,
  };
  const cfg = config();
  if (!cfg) return { up: null, ...down };
  try {
    const res = await fetch(`${cfg.url}/healthz`, { signal: timeoutSignal(timeoutMs) });
    if (!res.ok) return { up: false, ...down };
    const body = (await res.json()) as {
      ok?: boolean;
      versions?: {
        yt_dlp?: string;
        ffmpeg?: string;
        ezdwf?: string;
        dwg2dxf?: string;
        ezdxf?: string;
      };
    };
    return {
      // A tokenless sidecar serves /healthz with ok:false — configured but
      // unusable is DOWN, not up.
      up: body.ok !== false,
      ytDlpVersion: body.versions?.yt_dlp ?? null,
      ffmpegVersion: body.versions?.ffmpeg ?? null,
      ezdwfVersion: body.versions?.ezdwf ?? null,
      dwg2dxfVersion: body.versions?.dwg2dxf ?? null,
      ezdxfVersion: body.versions?.ezdxf ?? null,
    };
  } catch {
    return { up: false, ...down };
  }
}

export async function mediaProbe(url: string): Promise<MediaResult<MediaProbe>> {
  return exchange(
    '/probe',
    { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ url }) },
    T_PROBE,
    (res) =>
      consumeJson(res, (body) => ({
        ok: true,
        value: {
          title: typeof body.title === 'string' ? body.title : null,
          durationSeconds: typeof body.durationSeconds === 'number' ? body.durationSeconds : null,
          channel: typeof body.channel === 'string' ? body.channel : null,
          uploadDate: typeof body.uploadDate === 'string' ? body.uploadDate : null,
          extractor: typeof body.extractor === 'string' ? body.extractor : null,
          isLive: body.isLive === true,
          captions: {
            manual: Array.isArray((body.captions as Record<string, unknown>)?.manual)
              ? ((body.captions as Record<string, unknown>).manual as string[])
              : [],
            auto: Array.isArray((body.captions as Record<string, unknown>)?.auto)
              ? ((body.captions as Record<string, unknown>).auto as string[])
              : [],
          },
          filesizeApprox: typeof body.filesizeApprox === 'number' ? body.filesizeApprox : null,
        },
      })),
  );
}

export async function mediaCaptions(
  url: string,
  opts?: { lang?: string; prefer?: 'manual' | 'auto' | 'any' },
): Promise<MediaResult<MediaCaptions>> {
  return exchange(
    '/captions',
    {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ url, lang: opts?.lang, prefer: opts?.prefer ?? 'any' }),
    },
    T_CAPTIONS,
    (res) =>
      consumeJson(res, (body) => {
        if (typeof body.content !== 'string' || !body.content.trim()) {
          return {
            ok: false,
            code: 'no_captions',
            message: 'sidecar returned an empty caption track',
          };
        }
        return {
          ok: true,
          value: {
            source: body.source === 'manual' ? 'manual' : 'auto',
            lang: typeof body.lang === 'string' ? body.lang : 'unknown',
            content: body.content,
          },
        };
      }),
  );
}

export async function mediaAudio(
  url: string,
  opts: { maxDurationSeconds: number; maxBytes: number },
): Promise<MediaResult<MediaBytes>> {
  return exchange(
    '/audio',
    {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({
        url,
        maxDurationSeconds: opts.maxDurationSeconds,
        maxBytes: opts.maxBytes,
      }),
    },
    T_AUDIO,
    consumeMedia(opts.maxBytes),
  );
}

export async function mediaExtractAudio(
  video: Buffer,
  opts: { maxDurationSeconds: number; maxAudioBytes: number },
): Promise<MediaResult<MediaBytes>> {
  return exchange(
    '/extract-audio',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Media-Max-Duration-Seconds': String(opts.maxDurationSeconds),
        // Sent so the SIDECAR refuses an over-cap transcode before doing it —
        // the client-side collect cap alone would pay the full ffmpeg run
        // and transfer first.
        'X-Media-Max-Audio-Bytes': String(opts.maxAudioBytes),
      },
      // The Buffer itself — wrapping in `new Uint8Array(video)` would COPY
      // the whole video a second time (Buffer is already a Uint8Array view).
      body: video as unknown as BodyInit,
    },
    T_EXTRACT,
    consumeMedia(opts.maxAudioBytes),
  );
}

export async function mediaVideo(
  url: string,
  opts: { maxBytes: number },
): Promise<MediaResult<MediaBytes>> {
  return exchange(
    '/video',
    {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ url, maxBytes: opts.maxBytes }),
    },
    T_VIDEO,
    consumeMedia(opts.maxBytes),
  );
}

// ── CAD: DWF sheet rendering ──────────────────────────────────────────

export type DwfSheetRender = {
  /** Sheet title as published ("90-10-01 Rev 2" style). */
  name: string;
  /** The sheet's true index in the plot set (failed sheets leave gaps). */
  index: number;
  png: Buffer;
};

export type DwfRender = {
  /** How many 2D sheets the container holds. */
  sheetCount: number;
  /** Sheets that errored in the render worker (counted, never renamed over). */
  skipped: number;
  /** A sheet-count or payload cap bit. */
  capped: boolean;
  /** Anything at all is missing from `sheets` — cap, error, or otherwise.
   *  Callers with a complete fallback (the embedded thumbnails) should treat
   *  a truncated set as a miss rather than silently shipping fewer sheets. */
  truncated: boolean;
  sheets: DwfSheetRender[];
};

// Mirror of TIMEOUT_DWF_RENDER in app.py — the render runs in a group-killed
// child over there, so this budget is a real server-side bound, not hope.
const T_DWF_RENDER = 120_000 + BACKSTOP_MS;
/** Wire ceiling: the sidecar caps raw PNGs at 48 MB, ~64 MB as base64 plus
 *  envelope. Enforced WHILE STREAMING via collectBytes — never after a bare
 *  res.json() has already materialised an unbounded body. */
const DWF_WIRE_MAX_BYTES = 80 * 1024 * 1024;
/** Decoded-bytes ceiling, matching the sidecar's raw cap so it can actually
 *  fire against a misbehaving sidecar. */
const DWF_RENDER_MAX_BYTES = 48 * 1024 * 1024;

/** Process-lifetime memo of whether the sidecar image carries ezdwf. An image
 *  built before the CAD tier answers 422 on every render — without the memo,
 *  every DWF ingest would pay a full-file upload for a guaranteed failure,
 *  forever. Transient states (sidecar down) are deliberately NOT cached. */
let dwfTier: 'unknown' | 'present' | 'absent' = 'unknown';
/** Same memo for the DWG tier (dwg2dxf + ezdxf, v0.232.99 images). */
let dwgTier: 'unknown' | 'present' | 'absent' = 'unknown';

/**
 * Raster every sheet of an Autodesk DWF plot set via the sidecar's ezdwf
 * (`POST /dwf/render`). Same never-throws contract as the media ops; callers
 * that can fall back (the embedded-thumbnail path) treat any failure as
 * "use the fallback", so every code path must come back typed.
 */
export async function mediaDwfRender(
  dwf: Buffer,
  opts?: { dpi?: number; maxSheets?: number },
): Promise<MediaResult<DwfRender>> {
  if (dwfTier === 'unknown') {
    const health = await mediaSidecarHealth();
    if (health.up && !health.ezdwfVersion) dwfTier = 'absent';
    else if (health.up) dwfTier = 'present';
    // Not up: leave 'unknown' — the render call below will fail typed anyway.
  }
  if (dwfTier === 'absent') {
    return {
      ok: false,
      code: 'extraction_failed',
      message:
        'the media sidecar image predates the CAD tier (no ezdwf on /healthz) — update the mantle-media image to v0.232.92+',
    };
  }
  return exchange(
    '/dwf/render',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        ...(opts?.dpi ? { 'X-Dwf-Dpi': String(opts.dpi) } : {}),
        ...(opts?.maxSheets ? { 'X-Dwf-Max-Sheets': String(opts.maxSheets) } : {}),
      },
      body: dwf as unknown as BodyInit,
    },
    T_DWF_RENDER,
    async (res) => {
      const raw = await collectBytes(res, DWF_WIRE_MAX_BYTES);
      if (!raw.ok) return raw;
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(raw.value.toString('utf8')) as Record<string, unknown>;
      } catch {
        return {
          ok: false,
          code: 'extraction_failed',
          message: 'sidecar returned non-JSON on a 200',
        };
      }
      const rawSheets = Array.isArray(body.sheets) ? body.sheets : null;
      if (!rawSheets) {
        return { ok: false, code: 'extraction_failed', message: 'render reply has no sheets' };
      }
      const sheets: DwfSheetRender[] = [];
      let total = 0;
      for (const rawSheet of rawSheets) {
        const s = rawSheet as Record<string, unknown>;
        if (typeof s.png_base64 !== 'string') continue;
        const png = Buffer.from(s.png_base64, 'base64');
        total += png.length;
        if (total > DWF_RENDER_MAX_BYTES) {
          return {
            ok: false,
            code: 'size_exceeded',
            message: `decoded renders exceeded the ${DWF_RENDER_MAX_BYTES}-byte cap`,
          };
        }
        sheets.push({
          name: typeof s.name === 'string' && s.name ? s.name : `sheet ${sheets.length + 1}`,
          index: typeof s.index === 'number' ? s.index : sheets.length,
          png,
        });
      }
      dwfTier = 'present';
      return {
        ok: true,
        value: {
          sheetCount: typeof body.sheet_count === 'number' ? body.sheet_count : sheets.length,
          skipped: typeof body.skipped === 'number' ? body.skipped : 0,
          capped: body.capped === true,
          truncated: body.truncated === true,
          sheets,
        },
      };
    },
  );
}

// ── CAD: DWG parse + render ───────────────────────────────────────────

export type DwgTextEntity = {
  text: string;
  layer: string;
  x: number | null;
  y: number | null;
};

/** One INSERT that carries attributes, its ATTRIB values keyed by TAG. On
 *  circuitized P&IDs a `LineNumber` block holds `LINENO` and `CIRCUIT` side
 *  by side; this record is the only place that pairing survives. */
export type DwgBlockEntity = {
  block: string;
  layer: string;
  handle: string;
  x: number | null;
  y: number | null;
  attribs: Record<string, string>;
};

/** One straight piece of pipe geometry: a LINE, one vertex pair of a
 *  polyline, or an ARC, by its end points (a curve's are its chord; length
 *  is the true arc length). A segment split by a tee comes as two pieces with
 *  the same handle and part. n1/n2 are node ids, run the connected run. */
export type DwgSegment = {
  layer: string;
  handle: string;
  type: string;
  part: number;
  x1: number | null;
  y1: number | null;
  x2: number | null;
  y2: number | null;
  length: number | null;
  n1: number | null;
  n2: number | null;
  run: number | null;
};

/** A point where segment ends meet (snapped within the reply's tolerance).
 *  kind: end (degree 1), joint (2), tee (3+), block (an end joined to
 *  another through a small insert, such as a valve). */
export type DwgNode = {
  id: number;
  x: number | null;
  y: number | null;
  degree: number;
  kind: string;
  block: string;
  blockHandle: string;
  layers: string;
};

/** Every INSERT, attributes or not, with its block's box in model space. */
export type DwgInsert = {
  block: string;
  layer: string;
  handle: string;
  x: number | null;
  y: number | null;
  rotation: number | null;
  scaleX: number | null;
  scaleY: number | null;
  minX: number | null;
  minY: number | null;
  maxX: number | null;
  maxY: number | null;
  attribs: number;
};

/** One circuit from `Circuit <name>` layers (deadlegs folded in). */
export type DwgCircuit = {
  circuit: string;
  parent: string;
  kind: string;
  layers: string;
  entities: number;
  segments: number;
  length: number | null;
  deadlegSegments: number;
  deadlegLength: number | null;
  runs: number;
  tees: number;
  ends: number;
  endPoints: string;
  lineNumbers: string;
  nearbyText: string;
};

/** How the network was built, for the table description and the digest. */
export type DwgGeometry = {
  snapTolerance: number | null;
  nearDistance: number | null;
  extentDiagonal: number | null;
  /** Sheets tiled in one model space; above 1 each sheet scales its own
   *  tolerances and snapTolerance is the largest sheet's. */
  sheets: number;
  segments: number;
  nodes: number;
  nodeKinds: Record<string, number>;
  inserts: number;
  runs: number;
  circuits: number;
  /** Curves not turned into segments (SPLINE, ELLIPSE, MLINE) and entities
   *  that could not be read, by type. */
  skipped: Record<string, number>;
};

export type DwgRender = {
  /** Which converter produced the DXF the registry and render came from —
   *  'none' when the upload already WAS a DXF and ezdxf read it natively. */
  converter: 'dwg2dxf' | 'ezdwg' | 'none';
  /** DXF version of the converted document ("AC1027"). */
  version: string | null;
  /** Model-space entity total. */
  entities: number;
  /** A registry cap bit (texts or layers hit their ceiling). */
  capped: boolean;
  /** The blocks list hit its ceiling; separate so it never reads as Texts
   *  being truncated. */
  blocksCapped: boolean;
  layers: Array<{ name: string; count: number }>;
  texts: DwgTextEntity[];
  /** Attribute-bearing INSERTs; empty from a sidecar image older than the
   *  blocks field (the reply simply lacks it). */
  blocks: DwgBlockEntity[];
  counts: Record<string, number>;
  /** The bones (since the dwg-bones sidecar): empty, and `geometry` null,
   *  from an older image. Each list has its own cap bit. */
  segments: DwgSegment[];
  nodes: DwgNode[];
  inserts: DwgInsert[];
  circuits: DwgCircuit[];
  geometry: DwgGeometry | null;
  segmentsCapped: boolean;
  nodesCapped: boolean;
  insertsCapped: boolean;
  circuitsCapped: boolean;
  /** Why the geometry is missing when the registry is not. */
  geometryError: string | null;
  /** Model-space raster; null when the render step failed (registry-only). */
  png: Buffer | null;
  /** Why the render step failed, when it did — the reply is still ok:true
   *  (the registry shipped), but the missing image is explainable. */
  renderError: string | null;
  /** Set when the PIXELS came from a different converter than the registry:
   *  dwg2dxf's DXF can parse yet miss block definitions the renderer needs,
   *  and the worker then retries the render once from ezdwg's DXF. */
  renderConverter: 'ezdwg' | null;
};

// Mirror of TIMEOUT_DWG_RENDER in app.py, same +30s backstop convention.
const T_DWG_RENDER = 240_000 + BACKSTOP_MS;
/** Wire ceiling: one PNG (≤48 MB raw → ~64 MB base64) plus a few MB of
 *  registry JSON. Enforced while streaming, like the DWF route. */
const DWG_WIRE_MAX_BYTES = 80 * 1024 * 1024;
const DWG_PNG_MAX_BYTES = 48 * 1024 * 1024;
const DWG_TEXTS_MAX = 20_000;
const DWG_BLOCKS_MAX = 20_000;
/** Ceilings on the bones lists; the sidecar's character budgets bind first
 *  on any real drawing (a large P&ID is a few thousand segments). */
const DWG_SEGMENTS_MAX = 60_000;
const DWG_NODES_MAX = 60_000;
const DWG_INSERTS_MAX = 40_000;
const DWG_CIRCUITS_MAX = 5_000;

/** A finite number or null: the reply never carries NaN, but be sure. */
function finite(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
function text(v: unknown): string {
  return typeof v === 'string' ? v : '';
}
function count(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}
function tally(v: unknown): Record<string, number> {
  const out: Record<string, number> = Object.create(null) as Record<string, number>;
  if (v && typeof v === 'object') {
    for (const [k, n] of Object.entries(v as Record<string, unknown>)) {
      if (typeof n === 'number' && Number.isFinite(n)) out[k] = n;
    }
  }
  return out;
}

/** Read one list of the reply into typed rows, capped at `max`. */
function readList<T>(
  raw: unknown,
  max: number,
  read: (r: Record<string, unknown>) => T | null,
): { rows: T[]; cut: boolean } {
  const list = Array.isArray(raw) ? raw : [];
  const rows: T[] = [];
  for (const item of list) {
    if (rows.length >= max) return { rows, cut: true };
    if (!item || typeof item !== 'object') continue;
    const row = read(item as Record<string, unknown>);
    if (row) rows.push(row);
  }
  return { rows, cut: false };
}

function readBones(body: Record<string, unknown>) {
  const segments = readList<DwgSegment>(body.segments, DWG_SEGMENTS_MAX, (r) => ({
    layer: text(r.layer),
    handle: text(r.handle),
    type: text(r.type),
    part: count(r.part),
    x1: finite(r.x1),
    y1: finite(r.y1),
    x2: finite(r.x2),
    y2: finite(r.y2),
    length: finite(r.length),
    n1: finite(r.n1),
    n2: finite(r.n2),
    run: finite(r.run),
  }));
  const nodes = readList<DwgNode>(body.nodes, DWG_NODES_MAX, (r) =>
    typeof r.id === 'number'
      ? {
          id: r.id,
          x: finite(r.x),
          y: finite(r.y),
          degree: count(r.degree),
          kind: text(r.kind),
          block: text(r.block),
          blockHandle: text(r.block_handle),
          layers: text(r.layers),
        }
      : null,
  );
  const inserts = readList<DwgInsert>(body.inserts, DWG_INSERTS_MAX, (r) => ({
    block: text(r.block),
    layer: text(r.layer),
    handle: text(r.handle),
    x: finite(r.x),
    y: finite(r.y),
    rotation: finite(r.rotation),
    scaleX: finite(r.sx),
    scaleY: finite(r.sy),
    minX: finite(r.minx),
    minY: finite(r.miny),
    maxX: finite(r.maxx),
    maxY: finite(r.maxy),
    attribs: count(r.attribs),
  }));
  const circuits = readList<DwgCircuit>(body.circuits, DWG_CIRCUITS_MAX, (r) =>
    typeof r.circuit === 'string' && r.circuit
      ? {
          circuit: r.circuit,
          parent: text(r.parent),
          kind: text(r.kind),
          layers: text(r.layers),
          entities: count(r.entities),
          segments: count(r.segments),
          length: finite(r.length),
          deadlegSegments: count(r.deadleg_segments),
          deadlegLength: finite(r.deadleg_length),
          runs: count(r.runs),
          tees: count(r.tees),
          ends: count(r.ends),
          endPoints: text(r.end_points),
          lineNumbers: text(r.line_numbers),
          nearbyText: text(r.nearby_text),
        }
      : null,
  );
  const g =
    body.geometry && typeof body.geometry === 'object'
      ? (body.geometry as Record<string, unknown>)
      : null;
  const geometry: DwgGeometry | null = g
    ? {
        snapTolerance: finite(g.snap_tolerance),
        nearDistance: finite(g.near_distance),
        extentDiagonal: finite(g.extent_diagonal),
        sheets: count(g.sheets),
        segments: count(g.segments),
        nodes: count(g.nodes),
        nodeKinds: tally(g.node_kinds),
        inserts: count(g.inserts),
        runs: count(g.runs),
        circuits: count(g.circuits),
        skipped: tally(g.skipped),
      }
    : null;
  return {
    segments: segments.rows,
    nodes: nodes.rows,
    inserts: inserts.rows,
    circuits: circuits.rows,
    geometry,
    segmentsCapped: body.segments_capped === true || segments.cut,
    nodesCapped: body.nodes_capped === true || nodes.cut,
    insertsCapped: body.inserts_capped === true || inserts.cut,
    circuitsCapped: body.circuits_capped === true || circuits.cut,
    geometryError:
      typeof body.geometry_error === 'string' && body.geometry_error ? body.geometry_error : null,
  };
}

/**
 * Parse AND raster an AutoCAD drawing's model space via the sidecar
 * (`POST /dwg/render`). The route takes DWG *or* DXF bytes — the worker
 * sniffs: DWG magic runs the converter chain, anything else is read as
 * native DXF (converter 'none'). One exchange serves the text digest, the
 * registry workbook, and the image pass — these are the routed formats the
 * app process cannot parse locally, so unlike DWF there is no offline
 * fallback tier behind this call. Never throws; same contract as the rest.
 */
export async function mediaDwgRender(
  dwg: Buffer,
  opts?: { dpi?: number },
): Promise<MediaResult<DwgRender>> {
  if (dwgTier === 'unknown') {
    const health = await mediaSidecarHealth();
    if (health.up && !health.ezdxfVersion) dwgTier = 'absent';
    else if (health.up) dwgTier = 'present';
  }
  if (dwgTier === 'absent') {
    return {
      ok: false,
      code: 'extraction_failed',
      message:
        'the media sidecar image predates the DWG tier (no ezdxf on /healthz) — update the mantle-media image to v0.232.99+',
    };
  }
  return exchange(
    '/dwg/render',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        ...(opts?.dpi ? { 'X-Dwg-Dpi': String(opts.dpi) } : {}),
      },
      body: dwg as unknown as BodyInit,
    },
    T_DWG_RENDER,
    async (res) => {
      const raw = await collectBytes(res, DWG_WIRE_MAX_BYTES);
      if (!raw.ok) return raw;
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(raw.value.toString('utf8')) as Record<string, unknown>;
      } catch {
        return {
          ok: false,
          code: 'extraction_failed',
          message: 'sidecar returned non-JSON on a 200',
        };
      }
      let png: Buffer | null = null;
      if (typeof body.png_base64 === 'string' && body.png_base64) {
        png = Buffer.from(body.png_base64, 'base64');
        if (png.length > DWG_PNG_MAX_BYTES) {
          return {
            ok: false,
            code: 'size_exceeded',
            message: `decoded render exceeded the ${DWG_PNG_MAX_BYTES}-byte cap`,
          };
        }
      }
      const texts: DwgTextEntity[] = [];
      for (const rawText of Array.isArray(body.texts) ? body.texts : []) {
        if (texts.length >= DWG_TEXTS_MAX) break;
        const t = rawText as Record<string, unknown>;
        if (typeof t.text !== 'string' || !t.text) continue;
        texts.push({
          text: t.text,
          layer: typeof t.layer === 'string' ? t.layer : '',
          x: typeof t.x === 'number' ? t.x : null,
          y: typeof t.y === 'number' ? t.y : null,
        });
      }
      const blocks: DwgBlockEntity[] = [];
      for (const rawBlock of Array.isArray(body.blocks) ? body.blocks : []) {
        if (blocks.length >= DWG_BLOCKS_MAX) break;
        const b = rawBlock as Record<string, unknown>;
        if (!b.attribs || typeof b.attribs !== 'object') continue;
        // No prototype: a tag named `constructor` or `__proto__` is just a tag.
        const attribs: Record<string, string> = Object.create(null) as Record<string, string>;
        for (const [tag, value] of Object.entries(b.attribs as Record<string, unknown>)) {
          if (tag && typeof value === 'string') attribs[tag] = value;
        }
        if (!Object.values(attribs).some(Boolean)) continue;
        blocks.push({
          block: typeof b.block === 'string' ? b.block : '',
          layer: typeof b.layer === 'string' ? b.layer : '',
          handle: typeof b.handle === 'string' ? b.handle : '',
          x: typeof b.x === 'number' ? b.x : null,
          y: typeof b.y === 'number' ? b.y : null,
          attribs,
        });
      }
      const layers: Array<{ name: string; count: number }> = [];
      for (const rawLayer of Array.isArray(body.layers) ? body.layers : []) {
        const l = rawLayer as Record<string, unknown>;
        if (typeof l.name !== 'string') continue;
        layers.push({ name: l.name, count: typeof l.count === 'number' ? l.count : 0 });
      }
      const counts: Record<string, number> = {};
      if (body.counts && typeof body.counts === 'object') {
        for (const [k, v] of Object.entries(body.counts as Record<string, unknown>)) {
          if (typeof v === 'number') counts[k] = v;
        }
      }
      dwgTier = 'present';
      return {
        ok: true,
        value: {
          converter:
            body.converter === 'ezdwg' ? 'ezdwg' : body.converter === 'none' ? 'none' : 'dwg2dxf',
          version: typeof body.version === 'string' ? body.version : null,
          entities: typeof body.entities === 'number' ? body.entities : 0,
          capped: body.capped === true,
          blocksCapped: body.blocks_capped === true,
          layers,
          texts,
          blocks,
          counts,
          ...readBones(body),
          png,
          renderError:
            typeof body.render_error === 'string' && body.render_error ? body.render_error : null,
          renderConverter: body.render_converter === 'ezdwg' ? 'ezdwg' : null,
        },
      };
    },
  );
}
