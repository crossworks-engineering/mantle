/**
 * /api/assistant/transcribe — voice-in for the web assistant.
 *
 * The /assistant client records audio with MediaRecorder, sends the
 * bytes here, and gets the transcript back. The user reviews the
 * transcript in the input box before sending — auto-send would punish
 * mishearings (Whisper occasionally inserts phantom words on silent
 * stretches, and gpt-4o-mini-transcribe rejects MediaRecorder webm
 * outright; see the patched error in transcribe.ts).
 *
 * Routes through the same default-STT-worker the Telegram pipeline
 * uses, so a working voice-note in Telegram = a working mic on web.
 * If no STT worker is configured we return a 412 (Precondition
 * Failed) with a hint so the client surfaces the right call to
 * action.
 */

import { NextResponse } from 'next/server';
import { getOwnerOr401 } from '@/lib/auth';
import { getDefaultWorker } from '@mantle/db';
import { getApiKeyById } from '@mantle/api-keys';
import { getSttAdapter, type SttDispatcher } from '@mantle/voice';

export async function POST(req: Request) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;

  // Multipart only — base64 in JSON would be wasteful for >100KB
  // audio blobs, and the FormData API handles streaming uploads.
  const formData = await req.formData().catch(() => null);
  if (!formData) {
    return NextResponse.json({ error: 'expected multipart/form-data' }, { status: 400 });
  }
  const file = formData.get('audio');
  if (!(file instanceof Blob)) {
    return NextResponse.json({ error: 'audio field missing or not a Blob' }, { status: 400 });
  }
  if (file.size === 0) {
    return NextResponse.json({ error: 'empty audio buffer' }, { status: 400 });
  }
  // Browsers don't always set a useful content-type on FormData blobs
  // (Safari sends 'application/octet-stream' on MediaRecorder Blobs).
  // Fall back to webm — the most common MediaRecorder output —
  // and let the STT adapter sniff filename-by-extension from there.
  const mimeType = file.type && file.type.length > 0 ? file.type : 'audio/webm';
  const language = (formData.get('language') as string | null) ?? undefined;

  const worker = await getDefaultWorker(user.id, 'stt');
  if (!worker?.apiKeyId) {
    return NextResponse.json(
      {
        error:
          'No default STT worker configured. Create one at /settings/ai-workers (mark it default for "stt") and reload.',
      },
      { status: 412 },
    );
  }
  const apiKey = await getApiKeyById(worker.apiKeyId);
  if (!apiKey) {
    return NextResponse.json(
      { error: `STT worker '${worker.slug}' api_key could not be decrypted.` },
      { status: 412 },
    );
  }
  const adapter: SttDispatcher | null = getSttAdapter(worker.provider);
  if (!adapter) {
    return NextResponse.json(
      {
        error: `No STT adapter wired for provider '${worker.provider}'. Switch the worker to openai / xai / elevenlabs / deepgram / assemblyai / google.`,
      },
      { status: 412 },
    );
  }

  try {
    const bytes = Buffer.from(await file.arrayBuffer());
    const params = (worker.params ?? {}) as {
      language?: string;
      max_duration_seconds?: number;
    };
    const result = await adapter.transcribe(bytes, {
      apiKey,
      mimeType,
      model: worker.model,
      language: language ?? params.language,
      maxDurationSeconds: params.max_duration_seconds ?? 180,
    });
    return NextResponse.json({
      text: result.text,
      language: result.language,
      durationSeconds: result.durationSeconds,
      model: result.model,
      adapter: adapter.adapterName,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[assistant/transcribe]', msg);
    // 422 for "we got the audio but couldn't make sense of it" — the
    // client can surface the exact provider message ("audio too
    // short", quota exceeded, etc.) without having to special-case
    // its own enumeration of failure modes.
    return NextResponse.json({ error: msg }, { status: 422 });
  }
}
