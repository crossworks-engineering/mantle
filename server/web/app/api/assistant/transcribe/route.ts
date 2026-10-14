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
 *
 * Any login (W7c): a member transcribes for its own chat, at most 6 clips a
 * minute (the turn route's rate), each clip a slot of its daily cap (W7c fix
 * round 1, L2).
 */

import { NextResponse } from '@/server/http-compat';
import { chatLoginCaller } from '@/lib/auth';
import { rateLimit } from '@/lib/rate-limit';
import { claimMemberChatWork } from '@/lib/workspace-turn';
import { asSystem, getDefaultWorker } from '@mantle/db';
import { getApiKeyById } from '@mantle/api-keys';
import { getSttAdapter, type SttDispatcher } from '@mantle/voice';
import { errorMessage } from '@mantle/std';

export async function POST(req: Request) {
  const login = chatLoginCaller();
  if (login.kind !== 'admin') {
    const gate = rateLimit(`chat-transcribe:${login.loginId}`, { max: 6, windowMs: 60_000 });
    if (!gate.ok) {
      return NextResponse.json(
        { error: 'too many voice clips, give me a moment' },
        { status: 429, headers: { 'Retry-After': String(gate.retryAfterSec) } },
      );
    }
  }

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

  // The brain's STT worker and its key: system configuration the workspace
  // role does not read.
  const worker = await asSystem(() => getDefaultWorker(login.ownerId, 'stt'), 'rule-in-query');
  if (!worker?.apiKeyId) {
    return NextResponse.json(
      {
        error:
          'No default STT worker configured. Create one at /settings/ai-workers (mark it default for "stt") and reload.',
      },
      { status: 412 },
    );
  }
  const keyId = worker.apiKeyId;
  const apiKey = await asSystem(() => getApiKeyById(keyId), 'rule-in-query');
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
  // Each clip is a model call: a slot of the daily cap for a login that is
  // not an Admin user (W7c fix round 1, L2).
  const limited = await claimMemberChatWork(login, 'transcribe');
  if (limited) return limited;

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
    const msg = errorMessage(err);
    console.error('[assistant/transcribe]', msg);
    // 422 for "we got the audio but couldn't make sense of it" — the
    // client can surface the exact provider message ("audio too
    // short", quota exceeded, etc.) without having to special-case
    // its own enumeration of failure modes.
    return NextResponse.json({ error: msg }, { status: 422 });
  }
}
