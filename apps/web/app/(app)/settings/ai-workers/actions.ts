'use server';

/**
 * Server actions for the /settings/ai-workers UI.
 *
 * One action per CRUD + the default-flip + a kind-specific test
 * endpoint (currently TTS only; other kinds get their own test
 * actions when those features ship).
 */

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireOwner } from '@/lib/auth';
import {
  createAiWorker,
  deleteAiWorker,
  setDefaultWorker,
  updateAiWorker,
} from '@/lib/ai-workers';
import { getApiKeyById } from '@mantle/api-keys';
import {
  getChatAdapter,
  getSttAdapter,
  getTtsAdapter,
  getVisionAdapter,
  type ChatModelInfo,
  type SttModelInfo,
  type TtsModelInfo,
  type TtsVoice,
  type VisionModelInfo,
} from '@mantle/voice';
import { getAiWorker } from '@/lib/ai-workers';
import type { AiWorkerKind, AiWorkerParams } from '@mantle/db';

export async function createAiWorkerAction(formData: FormData): Promise<void> {
  const user = await requireOwner();
  const kind = String(formData.get('kind') ?? '') as AiWorkerKind;
  const name = String(formData.get('name') ?? '').trim();
  const provider = String(formData.get('provider') ?? '').trim();
  const model = String(formData.get('model') ?? '').trim();
  const apiKeyId = (formData.get('apiKeyId') as string) || null;
  const systemPrompt = (formData.get('systemPrompt') as string) || null;
  const params = parseParamsFromForm(kind, formData);

  if (!kind || !name || !provider || !model) {
    throw new Error('kind, name, provider, model are required');
  }

  const created = await createAiWorker({
    ownerId: user.id,
    kind,
    name,
    provider,
    model,
    apiKeyId: apiKeyId || null,
    systemPrompt,
    params,
    isDefault: formData.get('isDefault') === 'on',
  });
  revalidatePath('/settings/ai-workers');
  redirect(`/settings/ai-workers/${created.id}`);
}

export async function updateAiWorkerAction(
  id: string,
  formData: FormData,
): Promise<void> {
  const user = await requireOwner();
  const existing = await getAiWorker(user.id, id);
  if (!existing) throw new Error('worker not found');
  const params = parseParamsFromForm(existing.kind, formData);
  await updateAiWorker(user.id, id, {
    name: String(formData.get('name') ?? existing.name).trim(),
    provider: String(formData.get('provider') ?? existing.provider).trim(),
    model: String(formData.get('model') ?? existing.model).trim(),
    apiKeyId: (formData.get('apiKeyId') as string) || null,
    systemPrompt: (formData.get('systemPrompt') as string) || null,
    params,
    enabled: formData.get('enabled') === 'on',
    priority: Number(formData.get('priority') ?? existing.priority),
  });
  if (formData.get('isDefault') === 'on') {
    await setDefaultWorker(user.id, id);
  }
  revalidatePath('/settings/ai-workers');
  revalidatePath(`/settings/ai-workers/${id}`);
}

export async function deleteAiWorkerAction(id: string): Promise<void> {
  const user = await requireOwner();
  await deleteAiWorker(user.id, id);
  revalidatePath('/settings/ai-workers');
  redirect('/settings/ai-workers');
}

export async function setDefaultWorkerAction(id: string): Promise<void> {
  const user = await requireOwner();
  await setDefaultWorker(user.id, id);
  revalidatePath('/settings/ai-workers');
}

/**
 * Generate a short audio sample using the given worker's TTS config.
 * Returns base64-encoded opus audio (small) which the client embeds
 * in an `<audio>` element. Only valid for kind='tts'.
 */
export async function testTtsAction(
  id: string,
  text?: string,
): Promise<{ ok: true; audioBase64: string; mimeType: string }> {
  const user = await requireOwner();
  const worker = await getAiWorker(user.id, id);
  if (!worker) throw new Error('worker not found');
  if (worker.kind !== 'tts') throw new Error('worker is not a TTS worker');
  if (!worker.apiKeyId) throw new Error('worker has no api_key configured');
  const apiKey = await getApiKeyById(worker.apiKeyId);
  if (!apiKey) throw new Error('api key not found or could not decrypt');

  // Route through the adapter registry so the test exercises the
  // same code path as production. If the worker is set to a provider
  // we haven't wired (e.g. elevenlabs before its adapter ships), the
  // test refuses with a clear error rather than silently calling
  // openai by accident.
  const adapter = getTtsAdapter(worker.provider);
  if (!adapter) {
    throw new Error(
      `no TTS adapter for provider '${worker.provider}'. Currently wired: openai.`,
    );
  }
  const params = (worker.params ?? {}) as {
    // Voice is a free-form string at the storage layer (see
    // TtsParams.voice). Cast through unknown so the TtsVoice union
    // doesn't reject xAI / ElevenLabs custom ids on the way to the
    // adapter — the adapter is the actual validator.
    voice?: string;
    speed?: number;
    instructions?: string;
    language?: string;
  };
  const sample =
    text?.trim() ||
    `Hi, this is ${worker.name}. If you can hear me clearly, everything's wired up.`;

  const synth = await adapter.synthesize({
    apiKey,
    text: sample,
    voice: (params.voice ?? 'nova') as unknown as TtsVoice,
    model: worker.model || 'gpt-4o-mini-tts',
    speed: params.speed ?? 1.0,
    // mp3 for the browser preview — the <audio> element handles it
    // natively. (opus is what we use for Telegram outbound; some
    // browsers still need extra mime nudging for opus playback.)
    format: 'mp3',
    instructions: params.instructions,
    // Language hint — only xAI/Google use it; OpenAI/ElevenLabs ignore.
    language: params.language,
  });
  return {
    ok: true,
    audioBase64: synth.bytes.toString('base64'),
    mimeType: 'audio/mpeg',
  };
}

/**
 * STT test: transcribe a user-supplied audio sample (base64) using
 * the given worker's configured Whisper model + language hint. The
 * browser captures via the MediaRecorder API; we hand the bytes here.
 */
export async function testSttAction(
  id: string,
  audioBase64: string,
  mimeType: string,
): Promise<{ ok: true; text: string; language: string | null; duration: number | null }> {
  const user = await requireOwner();
  const worker = await getAiWorker(user.id, id);
  if (!worker) throw new Error('worker not found');
  if (worker.kind !== 'stt') throw new Error('worker is not an STT worker');
  if (!worker.apiKeyId) throw new Error('worker has no api_key configured');
  const apiKey = await getApiKeyById(worker.apiKeyId);
  if (!apiKey) throw new Error('api key not found or could not decrypt');

  const adapter = getSttAdapter(worker.provider);
  if (!adapter) {
    throw new Error(
      `no STT adapter for provider '${worker.provider}'. Currently wired: openai.`,
    );
  }
  const bytes = Buffer.from(audioBase64, 'base64');
  const params = (worker.params ?? {}) as { language?: string; max_duration_seconds?: number };
  const result = await adapter.transcribe(bytes, {
    apiKey,
    mimeType: mimeType || 'audio/webm',
    model: worker.model,
    language: params.language,
    maxDurationSeconds: params.max_duration_seconds ?? 180,
  });
  return {
    ok: true,
    text: result.text,
    language: result.language,
    duration: result.durationSeconds,
  };
}

/**
 * List the TTS or STT models a given api_key actually has access to,
 * delegated through the provider's adapter. Returns `{available,
 * filtered, error}` — the form uses this to narrow the model dropdown.
 *
 * Different providers expose different "list models" surfaces (OpenAI
 * has /v1/models; ElevenLabs would query /v1/models too but with
 * its own catalog; Hugging Face has hub search). The adapter's
 * `discoverModels` method handles each. If the adapter doesn't
 * implement discovery (rare — only for providers that don't expose a
 * list endpoint), we surface `filtered: false, error: 'discovery not
 * supported'` and the UI falls back to the static catalog.
 */
export async function discoverModelsAction(
  apiKeyId: string,
  kind: 'tts' | 'stt' | 'chat' | 'vision',
  providerId: string,
): Promise<{
  available: Array<TtsModelInfo | SttModelInfo | ChatModelInfo | VisionModelInfo>;
  filtered: boolean;
  error: string | null;
}> {
  // Owner-scope the api key lookup — same model the agent runtime uses,
  // so a leaked api_key_id from the URL can't be exfiltrated here.
  await requireOwner();
  const apiKey = await getApiKeyById(apiKeyId);
  if (!apiKey) {
    return {
      available: [],
      filtered: false,
      error: 'API key not found or could not decrypt',
    };
  }
  const adapter =
    kind === 'tts'
      ? getTtsAdapter(providerId)
      : kind === 'stt'
      ? getSttAdapter(providerId)
      : kind === 'vision'
      ? getVisionAdapter(providerId)
      : getChatAdapter(providerId);
  if (!adapter) {
    return {
      available: [],
      filtered: false,
      error: `no ${kind.toUpperCase()} adapter registered for provider '${providerId}'`,
    };
  }
  if (!adapter.discoverModels) {
    return {
      available: [],
      filtered: false,
      error: `adapter '${adapter.adapterName}' does not support model discovery`,
    };
  }
  return adapter.discoverModels(apiKey);
}

/**
 * List the voices available for a given TTS provider + model.
 *
 * For OpenAI, this is a static catalog lookup. For ElevenLabs, the
 * adapter hits /v1/voices live so user-cloned voices appear in the
 * dropdown alongside premades. Each adapter handles its own quirks
 * (HF would query its custom-voice endpoint when we wire that).
 */
export async function listVoicesAction(
  apiKeyId: string,
  providerId: string,
  modelId: string,
): Promise<{ voices: Array<{ id: string; description: string }>; error: string | null }> {
  await requireOwner();
  const adapter = getTtsAdapter(providerId);
  if (!adapter || !adapter.voicesForModel) {
    return { voices: [], error: `no voice discovery for provider '${providerId}'` };
  }
  // ElevenLabs needs the key to call /v1/voices. OpenAI's voicesForModel
  // is a pure local catalog lookup that ignores the key.
  const apiKey = apiKeyId ? await getApiKeyById(apiKeyId) : null;
  try {
    const voices = await adapter.voicesForModel(modelId, apiKey ?? undefined);
    return { voices, error: null };
  } catch (err) {
    return {
      voices: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Test a vision worker by extracting text from a user-supplied image.
 * The browser hands us a base64-encoded blob (jpeg/png/etc.) and the
 * adapter handles the rest. Returns the extracted text + the model
 * that did the work + token usage, so the operator can sanity-check
 * the worker's config before relying on it in the ingest pipeline.
 *
 * Routes through the same adapter registry the runtime uses, so a
 * successful test means production will succeed too.
 */
export async function testVisionAction(
  workerId: string,
  imageBase64: string,
  mimeType: string,
): Promise<{
  ok: true;
  text: string;
  model: string;
  adapter: string;
  tokensIn: number | null;
  tokensOut: number | null;
}> {
  const user = await requireOwner();
  const worker = await getAiWorker(user.id, workerId);
  if (!worker) throw new Error('worker not found');
  if (worker.kind !== 'vision') throw new Error('worker is not a vision worker');
  if (!worker.apiKeyId) throw new Error('worker has no api_key configured');
  const apiKey = await getApiKeyById(worker.apiKeyId);
  if (!apiKey) throw new Error('api key not found or could not decrypt');

  const adapter = getVisionAdapter(worker.provider);
  if (!adapter) {
    throw new Error(
      `no vision adapter for provider '${worker.provider}'. Currently wired: openai, anthropic, google, xai.`,
    );
  }
  const bytes = Buffer.from(imageBase64, 'base64');
  if (bytes.length === 0) throw new Error('empty image buffer');

  const params = (worker.params ?? {}) as {
    extraction_prompt?: string;
    max_tokens?: number;
  };
  // Fall back to a verbatim-transcription default if the worker has
  // no per-image prompt configured. Matches the form's placeholder
  // text so the test does what the operator probably expects.
  const prompt =
    params.extraction_prompt?.trim() ||
    'Transcribe everything visible in this image verbatim, preserving line breaks and structure. If something is unclear, mark it [unclear]. Output plain text only.';

  const result = await adapter.extract(bytes, {
    apiKey,
    mimeType: mimeType || 'image/jpeg',
    prompt,
    systemPrompt: worker.systemPrompt ?? undefined,
    model: worker.model,
    maxTokens: params.max_tokens ?? 2000,
  });

  return {
    ok: true,
    text: result.text,
    model: result.model,
    adapter: adapter.adapterName,
    tokensIn: result.tokensIn ?? null,
    tokensOut: result.tokensOut ?? null,
  };
}

/**
 * Test a chat worker by sending a one-shot prompt through its
 * configured adapter and returning the response. Used by the
 * "Test chat" button on chat-shaped worker forms (reflector,
 * extractor, summarizer) so operators can verify provider + model +
 * api key wiring without waiting for the worker's natural trigger.
 *
 * Routes through the same adapter registry the runtime uses — so a
 * successful test means the production code path will also work.
 */
export async function testChatAction(
  workerId: string,
  prompt: string,
): Promise<{
  ok: true;
  reply: string;
  model: string;
  adapter: string;
  tokensIn: number | null;
  tokensOut: number | null;
}> {
  const user = await requireOwner();
  const worker = await getAiWorker(user.id, workerId);
  if (!worker) throw new Error('worker not found');
  if (!worker.apiKeyId) throw new Error('worker has no api_key configured');
  const apiKey = await getApiKeyById(worker.apiKeyId);
  if (!apiKey) throw new Error('api key not found or could not decrypt');

  const adapter = getChatAdapter(worker.provider);
  if (!adapter) {
    throw new Error(
      `no chat adapter for provider '${worker.provider}'. ` +
        `Currently wired chat adapters: xai, huggingface, anthropic, google. ` +
        `The existing reflector/extractor/summarizer workers still route ` +
        `through OpenRouter directly — switch this worker's provider ` +
        `to one of the wired ones to test via the adapter layer.`,
    );
  }

  const trimmed = (prompt ?? '').trim() || 'Hello — please reply with a short greeting.';
  const params = (worker.params ?? {}) as {
    temperature?: number;
    max_tokens?: number;
    huggingface_routing?: string;
  };

  const result = await adapter.chat({
    apiKey,
    model: worker.model,
    messages: [
      ...(worker.systemPrompt ? [{ role: 'system' as const, content: worker.systemPrompt }] : []),
      { role: 'user', content: trimmed },
    ],
    temperature: params.temperature,
    maxTokens: params.max_tokens ?? 500,
    // Forward provider-specific knobs. The adapter ignores extras it
    // doesn't recognise.
    extra: params.huggingface_routing
      ? { routing: params.huggingface_routing }
      : undefined,
  });

  return {
    ok: true,
    reply: result.text,
    model: result.model,
    adapter: adapter.adapterName,
    tokensIn: result.tokensIn ?? null,
    tokensOut: result.tokensOut ?? null,
  };
}

// ─── helpers ────────────────────────────────────────────────────────

function num(v: FormDataEntryValue | null): number | undefined {
  if (v == null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function str(v: FormDataEntryValue | null): string | undefined {
  if (v == null) return undefined;
  const s = String(v).trim();
  return s.length > 0 ? s : undefined;
}

/**
 * Read kind-specific params out of the form. Each kind only inspects
 * the fields it expects; ignored fields drop silently. The result
 * goes into the jsonb `params` column on the row.
 */
function parseParamsFromForm(kind: AiWorkerKind, fd: FormData): AiWorkerParams {
  switch (kind) {
    case 'tts': {
      return {
        // Voice is a free-form string now — accepts OpenAI preset
        // names, xAI custom ids (`69smp8rm`), ElevenLabs voice ids,
        // etc. The adapter handles per-provider validation; storing
        // it raw means a future provider's new voice naming scheme
        // doesn't require a schema change.
        voice: str(fd.get('voice')),
        speed: num(fd.get('speed')),
        format: (str(fd.get('format')) as 'mp3' | 'opus' | undefined) ?? undefined,
        instructions: str(fd.get('instructions')),
        // Optional BCP-47 language. xAI uses this to force a voice's
        // accent (necessary for custom French/Spanish/etc. clones);
        // Google honours it too. OpenAI and ElevenLabs ignore.
        language: str(fd.get('language')),
      };
    }
    case 'stt': {
      return {
        language: str(fd.get('language')),
        max_duration_seconds: num(fd.get('max_duration_seconds')),
      };
    }
    case 'vision': {
      return {
        extraction_prompt: str(fd.get('extraction_prompt')),
        max_tokens: num(fd.get('max_tokens')),
      } as AiWorkerParams;
    }
    case 'image_gen': {
      return {
        size: str(fd.get('size')),
        style: str(fd.get('style')),
        quality: str(fd.get('quality')),
      };
    }
    case 'reflector': {
      return {
        temperature: num(fd.get('temperature')),
        max_tokens: num(fd.get('max_tokens')),
        window_size: num(fd.get('window_size')),
        max_notes_per_run: num(fd.get('max_notes_per_run')),
        // Hugging Face routing policy — appended to the model id when
        // the worker actually calls HF. Other providers ignore.
        huggingface_routing: str(fd.get('huggingface_routing')),
      } as AiWorkerParams;
    }
    case 'extractor': {
      const targetTypes = str(fd.get('target_types'));
      return {
        temperature: num(fd.get('temperature')),
        max_tokens: num(fd.get('max_tokens')),
        target_types: targetTypes
          ? targetTypes.split(',').map((s) => s.trim()).filter(Boolean)
          : undefined,
        extract_facts: fd.get('extract_facts') === 'on',
        embedding_model: str(fd.get('embedding_model')),
        extract_cost_cap_micro_usd: num(fd.get('extract_cost_cap_micro_usd')),
        huggingface_routing: str(fd.get('huggingface_routing')),
      } as AiWorkerParams;
    }
    case 'summarizer': {
      return {
        temperature: num(fd.get('temperature')),
        max_tokens: num(fd.get('max_tokens')),
        summarize_threshold: num(fd.get('summarize_threshold')),
        summarize_batch: num(fd.get('summarize_batch')),
        huggingface_routing: str(fd.get('huggingface_routing')),
      } as AiWorkerParams;
    }
    default:
      return {};
  }
}
