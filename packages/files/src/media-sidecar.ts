/**
 * Client for the media sidecar (infra/media-sidecar) — yt-dlp + ffmpeg behind
 * a narrow bearer-authed HTTP interface, compose profile `media`.
 *
 * Posture mirrors the sandboxd client, not Tika's never-throws: the caller is
 * the `video_ingest` TOOL, and the LLM needs to distinguish failure modes to
 * explain them ("no captions" vs "site broke" vs "too long"), so every call
 * returns a typed `MediaResult` with the sidecar's error code — it never
 * throws and never silently returns ''. Unconfigured (no URL/token) is its
 * own first-class state so the tool can say "not enabled on this box".
 *
 * Timeouts are the sidecar's own per-op budgets + a 30s transport backstop —
 * two layers on purpose: the sidecar kills its subprocess, and this abort
 * covers a hung connection the sidecar never got to answer.
 */

export type MediaErrorCode =
  | 'not_enabled'
  | 'unreachable'
  | 'unauthorized'
  | 'bad_request'
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
    'Media ingestion is not enabled on this box. It needs the `media` compose profile plus MEDIA_SIDECAR_TOKEN (see docs/deploy.md).',
};

/** Decode the one RFC 2047 shape the sidecar emits (=?utf-8?b|q?…?=). */
function decodeHeader(raw: string | null): string | null {
  if (!raw) return null;
  const parts = raw.match(/=\?utf-8\?([bq])\?([^?]*)\?=/gi);
  if (!parts) return raw;
  try {
    return parts
      .map((p) => {
        const m = /=\?utf-8\?([bq])\?([^?]*)\?=/i.exec(p)!;
        if (m[1]!.toLowerCase() === 'b') return Buffer.from(m[2]!, 'base64').toString('utf8');
        return m[2]!
          .replace(/_/g, ' ')
          .replace(/=([0-9A-F]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
      })
      .join('');
  } catch {
    return raw;
  }
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

async function call(
  path: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<MediaResult<Response>> {
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
    return { ok: true, value: res };
  } catch (err) {
    const aborted = err instanceof Error && err.name === 'AbortError';
    return {
      ok: false,
      code: aborted ? 'timeout' : 'unreachable',
      message: aborted
        ? `media sidecar did not answer within ${Math.round(timeoutMs / 1000)}s`
        : `media sidecar unreachable: ${err instanceof Error ? err.message : String(err)}`,
    };
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

function mediaMeta(res: Response): { durationSeconds: number | null; title: string | null } {
  const dur = res.headers.get('x-media-duration-seconds');
  const parsed = dur == null ? NaN : Number(dur);
  return {
    durationSeconds: Number.isFinite(parsed) ? parsed : null,
    title: decodeHeader(res.headers.get('x-media-title')),
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
    const body = (await res.json()) as { versions?: { yt_dlp?: string; ffmpeg?: string } };
    return {
      up: true,
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
  const res = await call(
    '/probe',
    { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ url }) },
    T_PROBE,
  );
  if (!res.ok) return res;
  const body = (await res.value.json()) as Record<string, unknown>;
  return {
    ok: true,
    value: {
      title: typeof body.title === 'string' ? body.title : null,
      durationSeconds: typeof body.durationSeconds === 'number' ? body.durationSeconds : null,
      channel: typeof body.channel === 'string' ? body.channel : null,
      uploadDate: typeof body.uploadDate === 'string' ? body.uploadDate : null,
      extractor: typeof body.extractor === 'string' ? body.extractor : null,
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
  };
}

export async function mediaCaptions(
  url: string,
  opts?: { lang?: string; prefer?: 'manual' | 'auto' | 'any' },
): Promise<MediaResult<MediaCaptions>> {
  const res = await call(
    '/captions',
    {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ url, lang: opts?.lang, prefer: opts?.prefer ?? 'any' }),
    },
    T_CAPTIONS,
  );
  if (!res.ok) return res;
  const body = (await res.value.json()) as Record<string, unknown>;
  if (typeof body.content !== 'string' || !body.content.trim()) {
    return { ok: false, code: 'no_captions', message: 'sidecar returned an empty caption track' };
  }
  return {
    ok: true,
    value: {
      source: body.source === 'manual' ? 'manual' : 'auto',
      lang: typeof body.lang === 'string' ? body.lang : 'unknown',
      content: body.content,
    },
  };
}

export async function mediaAudio(
  url: string,
  opts: { maxDurationSeconds: number; maxBytes: number },
): Promise<MediaResult<MediaBytes>> {
  const res = await call(
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
  );
  if (!res.ok) return res;
  const bytes = await collectBytes(res.value, opts.maxBytes);
  if (!bytes.ok) return bytes;
  return { ok: true, value: { bytes: bytes.value, ...mediaMeta(res.value) } };
}

export async function mediaExtractAudio(
  video: Buffer,
  opts: { maxDurationSeconds: number; maxAudioBytes: number },
): Promise<MediaResult<MediaBytes>> {
  const res = await call(
    '/extract-audio',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(video.byteLength),
        'X-Media-Max-Duration-Seconds': String(opts.maxDurationSeconds),
      },
      body: new Uint8Array(video),
    },
    T_EXTRACT,
  );
  if (!res.ok) return res;
  const bytes = await collectBytes(res.value, opts.maxAudioBytes);
  if (!bytes.ok) return bytes;
  return { ok: true, value: { bytes: bytes.value, ...mediaMeta(res.value) } };
}

export async function mediaVideo(
  url: string,
  opts: { maxBytes: number },
): Promise<MediaResult<MediaBytes>> {
  const res = await call(
    '/video',
    {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ url, maxBytes: opts.maxBytes }),
    },
    T_VIDEO,
  );
  if (!res.ok) return res;
  const bytes = await collectBytes(res.value, opts.maxBytes);
  if (!bytes.ok) return bytes;
  return { ok: true, value: { bytes: bytes.value, ...mediaMeta(res.value) } };
}
