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
  const url = process.env.MEDIA_SIDECAR_URL;
  const token = process.env.MEDIA_SIDECAR_TOKEN;
  if (!url || !token) return null;
  return { url: url.replace(/\/$/, ''), token };
}

/** True when this box has the sidecar configured (profile on + token set). */
export function mediaSidecarEnabled(): boolean {
  return config() != null;
}

const NOT_ENABLED: MediaResult<never> = {
  ok: false,
  code: 'not_enabled',
  message:
    'Media ingestion is not enabled on this box. It needs the `media` compose profile plus MEDIA_SIDECAR_TOKEN (see docs/video-ingest.md).',
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
  const aborted = err instanceof Error && err.name === 'AbortError';
  return {
    ok: false,
    code: aborted ? 'timeout' : 'unreachable',
    message: aborted
      ? `media sidecar did not answer within ${Math.round(timeoutMs / 1000)}s`
      : `media sidecar unreachable: ${err instanceof Error ? err.message : String(err)}`,
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
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${cfg.url}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${cfg.token}`,
        ...(init.headers ?? {}),
      },
      signal: ctrl.signal,
    });
    if (!res.ok) return await envelopeError(res);
    return await consume(res);
  } catch (err) {
    return asFailure(err, timeoutMs);
  } finally {
    clearTimeout(timer);
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
export async function mediaSidecarHealth(timeoutMs = 1_500): Promise<{
  up: boolean | null;
  ytDlpVersion: string | null;
  ffmpegVersion: string | null;
  /** null on images built before the CAD tier (v0.232.92) — the signal that
   *  DWF renders will fail and thumbnails are all this box can produce. */
  ezdwfVersion: string | null;
}> {
  const cfg = config();
  if (!cfg) return { up: null, ytDlpVersion: null, ffmpegVersion: null, ezdwfVersion: null };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${cfg.url}/healthz`, { signal: ctrl.signal });
    if (!res.ok) return { up: false, ytDlpVersion: null, ffmpegVersion: null, ezdwfVersion: null };
    const body = (await res.json()) as {
      ok?: boolean;
      versions?: { yt_dlp?: string; ffmpeg?: string; ezdwf?: string };
    };
    return {
      // A tokenless sidecar serves /healthz with ok:false — configured but
      // unusable is DOWN, not up.
      up: body.ok !== false,
      ytDlpVersion: body.versions?.yt_dlp ?? null,
      ffmpegVersion: body.versions?.ffmpeg ?? null,
      ezdwfVersion: body.versions?.ezdwf ?? null,
    };
  } catch {
    return { up: false, ytDlpVersion: null, ffmpegVersion: null, ezdwfVersion: null };
  } finally {
    clearTimeout(timer);
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
