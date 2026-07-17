/**
 * OpenAI Whisper transcription. Single function, multipart form upload,
 * returns transcript text plus the metadata we want in /traces (model,
 * detected language, duration).
 *
 * Why not OpenRouter: OpenRouter proxies chat/completion endpoints, not
 * the audio API. Callers must hold a direct OpenAI key. We look that
 * key up via `getApiKey(ownerId, 'openai')` at the call site — this
 * module is provider-agnostic about resolution and just takes the
 * plaintext key as input.
 *
 * Cost reference (May 2026): whisper-1 ≈ $0.006 / minute. A 1-minute
 * voice note is six tenths of a cent. The duration cap exists to keep
 * a misbehaving client from sending a podcast and burning budget.
 */

import type { TranscribeOptions, TranscribeResult } from './types';

const OPENAI_TRANSCRIBE_URL = 'https://api.openai.com/v1/audio/transcriptions';
const DEFAULT_MODEL = 'whisper-1';
const DEFAULT_MAX_DURATION_SEC = 180;

/** Map a Telegram-style MIME to the filename extension Whisper wants
 *  on the multipart field. Whisper sniffs by extension on the
 *  filename, not by Content-Type — sending audio.bin returns a 400.
 *  Unknown MIMEs fall back to .ogg (Telegram's native voice format),
 *  which Whisper accepts. */
export function filenameForMime(mime: string): string {
  const lower = mime.toLowerCase();
  if (lower.includes('ogg') || lower.includes('opus')) return 'audio.ogg';
  if (lower.includes('mp3') || lower.includes('mpeg')) return 'audio.mp3';
  if (lower.includes('m4a') || lower.includes('aac')) return 'audio.m4a';
  if (lower.includes('wav')) return 'audio.wav';
  if (lower.includes('webm')) return 'audio.webm';
  if (lower.includes('flac')) return 'audio.flac';
  return 'audio.ogg';
}

/**
 * Send `audio` to Whisper and return the transcript. Throws on:
 *   - missing API key
 *   - empty / unreadable buffer
 *   - HTTP non-2xx (with status + body in the message)
 *   - duration cap exceeded (caller checks via the returned meta)
 *
 * Returned `text` is trimmed; empty transcripts return '' (not null) so
 * callers can branch on length without a nil check.
 */
export async function transcribeAudio(
  audio: Buffer,
  opts: TranscribeOptions,
): Promise<TranscribeResult> {
  if (!opts.apiKey) throw new Error('transcribeAudio: apiKey required');
  if (!audio || audio.length === 0) {
    throw new Error('transcribeAudio: empty audio buffer');
  }

  const model = opts.model ?? DEFAULT_MODEL;
  const filename = filenameForMime(opts.mimeType);

  // `verbose_json` gets us language + duration in the response. The
  // plain `json` format omits both, and we want them for /traces.
  const form = new FormData();
  form.append('model', model);
  form.append('response_format', 'verbose_json');
  if (opts.language) form.append('language', opts.language);
  // `Blob` because Node 18+ accepts it in FormData; the third arg is
  // the filename Whisper sniffs for extension routing. Cast through
  // Uint8Array because Node's Buffer's underlying ArrayBufferLike is
  // not strictly assignable to BlobPart in TS's lib.dom typings.
  const blob = new Blob([new Uint8Array(audio)], { type: opts.mimeType });
  form.append('file', blob, filename);

  const res = await fetch(OPENAI_TRANSCRIBE_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${opts.apiKey}` },
    body: form,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    // Known footgun: MediaRecorder-produced WebM has no duration in its
    // segment header (the browser doesn't know the length until stop()
    // is called, so the EBML field is left unset). whisper-1 tolerates
    // this; gpt-4o-transcribe / gpt-4o-mini-transcribe validate the
    // container more strictly and return a misleading 400 that blames
    // the file ("Audio file might be corrupted or unsupported"). Same
    // bytes, stricter parser. Upgrade the message so the next person
    // debugging this doesn't have to discover it by reading server
    // logs at 11pm.
    const looksLikeMediaRecorderQuirk =
      res.status === 400 &&
      /corrupted|unsupported/i.test(body) &&
      /gpt-4o/i.test(model) &&
      filename === 'audio.webm';
    if (looksLikeMediaRecorderQuirk) {
      throw new Error(
        `${model} rejected the browser recording. This is a known incompatibility — ` +
          `MediaRecorder writes WebM files with no duration in the container header, and ` +
          `the gpt-4o transcription models reject those (whisper-1 tolerates them). ` +
          `Switch this worker's model to whisper-1, or upload an mp3/m4a from disk instead ` +
          `of recording in-browser.`,
      );
    }
    throw new Error(`whisper ${res.status}: ${body.slice(0, 400)}`);
  }
  const parsed = (await res.json()) as {
    text?: string;
    language?: string;
    duration?: number;
  };

  const text = (parsed.text ?? '').trim();
  const durationSeconds = typeof parsed.duration === 'number' ? parsed.duration : null;
  const cap = opts.maxDurationSeconds ?? DEFAULT_MAX_DURATION_SEC;
  if (cap > 0 && durationSeconds != null && durationSeconds > cap) {
    // We've already paid for the transcription — refunds aren't a thing
    // for streaming APIs. But we DO want callers to know they're over
    // cap so they can refuse to proceed (e.g. send a polite "too long,
    // please text" reply rather than chain a giant LLM call on top).
    throw new Error(`voice clip too long: ${durationSeconds.toFixed(1)}s exceeds ${cap}s cap`);
  }

  return {
    text,
    language: parsed.language ?? null,
    durationSeconds,
    model,
  };
}
