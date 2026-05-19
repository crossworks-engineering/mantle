/**
 * Tests for the pure helpers in @mantle/voice. The actual API-calling
 * functions (transcribeAudio, synthesizeSpeech) are NOT exercised here
 * — they'd need a live OpenAI key, real audio bytes, and a network
 * round-trip. We keep tests focused on the format-handling layer that
 * has historically been the source of "everything compiled but the
 * response is empty" bugs:
 *
 *   1. filenameForMime — Whisper sniffs by extension; a wrong filename
 *      = silent 400. This needs to map every MIME we care about.
 *   2. mimeForFormat — drives the outbound Content-Type we tell
 *      Telegram about; a wrong MIME = sendVoice falls back to
 *      sendAudio and the user sees a generic file, not a voice bubble.
 *   3. isTtsVoice — guards the agent settings form so a typo in the
 *      voice name can't reach the API and silently default to alloy.
 */

import { describe, expect, it } from 'vitest';
import { filenameForMime } from './transcribe';
import { isTtsVoice, mimeForFormat } from './synthesize';
import { TTS_VOICES } from './types';

describe('filenameForMime', () => {
  it('maps Telegram voice OGG to audio.ogg', () => {
    // The most-common case: Telegram voice notes are audio/ogg with
    // Opus inside. Whisper accepts .ogg and routes correctly.
    expect(filenameForMime('audio/ogg')).toBe('audio.ogg');
    expect(filenameForMime('audio/ogg;codecs=opus')).toBe('audio.ogg');
  });

  it('maps MP3 and MPEG variants to audio.mp3', () => {
    expect(filenameForMime('audio/mp3')).toBe('audio.mp3');
    expect(filenameForMime('audio/mpeg')).toBe('audio.mp3');
  });

  it('maps M4A / AAC to audio.m4a', () => {
    expect(filenameForMime('audio/m4a')).toBe('audio.m4a');
    expect(filenameForMime('audio/aac')).toBe('audio.m4a');
  });

  it('maps WAV / WebM / FLAC to their own extensions', () => {
    expect(filenameForMime('audio/wav')).toBe('audio.wav');
    expect(filenameForMime('audio/webm')).toBe('audio.webm');
    expect(filenameForMime('audio/flac')).toBe('audio.flac');
  });

  it('falls back to .ogg on unknown MIME (Telegram-default)', () => {
    // Unknown MIME is rare but possible; fall back to the most likely
    // shape rather than refusing. Worst case Whisper returns a 400 and
    // we surface it cleanly to the user, but most of the time .ogg is
    // a safe guess from a Telegram-origin clip.
    expect(filenameForMime('application/octet-stream')).toBe('audio.ogg');
    expect(filenameForMime('')).toBe('audio.ogg');
  });

  it('is case-insensitive — Telegram sometimes returns Audio/OGG', () => {
    expect(filenameForMime('Audio/OGG')).toBe('audio.ogg');
    expect(filenameForMime('AUDIO/MPEG')).toBe('audio.mp3');
  });
});

describe('mimeForFormat', () => {
  it('maps opus to audio/ogg (Telegram-voice native)', () => {
    // This is the most important one — if we get this wrong, Telegram
    // refuses sendVoice with `WEBPAGE_MEDIA_INVALID` or falls back to
    // sendAudio (generic file bubble instead of voice waveform).
    expect(mimeForFormat('opus')).toBe('audio/ogg');
  });

  it('maps mp3/aac/flac/wav/pcm to their conventional MIMEs', () => {
    expect(mimeForFormat('mp3')).toBe('audio/mpeg');
    expect(mimeForFormat('aac')).toBe('audio/aac');
    expect(mimeForFormat('flac')).toBe('audio/flac');
    expect(mimeForFormat('wav')).toBe('audio/wav');
    expect(mimeForFormat('pcm')).toBe('audio/pcm');
  });

  it('returns application/octet-stream for unknown formats', () => {
    // Safe fallback — downstream might refuse, but at least the type
    // is a recognised "we don't know" rather than a lie.
    expect(mimeForFormat('flv')).toBe('application/octet-stream');
    expect(mimeForFormat('')).toBe('application/octet-stream');
  });
});

describe('isTtsVoice', () => {
  it('returns true for every voice in TTS_VOICES', () => {
    // Catches a future expansion of TTS_VOICES that forgets to update
    // this predicate — the test will start passing for the new voice
    // automatically because we iterate the const array.
    for (const v of TTS_VOICES) {
      expect(isTtsVoice(v)).toBe(true);
    }
  });

  it('returns false for typos and unknown names', () => {
    // The whole reason this helper exists — a user-edited agent params
    // row with 'novah' should NOT reach OpenAI as the literal string;
    // the call site falls back to the default.
    expect(isTtsVoice('novah')).toBe(false);
    expect(isTtsVoice('Nova')).toBe(false); // case matters; OpenAI is lower-case
    expect(isTtsVoice('')).toBe(false);
  });

  it('returns false for non-strings', () => {
    expect(isTtsVoice(null)).toBe(false);
    expect(isTtsVoice(undefined)).toBe(false);
    expect(isTtsVoice(42)).toBe(false);
    expect(isTtsVoice({})).toBe(false);
  });
});

describe('TTS_VOICES catalogue', () => {
  it('includes the full expanded set of OpenAI voices (May 2026: 13 voices)', () => {
    // The voice list is part of our user-facing contract — the agent
    // settings dropdown renders from this. Lock down the exact set so
    // a refactor that drops or renames one is caught. This includes
    // the gpt-4o-mini-tts additions: ballad, verse, marin, cedar
    // (plus ash/coral/sage which became cross-model).
    expect(new Set(TTS_VOICES)).toEqual(
      new Set([
        'alloy',
        'ash',
        'ballad',
        'cedar',
        'coral',
        'echo',
        'fable',
        'marin',
        'nova',
        'onyx',
        'sage',
        'shimmer',
        'verse',
      ]),
    );
    expect(TTS_VOICES).toContain('nova');
    // Saskia's default voice must always be present.
    expect(TTS_VOICES).toContain('nova');
    // The "recommended best quality" voices on gpt-4o-mini-tts.
    expect(TTS_VOICES).toContain('marin');
    expect(TTS_VOICES).toContain('cedar');
  });
});
