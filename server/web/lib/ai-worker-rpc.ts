/**
 * AI-worker test/discover RPCs — the live-provider operations behind the
 * /settings/ai-workers test buttons and model/voice pickers. Backs the
 * `/api/ai-workers/**` test endpoints (the screen is fully client-fetched).
 *
 * Each function takes the resolved owner `userId` (the caller does the auth
 * gate) and routes through the same adapter registry production uses, so a
 * passing test means the configured worker will work for real.
 */
import { getApiKeyById } from '@mantle/api-keys';
import {
  getChatAdapter,
  getEmbeddingAdapter,
  getImageGenAdapter,
  getSttAdapter,
  getTtsAdapter,
  getVisionAdapter,
  nativeDocumentProviders,
  type ChatModelInfo,
  type ImageGenModelInfo,
  type SttModelInfo,
  type TtsModelInfo,
  type TtsVoice,
  type VisionModelInfo,
} from '@mantle/voice';
import { embed, resolveEmbeddingModel, runReembed, type ReembedResult } from '@mantle/embeddings';
import { getAiWorker } from '@/lib/ai-workers';

export type DiscoverKind = 'tts' | 'stt' | 'chat' | 'vision' | 'image_gen' | 'embedding';

/** Rebuild every stored vector against the *currently configured* embedding
 *  model (server-resolved, not the form draft). Cache-aware + idempotent. */
export async function reembedIndex(
  userId: string,
): Promise<{ ok: true; model: string; result: ReembedResult } | { ok: false; error: string }> {
  try {
    const model = await resolveEmbeddingModel(userId);
    const result = await runReembed(userId, { model });
    return { ok: true, model, result };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Embed a sentinel string and report the model's actual output dimension. */
export async function testEmbeddingModel(
  userId: string,
  model: string,
): Promise<{ ok: true; dimensions: number } | { ok: false; error: string }> {
  const slug = model.trim();
  if (!slug) return { ok: false, error: 'No model selected' };
  try {
    const vec = await embed(userId, 'dimension probe', { model: slug });
    return { ok: true, dimensions: vec.length };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Synthesize a short audio sample with a tts worker's config (base64 mp3). */
export async function testTts(
  userId: string,
  id: string,
  text?: string,
): Promise<{ ok: true; audioBase64: string; mimeType: string }> {
  const worker = await getAiWorker(userId, id);
  if (!worker) throw new Error('worker not found');
  if (worker.kind !== 'tts') throw new Error('worker is not a TTS worker');
  if (!worker.apiKeyId) throw new Error('worker has no api_key configured');
  const apiKey = await getApiKeyById(worker.apiKeyId);
  if (!apiKey) throw new Error('api key not found or could not decrypt');

  const adapter = getTtsAdapter(worker.provider);
  if (!adapter) {
    throw new Error(`no TTS adapter for provider '${worker.provider}'. Currently wired: openai.`);
  }
  const params = (worker.params ?? {}) as {
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
    format: 'mp3',
    instructions: params.instructions,
    language: params.language,
  });
  return { ok: true, audioBase64: synth.bytes.toString('base64'), mimeType: 'audio/mpeg' };
}

/** Transcribe a user-supplied audio sample (base64) via an stt worker. */
export async function testStt(
  userId: string,
  id: string,
  audioBase64: string,
  mimeType: string,
): Promise<{ ok: true; text: string; language: string | null; duration: number | null }> {
  const worker = await getAiWorker(userId, id);
  if (!worker) throw new Error('worker not found');
  if (worker.kind !== 'stt') throw new Error('worker is not an STT worker');
  if (!worker.apiKeyId) throw new Error('worker has no api_key configured');
  const apiKey = await getApiKeyById(worker.apiKeyId);
  if (!apiKey) throw new Error('api key not found or could not decrypt');

  const adapter = getSttAdapter(worker.provider);
  if (!adapter) {
    throw new Error(`no STT adapter for provider '${worker.provider}'. Currently wired: openai.`);
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

/** List the models a given api_key can access, for the form's dropdown. */
export async function discoverModels(
  apiKeyId: string,
  kind: DiscoverKind,
  providerId: string,
): Promise<{
  available: Array<
    TtsModelInfo | SttModelInfo | ChatModelInfo | VisionModelInfo | ImageGenModelInfo
  >;
  filtered: boolean;
  error: string | null;
}> {
  if (kind === 'embedding') {
    const adapter = getEmbeddingAdapter(providerId);
    if (!adapter) {
      return {
        available: [],
        filtered: false,
        error: `no embedding adapter registered for provider '${providerId}'`,
      };
    }
    const apiKey = apiKeyId ? await getApiKeyById(apiKeyId) : '';
    const result = adapter.discoverModels
      ? await adapter.discoverModels(apiKey ?? '')
      : {
          available: adapter.staticCatalog ? [...adapter.staticCatalog()] : [],
          filtered: false as const,
          error: null,
        };
    return {
      available: result.available as unknown as ChatModelInfo[],
      filtered: result.filtered,
      error: result.error,
    };
  }

  const apiKey = await getApiKeyById(apiKeyId);
  if (!apiKey) {
    return { available: [], filtered: false, error: 'API key not found or could not decrypt' };
  }
  const adapter =
    kind === 'tts'
      ? getTtsAdapter(providerId)
      : kind === 'stt'
        ? getSttAdapter(providerId)
        : kind === 'vision'
          ? getVisionAdapter(providerId)
          : kind === 'image_gen'
            ? getImageGenAdapter(providerId)
            : getChatAdapter(providerId);
  if (!adapter) {
    return {
      available: [],
      filtered: false,
      error: `no ${kind.toUpperCase()} adapter registered for provider '${providerId}'`,
    };
  }
  if (!('discoverModels' in adapter) || !adapter.discoverModels) {
    if (kind === 'image_gen' && 'staticCatalog' in adapter && adapter.staticCatalog) {
      return { available: [...adapter.staticCatalog()], filtered: false, error: null };
    }
    return {
      available: [],
      filtered: false,
      error: `adapter '${adapter.adapterName}' does not support model discovery`,
    };
  }
  return adapter.discoverModels(apiKey);
}

/** List the voices for a tts provider + model (live for ElevenLabs). */
export async function listVoices(
  apiKeyId: string,
  providerId: string,
  modelId: string,
): Promise<{ voices: Array<{ id: string; description: string }>; error: string | null }> {
  const adapter = getTtsAdapter(providerId);
  if (!adapter || !adapter.voicesForModel) {
    return { voices: [], error: `no voice discovery for provider '${providerId}'` };
  }
  const apiKey = apiKeyId ? await getApiKeyById(apiKeyId) : null;
  try {
    const voices = await adapter.voicesForModel(modelId, apiKey ?? undefined);
    return { voices, error: null };
  } catch (err) {
    return { voices: [], error: err instanceof Error ? err.message : String(err) };
  }
}

/** Generate an image from a prompt via an image_gen worker (base64 bytes). */
export async function testImageGen(
  userId: string,
  workerId: string,
  prompt: string,
  overrides?: { size?: string; style?: string; quality?: string },
): Promise<{
  ok: true;
  imageBase64: string;
  mimeType: string;
  model: string;
  adapter: string;
  revisedPrompt: string | null;
}> {
  const worker = await getAiWorker(userId, workerId);
  if (!worker) throw new Error('worker not found');
  if (worker.kind !== 'image_gen') throw new Error('worker is not an image_gen worker');
  if (!worker.apiKeyId) throw new Error('worker has no api_key configured');
  const apiKey = await getApiKeyById(worker.apiKeyId);
  if (!apiKey) throw new Error('api key not found or could not decrypt');

  const adapter = getImageGenAdapter(worker.provider);
  if (!adapter) {
    throw new Error(
      `no image_gen adapter for provider '${worker.provider}'. Currently wired: openai, xai, google, huggingface.`,
    );
  }
  const params = (worker.params ?? {}) as { size?: string; style?: string; quality?: string };
  const result = await adapter.generate({
    apiKey,
    prompt: prompt?.trim() || 'A friendly robot waving hello, watercolor style.',
    model: worker.model,
    size: overrides?.size ?? params.size,
    style: overrides?.style ?? params.style,
    quality: overrides?.quality ?? params.quality,
  });
  return {
    ok: true,
    imageBase64: result.bytes.toString('base64'),
    mimeType: result.mimeType,
    model: result.model,
    adapter: adapter.adapterName,
    revisedPrompt: result.revisedPrompt ?? null,
  };
}

/** Extract text/description from a user-supplied image via a vision worker. */
export async function testVision(
  userId: string,
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
  const worker = await getAiWorker(userId, workerId);
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
  const params = (worker.params ?? {}) as { extraction_prompt?: string; max_tokens?: number };
  const prompt =
    params.extraction_prompt?.trim() ||
    "Describe what's in this image in one or two sentences — the main subject, objects, logos, people, or scene. Then, if the image contains any text, transcribe it verbatim below the description (preserve line breaks; mark anything unclear as [unclear]). If there's no text, the description alone is enough. Output plain text only.";
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

/** Run a PDF through a document worker's native-extract path (base64 in). */
export async function testDocument(
  userId: string,
  workerId: string,
  pdfBase64: string,
): Promise<{
  ok: true;
  text: string;
  model: string;
  adapter: string;
  tokensIn: number | null;
  tokensOut: number | null;
}> {
  const worker = await getAiWorker(userId, workerId);
  if (!worker) throw new Error('worker not found');
  if (worker.kind !== 'document') throw new Error('worker is not a document worker');
  if (!worker.apiKeyId) throw new Error('worker has no api_key configured');
  const apiKey = await getApiKeyById(worker.apiKeyId);
  if (!apiKey) throw new Error('api key not found or could not decrypt');

  const adapter = getVisionAdapter(worker.provider);
  if (!adapter?.extractDocument) {
    throw new Error(
      `provider '${worker.provider}' has no native-PDF adapter. Native PDF is wired for: ` +
        `${nativeDocumentProviders().join(', ') || '(none)'}. Other providers rasterize at ingest.`,
    );
  }
  const bytes = Buffer.from(pdfBase64, 'base64');
  if (bytes.length === 0) throw new Error('empty PDF buffer');
  const params = (worker.params ?? {}) as { extraction_prompt?: string; max_tokens?: number };
  const result = await adapter.extractDocument(bytes, {
    apiKey,
    mimeType: 'application/pdf',
    prompt: params.extraction_prompt?.trim() || 'Transcribe this document in full, verbatim.',
    systemPrompt: worker.systemPrompt ?? undefined,
    model: worker.model,
    maxTokens: params.max_tokens ?? 8000,
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

/** One-shot prompt through a chat-shaped worker's adapter. */
export async function testChat(
  userId: string,
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
  const worker = await getAiWorker(userId, workerId);
  if (!worker) throw new Error('worker not found');
  if (!worker.apiKeyId) throw new Error('worker has no api_key configured');
  const apiKey = await getApiKeyById(worker.apiKeyId);
  if (!apiKey) throw new Error('api key not found or could not decrypt');

  const adapter = getChatAdapter(worker.provider);
  if (!adapter) {
    throw new Error(
      `No chat adapter registered for provider '${worker.provider}'. ` +
        `Register one in packages/voice/src/adapters/index.ts, or pick a ` +
        `wired provider (openrouter, anthropic, openai-via-openrouter, google, xai, huggingface).`,
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
    extra: params.huggingface_routing ? { routing: params.huggingface_routing } : undefined,
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
