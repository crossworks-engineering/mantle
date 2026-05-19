/**
 * OpenAI text-to-speech. Returns raw audio bytes the caller can hand
 * to Telegram's `sendVoice` (when format='opus') or stream to a browser
 * <audio> element.
 *
 * Cost reference (May 2026): tts-1 = $15 per 1M input characters,
 * tts-1-hd = $30. A 200-char Saskia reply is ~$0.003 on tts-1; cheap
 * enough that we don't need usage tracking for personal use.
 *
 * Default voice is `nova` — warm, female, friendly. Configurable per
 * agent via `agents.params.voice.name`. Speed defaults to 1.0; 0.95
 * sounds slightly less rushed for conversational replies if you want
 * that later.
 *
 * Format defaults to `opus` because Telegram voice notes are OGG/Opus
 * natively. Sending opus means the message arrives as a voice-note
 * bubble (with the play/scrub UI), not as a generic audio file.
 */

import type {
  SynthesizeOptions,
  SynthesizeResult,
  TtsVoice,
} from './types';
import { TTS_VOICES } from './types';

const OPENAI_TTS_URL = 'https://api.openai.com/v1/audio/speech';
const DEFAULT_MODEL = 'gpt-4o-mini-tts';
const DEFAULT_VOICE: TtsVoice = 'nova';
const DEFAULT_FORMAT = 'opus';
const DEFAULT_SPEED = 1.0;
/** Hard cap on input length. OpenAI's own API limit is 4096 chars;
 *  we cap slightly under so retries on edge cases have headroom. */
const MAX_TEXT_CHARS = 4000;

export function mimeForFormat(format: string): string {
  switch (format) {
    case 'mp3':
      return 'audio/mpeg';
    case 'opus':
      return 'audio/ogg';
    case 'aac':
      return 'audio/aac';
    case 'flac':
      return 'audio/flac';
    case 'wav':
      return 'audio/wav';
    case 'pcm':
      return 'audio/pcm';
    default:
      return 'application/octet-stream';
  }
}

/** Whether the given voice name is one of OpenAI's published voices.
 *  Exported so the agent settings UI can validate selections, and the
 *  call site can fall back to the default on a typo. */
export function isTtsVoice(v: unknown): v is TtsVoice {
  return typeof v === 'string' && (TTS_VOICES as readonly string[]).includes(v);
}

export async function synthesizeSpeech(
  opts: SynthesizeOptions,
): Promise<SynthesizeResult> {
  if (!opts.apiKey) throw new Error('synthesizeSpeech: apiKey required');
  const raw = (opts.text ?? '').trim();
  if (!raw) throw new Error('synthesizeSpeech: empty text');
  // Truncate rather than throw — TTS for a 5000-char reply is fine
  // truncated; the user gets most of the meaning and we avoid a hard
  // failure on the (rare) long reply. The truncation point lands on a
  // word boundary so we don't cut mid-syllable.
  const text =
    raw.length > MAX_TEXT_CHARS
      ? raw.slice(0, raw.lastIndexOf(' ', MAX_TEXT_CHARS) || MAX_TEXT_CHARS)
      : raw;

  const voice = isTtsVoice(opts.voice) ? opts.voice : DEFAULT_VOICE;
  const model = opts.model ?? DEFAULT_MODEL;
  const format = opts.format ?? DEFAULT_FORMAT;
  // Clamp speed to OpenAI's documented range.
  const speed = Math.min(Math.max(opts.speed ?? DEFAULT_SPEED, 0.25), 4.0);

  const res = await fetch(OPENAI_TTS_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${opts.apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      voice,
      input: text,
      response_format: format,
      speed,
      // Style instructions are only honoured by gpt-4o-mini-tts.
      // Older models (tts-1, tts-1-hd) silently ignore the field,
      // so it's safe to send unconditionally when the operator
      // configured one.
      ...(opts.instructions ? { instructions: opts.instructions } : {}),
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`openai tts ${res.status}: ${body.slice(0, 400)}`);
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length === 0) {
    throw new Error('openai tts: empty response');
  }
  return {
    bytes: buffer,
    mimeType: mimeForFormat(format),
    voice,
    model,
  };
}
