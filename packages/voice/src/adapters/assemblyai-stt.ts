/**
 * AssemblyAI STT adapter.
 *
 * Three-call dance — AssemblyAI doesn't expose a synchronous transcribe
 * endpoint:
 *
 *   1. POST /v2/upload (raw bytes)                → { upload_url }
 *   2. POST /v2/transcript { audio_url, … }       → { id, status }
 *   3. GET  /v2/transcript/:id  (poll until done) → { text, audio_duration, … }
 *
 * Each call uses `Authorization: <api-key>` (no scheme prefix — not
 * Bearer, not Token, just the raw key as the header value). Easy thing
 * to get wrong; we record that in code rather than expecting future
 * readers to remember.
 *
 * Latency: even short clips take 2–5 s end-to-end. Acceptable for the
 * "Test STT" button + worker-runtime use; not great for the speech-in
 * path on Telegram where users feel a delay. If we ever care about
 * sub-second STT here, swap the worker to Deepgram or OpenAI.
 *
 * Failure modes we handle explicitly:
 *   - 401 on upload/create → bad key, surfaced directly.
 *   - status='error' from the poll → AssemblyAI's `error` field
 *     contains the human-readable reason; we throw it through.
 *   - poll timeout (ASSEMBLYAI_POLL_TIMEOUT_SECONDS) → throw rather
 *     than hang the request indefinitely.
 */

import type { SttDispatcher } from './types';
import type { TranscribeOptions, TranscribeResult } from '../types';
import { ASSEMBLYAI_BASE_URL, ASSEMBLYAI_POLL_TIMEOUT_SECONDS } from '../catalogs/assemblyai';

const DEFAULT_MODEL = 'universal';
/** Poll cadence — AssemblyAI's docs suggest 3s minimum to avoid being
 *  rate limited on the polling endpoint. */
const POLL_INTERVAL_MS = 3000;

type CreateTranscriptResponse = {
  id: string;
  status: 'queued' | 'processing' | 'completed' | 'error';
  error?: string;
};

type PollResponse = {
  id: string;
  status: 'queued' | 'processing' | 'completed' | 'error';
  text?: string;
  audio_duration?: number;
  language_code?: string;
  error?: string;
};

async function uploadAudio(apiKey: string, audio: Buffer, mime: string): Promise<string> {
  const res = await fetch(`${ASSEMBLYAI_BASE_URL}/v2/upload`, {
    method: 'POST',
    headers: {
      // AssemblyAI's `Authorization` is the bare key — no `Bearer ` prefix.
      Authorization: apiKey,
      'Content-Type': mime || 'application/octet-stream',
    },
    body: new Uint8Array(audio),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`assemblyai upload ${res.status}: ${body.slice(0, 400)}`);
  }
  const parsed = (await res.json()) as { upload_url?: string };
  if (!parsed.upload_url) throw new Error('assemblyai upload: no upload_url in response');
  return parsed.upload_url;
}

async function createTranscript(
  apiKey: string,
  audioUrl: string,
  model: string,
  language?: string,
): Promise<string> {
  const body: Record<string, unknown> = {
    audio_url: audioUrl,
    speech_model: model,
  };
  if (language) body.language_code = language;
  else body.language_detection = true;

  const res = await fetch(`${ASSEMBLYAI_BASE_URL}/v2/transcript`, {
    method: 'POST',
    headers: {
      Authorization: apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`assemblyai create-transcript ${res.status}: ${body.slice(0, 400)}`);
  }
  const parsed = (await res.json()) as CreateTranscriptResponse;
  if (!parsed.id) throw new Error('assemblyai create-transcript: no id in response');
  if (parsed.status === 'error') {
    throw new Error(`assemblyai create-transcript: ${parsed.error ?? 'unknown error'}`);
  }
  return parsed.id;
}

async function pollUntilDone(apiKey: string, transcriptId: string): Promise<PollResponse> {
  const deadline = Date.now() + ASSEMBLYAI_POLL_TIMEOUT_SECONDS * 1000;
  // First poll happens after a small delay — AssemblyAI almost never
  // finishes by the time the create call returns, so polling
  // immediately just burns a request quota slot.
  await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  while (Date.now() < deadline) {
    const res = await fetch(`${ASSEMBLYAI_BASE_URL}/v2/transcript/${transcriptId}`, {
      headers: { Authorization: apiKey },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`assemblyai poll ${res.status}: ${body.slice(0, 400)}`);
    }
    const parsed = (await res.json()) as PollResponse;
    if (parsed.status === 'completed') return parsed;
    if (parsed.status === 'error') {
      throw new Error(`assemblyai transcript error: ${parsed.error ?? 'unknown'}`);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(
    `assemblyai-stt: transcript ${transcriptId} not done after ${ASSEMBLYAI_POLL_TIMEOUT_SECONDS}s`,
  );
}

export const assemblyAiSttAdapter: SttDispatcher = {
  providerId: 'assemblyai',
  adapterName: 'assemblyai-stt',
  async transcribe(audio: Buffer, opts: TranscribeOptions): Promise<TranscribeResult> {
    if (!opts.apiKey) throw new Error('assemblyai-stt: apiKey required');
    if (!audio || audio.length === 0) {
      throw new Error('assemblyai-stt: empty audio buffer');
    }

    const model = opts.model || DEFAULT_MODEL;
    const uploadUrl = await uploadAudio(opts.apiKey, audio, opts.mimeType);
    const transcriptId = await createTranscript(opts.apiKey, uploadUrl, model, opts.language);
    const result = await pollUntilDone(opts.apiKey, transcriptId);

    const duration = typeof result.audio_duration === 'number' ? result.audio_duration : null;
    const cap = opts.maxDurationSeconds ?? 180;
    if (cap > 0 && duration != null && duration > cap) {
      throw new Error(`assemblyai-stt: clip too long: ${duration.toFixed(1)}s exceeds ${cap}s cap`);
    }

    return {
      text: (result.text ?? '').trim(),
      language: result.language_code ?? opts.language ?? null,
      durationSeconds: duration,
      model,
    };
  },
};
