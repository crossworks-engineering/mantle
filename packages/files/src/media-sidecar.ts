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
}> {
  const cfg = config();
  if (!cfg) return { up: null, ytDlpVersion: null, ffmpegVersion: null };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${cfg.url}/healthz`, { signal: ctrl.signal });
    if (!res.ok) return { up: false, ytDlpVersion: null, ffmpegVersion: null };
    const body = (await res.json()) as {
      ok?: boolean;
      versions?: { yt_dlp?: string; ffmpeg?: string };
    };
    return {
      // A tokenless sidecar serves /healthz with ok:false — configured but
      // unusable is DOWN, not up.
      up: body.ok !== false,
      ytDlpVersion: body.versions?.yt_dlp ?? null,
      ffmpegVersion: body.versions?.ffmpeg ?? null,
    };
  } catch {
    return { up: false, ytDlpVersion: null, ffmpegVersion: null };
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
  /** Sheet title as published ("21-62-09 Rev 8" style). */
  name: string;
  width: number | null;
  height: number | null;
  png: Buffer;
};

export type DwfRender = {
  dpi: number;
  /** How many 2D sheets the container holds — more than `sheets.length`
   *  when the sidecar's sheet-count or payload cap truncated the set. */
  sheetCount: number;
  truncated: boolean;
  sheets: DwfSheetRender[];
};

// Renders are in-process Rust (~2s for a real 9-sheet set); the generous
// budget covers a 64-sheet pathological container under the heavy-op gate.
const T_DWF_RENDER = 180_000 + BACKSTOP_MS;
/** Decoded-bytes ceiling, mirroring the sidecar's 48 MB raw-PNG payload cap. */
const DWF_RENDER_MAX_BYTES = 64 * 1024 * 1024;

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
    (res) =>
      consumeJson(res, (body) => {
        const rawSheets = Array.isArray(body.sheets) ? body.sheets : null;
        if (!rawSheets) {
          return { ok: false, code: 'extraction_failed', message: 'render reply has no sheets' };
        }
        const sheets: DwfSheetRender[] = [];
        let total = 0;
        for (const raw of rawSheets) {
          const s = raw as Record<string, unknown>;
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
            width: typeof s.width === 'number' ? s.width : null,
            height: typeof s.height === 'number' ? s.height : null,
            png,
          });
        }
        return {
          ok: true,
          value: {
            dpi: typeof body.dpi === 'number' ? body.dpi : 0,
            sheetCount: typeof body.sheet_count === 'number' ? body.sheet_count : sheets.length,
            truncated: body.truncated === true,
            sheets,
          },
        };
      }),
  );
}
