/**
 * Builtin tools that delegate to ai_workers — the bridge between
 * Saskia's conversational agency and the modality-specific workers
 * (TTS, vision, summarizer).
 *
 * Design notes:
 *
 * 1. Modality-matched automatic pipelines still run as before
 *    (voice-in → voice-out, photo → vision ingest). These tools are
 *    for cases where the *model* decides to invoke a worker on its
 *    own initiative — e.g. "send that as a voice note", "look at the
 *    photo I sent yesterday again", "give me a TLDR of that note".
 *
 * 2. Each tool resolves the OWNER'S DEFAULT worker for its capability
 *    via getDefaultWorker(ownerId, kind). If no default exists or
 *    the worker is misconfigured, the tool returns a structured
 *    `{ok: false, error: '...'}` rather than throwing — the LLM sees
 *    the error and tells the user conversationally ("I'd love to,
 *    but you haven't set up a TTS worker yet").
 *
 * 3. `synthesize_speech` is the only one with a side effect on the
 *    outbound channel — it calls Telegram's sendVoice directly. It
 *    refuses on the web /assistant surface with a clear "Telegram
 *    only" message so the LLM falls back to a text reply.
 *
 * 4. `extract_from_image` and `summarize_text` are pure return-value
 *    tools: they hand back extracted/summarized text the LLM can
 *    then weave into its reply.
 */

import { and, eq, sql } from 'drizzle-orm';
import { db, nodes, getDefaultWorker, type AiWorkerKind } from '@mantle/db';
import { getApiKeyById } from '@mantle/api-keys';
import { accountForChat, downloadTelegramFile, sendPhoto, sendVoice } from '@mantle/telegram';
import { createFolder, dashToLtree, fileById, readFileById, upsertFile } from '@mantle/files';
import { getChatAdapter, getImageGenAdapter, getTtsAdapter, getVisionAdapter } from '@mantle/voice';
import type { ImageGenModelInfo, ImageGenParam, TtsParam } from '@mantle/voice';
import type { BuiltinToolDef, ToolArtifact, ToolHandlerResult, ToolPrecondition } from './types';
import { registerDynamicSchema } from './dynamic-schema';
import { notFound } from './errors';
import { str, strOpt, numOpt as num } from './coerce';
import { resolveImageParams } from './image-params';
import { errorMessage } from '@mantle/std';

// ─── shared helpers ────────────────────────────────────────────────

// Referential preconditions (checked centrally in dispatch — see
// preconditions.ts). `node_id` is optional on both tools (telegram_file_id /
// inline text are the alternatives), so the check is skipped when absent.
// extract_from_image reads image bytes from the file store, so its node must
// be a file; summarize_text accepts any node that carries content.
const IMAGE_FILE_ID_PRE: readonly ToolPrecondition[] = [
  { kind: 'node_exists', param: 'node_id', nodeType: 'file', lookup: 'file_list / search_nodes' },
];
const NODE_ID_PRE: readonly ToolPrecondition[] = [
  { kind: 'node_exists', param: 'node_id', lookup: 'search_nodes / tree_list' },
];

/**
 * Resolve `{worker, apiKey}` for a default worker of the given kind,
 * or return a structured error the tool can pass straight back to the
 * LLM. Centralised so every worker tool reports the same shape of
 * "not configured" message.
 */
export async function resolveDefaultWorker(
  ownerId: string,
  kind: AiWorkerKind,
): Promise<
  | { ok: true; worker: NonNullable<Awaited<ReturnType<typeof getDefaultWorker>>>; apiKey: string }
  | { ok: false; error: string }
> {
  const worker = await getDefaultWorker(ownerId, kind);
  if (!worker) {
    return {
      ok: false,
      error: `No default ${kind} worker configured. Create one at /settings/ai-workers and mark it default.`,
    };
  }
  if (!worker.apiKeyId) {
    return {
      ok: false,
      error: `The default ${kind} worker '${worker.slug}' has no api_key attached. Edit it at /settings/ai-workers.`,
    };
  }
  const apiKey = await getApiKeyById(worker.apiKeyId);
  if (!apiKey) {
    return {
      ok: false,
      error: `The api_key for ${kind} worker '${worker.slug}' could not be decrypted. Check /settings/api-keys.`,
    };
  }
  return { ok: true, worker, apiKey };
}

// ─── synthesize_speech ─────────────────────────────────────────────

const synthesize_speech: BuiltinToolDef = {
  slug: 'synthesize_speech',
  name: 'Send a voice reply',
  description:
    "Synthesize text-to-speech using the owner's default TTS worker. On Telegram it sends as a voice note; on the web /assistant it returns audio bytes that the page renders inline as a play-button bubble. Use when the user explicitly asks for audio ('send me a voice note', 'read that aloud') or when a long answer would land better as audio. After calling, write a brief text follow-up — don't repeat the spoken content verbatim.",
  inputSchema: {
    type: 'object',
    properties: {
      text: {
        type: 'string',
        minLength: 1,
        description:
          "The text to speak. Up to ~15k characters for xAI / 4k for OpenAI; the adapter trims if needed. Inline audio tags ([laughs], [whispers], etc.) work on TTS models that support them; check the worker's tag hint in the form.",
      },
      voice: {
        type: 'string',
        description:
          "Optional voice id override. Defaults to the worker's configured voice. Use ONLY when the user names a specific voice — otherwise omit.",
      },
    },
    required: ['text'],
  },
  handler: async (input, ctx): Promise<ToolHandlerResult> => {
    const text = str(input.text).trim();
    if (!text) return { ok: false, error: 'text required' };
    if (!ctx.surface) {
      return {
        ok: false,
        error:
          "synthesize_speech needs a delivery surface (Telegram chat or web /assistant). Background callers (reflector/extractor) shouldn't invoke this.",
      };
    }
    const resolved = await resolveDefaultWorker(ctx.ownerId, 'tts');
    if (!resolved.ok) return { ok: false, error: resolved.error };
    const { worker, apiKey } = resolved;

    const adapter = getTtsAdapter(worker.provider);
    if (!adapter) {
      return {
        ok: false,
        error: `No TTS adapter wired for provider '${worker.provider}'. Switch the default TTS worker to openai / elevenlabs / xai / google.`,
      };
    }
    const params = (worker.params ?? {}) as {
      voice?: string;
      speed?: number;
      instructions?: string;
      language?: string;
    };
    const voiceId = strOpt(input.voice) ?? params.voice ?? 'nova';
    // Surface-specific output container. Telegram wants opus (renders
    // as a voice-note bubble); the web <audio> element handles mp3
    // most consistently across browsers, including Safari which is
    // historically fussy about opus-in-ogg playback.
    const audioFormat: 'opus' | 'mp3' = ctx.surface.kind === 'telegram' ? 'opus' : 'mp3';

    let synth;
    try {
      synth = await adapter.synthesize({
        apiKey,
        text,
        // Cast through unknown: TtsVoice is OpenAI-shaped at the type
        // layer but at runtime adapters accept arbitrary strings (xAI
        // custom voice ids, ElevenLabs voice ids, …).
        voice: voiceId as unknown as never,
        model: worker.model,
        speed: params.speed ?? 1.0,
        format: audioFormat,
        instructions: params.instructions,
        language: params.language,
      });
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    }
    // Same honesty split as generate_image. TTS providers diverge hard here:
    // Gemini has no speed parameter at all, ElevenLabs takes a language code
    // on some models and not others, tts-1 ignores style instructions. An
    // operator who sets one of those in /settings/ai-workers and hears no
    // difference deserves to be told which, rather than doubting their ears.
    const ttsSupported = new Set<TtsParam>(adapter.supports);
    const ttsWarned = new Map((synth.warnings ?? []).map((w) => [w.param, w.reason]));
    const ttsIgnored: Array<{ key: string; value: string; reason?: string }> = [];
    const noteTts = (param: TtsParam, value: unknown) => {
      if (value === undefined || value === null || value === '') return;
      const reason = ttsWarned.get(param);
      if (!ttsSupported.has(param)) {
        ttsIgnored.push({ key: param, value: String(value) });
      } else if (reason) {
        ttsIgnored.push({ key: param, value: String(value), reason });
      }
    };
    noteTts('speed', params.speed);
    noteTts('format', audioFormat);
    noteTts('instructions', params.instructions);
    noteTts('language', params.language);

    ctx.step?.setMeta({
      adapter: adapter.adapterName,
      bytes: synth.bytes.length,
      voice: voiceId,
      worker_slug: worker.slug,
      surface: ctx.surface.kind,
      ...(ttsIgnored.length > 0
        ? {
            ignored_params: Object.fromEntries(
              ttsIgnored.map((i) => [i.key, i.reason ? `${i.value} (${i.reason})` : i.value]),
            ),
          }
        : {}),
    });
    const ttsIgnoredOutput =
      ttsIgnored.length > 0
        ? {
            ignoredParams: Object.fromEntries(
              ttsIgnored.map((i) => [i.key, i.reason ? `${i.value} (${i.reason})` : i.value]),
            ),
            ignoredParamsNote: `${worker.provider}/${synth.model} did not apply ${ttsIgnored
              .map((i) => i.key)
              .join(
                ', ',
              )} from the worker's saved settings. Mention it if the user asks why the delivery didn't change; changing it means switching the tts worker at /settings/ai-workers.`,
          }
        : {};

    if (ctx.surface.kind === 'telegram') {
      try {
        const account = await accountForChat(ctx.surface.telegramChatId);
        if (!account) {
          return {
            ok: false,
            error: `No Telegram account configured for chat ${ctx.surface.telegramChatId}.`,
          };
        }
        const tgMsgId = await sendVoice(account, ctx.surface.telegramChatId, synth.bytes, {
          replyTo: ctx.surface.replyToTelegramMessageId,
        });
        return {
          ok: true,
          output: {
            sent: true,
            deliveredVia: 'telegram',
            telegramMessageId: tgMsgId,
            voice: voiceId,
            model: synth.model,
            bytes: synth.bytes.length,
            ...ttsIgnoredOutput,
          },
        };
      } catch (err) {
        return { ok: false, error: errorMessage(err) };
      }
    }

    // Web /assistant: emit the audio as a sidecar artifact. The
    // turn endpoint forwards it; the client renders an <audio>
    // element inside the reply bubble. The LLM-visible output is
    // text-only metadata so it doesn't burn prompt budget on a base64
    // blob it can't usefully reason about.
    const artifact: ToolArtifact = {
      kind: 'audio',
      mimeType: synth.mimeType ?? 'audio/mpeg',
      base64: synth.bytes.toString('base64'),
      caption: text.length > 120 ? `${text.slice(0, 120)}…` : text,
      producedBy: 'synthesize_speech',
    };
    return {
      ok: true,
      output: {
        sent: true,
        deliveredVia: 'web',
        voice: voiceId,
        model: synth.model,
        bytes: synth.bytes.length,
        ...ttsIgnoredOutput,
      },
      artifacts: [artifact],
    };
  },
};

// ─── extract_from_image ────────────────────────────────────────────

const extract_from_image: BuiltinToolDef = {
  slug: 'extract_from_image',
  readOnly: true,
  name: 'Read text from an image',
  description:
    "Run the owner's default vision worker over an image and return the extracted text. Use when the user asks to re-read a previously-sent photo, OCR a file in their notes, or extract content from a specific image they reference. For photos that JUST arrived in this conversation, the agent's auto-ingest pipeline has already saved the transcript as a note — search_nodes for it before re-extracting.",
  preconditions: IMAGE_FILE_ID_PRE,
  inputSchema: {
    type: 'object',
    properties: {
      node_id: {
        type: 'string',
        description:
          'A node id pointing to a file row whose stored object is an image. Use this for previously-uploaded images.',
      },
      telegram_file_id: {
        type: 'string',
        description:
          'A Telegram file_id (from message attachments). Only useful inside a Telegram turn — refuses on the web surface.',
      },
      prompt: {
        type: 'string',
        description:
          "Optional override for the worker's configured extraction prompt. Defaults to verbatim transcription.",
      },
    },
  },
  handler: async (input, ctx): Promise<ToolHandlerResult> => {
    const nodeId = strOpt(input.node_id);
    const telegramFileId = strOpt(input.telegram_file_id);
    if (!nodeId && !telegramFileId) {
      return { ok: false, error: 'Provide either node_id or telegram_file_id.' };
    }
    if (nodeId && telegramFileId) {
      return { ok: false, error: 'Provide only one of node_id / telegram_file_id, not both.' };
    }

    const resolved = await resolveDefaultWorker(ctx.ownerId, 'vision');
    if (!resolved.ok) return { ok: false, error: resolved.error };
    const { worker, apiKey } = resolved;
    const adapter = getVisionAdapter(worker.provider);
    if (!adapter) {
      return {
        ok: false,
        error: `No vision adapter wired for '${worker.provider}'. Switch to openai / anthropic / google / xai.`,
      };
    }

    // ── resolve image bytes ──
    let bytes: Buffer;
    let mimeType: string;
    if (nodeId) {
      const file = await fileById({ ownerId: ctx.ownerId, fileId: nodeId });
      if (!file) return { ok: false, error: `Node ${nodeId} not found or not owned by you.` };
      const mime = file.mimeType ?? 'application/octet-stream';
      if (!mime.startsWith('image/')) {
        return { ok: false, error: `Node ${nodeId} is ${mime}, not an image.` };
      }
      const fetched = await readFileById({ ownerId: ctx.ownerId, fileId: nodeId });
      if (!fetched) {
        return { ok: false, error: `Couldn't read file ${nodeId} from storage.` };
      }
      bytes = fetched.bytes;
      mimeType = mime;
    } else {
      // telegram_file_id path
      if (!ctx.surface || ctx.surface.kind !== 'telegram') {
        return {
          ok: false,
          error: 'telegram_file_id only works inside a Telegram turn. Use node_id instead.',
        };
      }
      const account = await accountForChat(ctx.surface.telegramChatId);
      if (!account) {
        return {
          ok: false,
          error: `No Telegram account for chat ${ctx.surface.telegramChatId}.`,
        };
      }
      try {
        const downloaded = await downloadTelegramFile(account, telegramFileId!);
        bytes = downloaded.bytes;
        mimeType = downloaded.mimeType;
      } catch (err) {
        return { ok: false, error: errorMessage(err) };
      }
    }

    // ── extract ──
    const params = (worker.params ?? {}) as {
      extraction_prompt?: string;
      max_tokens?: number;
    };
    const prompt =
      strOpt(input.prompt) ??
      params.extraction_prompt?.trim() ??
      'Transcribe everything visible in this image verbatim, preserving line breaks and structure. If something is unclear, mark it [unclear]. Output plain text only.';

    try {
      const result = await adapter.extract(bytes, {
        apiKey,
        mimeType,
        prompt,
        systemPrompt: worker.systemPrompt ?? undefined,
        model: worker.model,
        maxTokens: params.max_tokens ?? 2000,
      });
      ctx.step?.setMeta({
        adapter: adapter.adapterName,
        worker_slug: worker.slug,
        bytes: bytes.length,
        text_length: result.text.length,
        tokens_in: result.tokensIn,
        tokens_out: result.tokensOut,
      });
      return {
        ok: true,
        output: {
          text: result.text,
          model: result.model,
          adapter: adapter.adapterName,
          tokens: { in: result.tokensIn ?? null, out: result.tokensOut ?? null },
        },
      };
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    }
  },
};

// ─── summarize_text ────────────────────────────────────────────────

const summarize_text: BuiltinToolDef = {
  slug: 'summarize_text',
  readOnly: true,
  name: 'Summarize a note or block of text',
  description:
    "Run the owner's default summarizer worker (a chat-shaped worker tuned for compression) over text — either inline content or a note's body. Use when the user asks for a TLDR, a recap of a long note, or a digest of something they pasted. For automatic chat-history summarization, the background summarizer already runs; don't call this for that.",
  preconditions: NODE_ID_PRE,
  inputSchema: {
    type: 'object',
    properties: {
      text: {
        type: 'string',
        description: 'Inline text to summarize. Provide this OR `node_id`, not both.',
      },
      node_id: {
        type: 'string',
        description:
          'The id (UUID) of a node whose content to summarize — from `search_nodes` / `note_list`. Works on any node carrying text content, not just notes. Provide this OR `text`, not both.',
      },
      focus: {
        type: 'string',
        description:
          'Optional steering for the summary (e.g. "action items only", "key decisions", "what changed"). Defaults to a neutral overview.',
      },
      max_words: {
        type: 'integer',
        description: 'Soft cap on summary length. Default 200.',
      },
    },
  },
  handler: async (input, ctx): Promise<ToolHandlerResult> => {
    const inlineText = strOpt(input.text);
    const nodeId = strOpt(input.node_id);
    if (!inlineText && !nodeId) {
      return { ok: false, error: 'Provide either text or node_id.' };
    }
    if (inlineText && nodeId) {
      return { ok: false, error: 'Provide only one of text / node_id, not both.' };
    }

    // Resolve source text.
    let source: string;
    if (nodeId) {
      const [row] = await db
        .select({ data: nodes.data, type: nodes.type, title: nodes.title })
        .from(nodes)
        .where(and(eq(nodes.id, nodeId), eq(nodes.ownerId, ctx.ownerId)))
        .limit(1);
      if (!row) return { ok: false, error: `Node ${nodeId} not found or not owned by you.` };
      const content = (row.data as { content?: string } | null)?.content ?? '';
      if (!content.trim()) {
        return { ok: false, error: `Node ${nodeId} has no content to summarize.` };
      }
      source = content;
    } else {
      source = inlineText!;
    }

    const resolved = await resolveDefaultWorker(ctx.ownerId, 'summarizer');
    if (!resolved.ok) return { ok: false, error: resolved.error };
    const { worker, apiKey } = resolved;
    // Summarizer is chat-shaped — invoke through the chat adapter for
    // the worker's provider. OpenRouter-routed summarizers aren't
    // wired through this path today; if the provider isn't in the
    // chat-adapter registry we tell the user.
    const adapter = getChatAdapter(worker.provider);
    if (!adapter) {
      return {
        ok: false,
        error: `Summarizer worker uses provider '${worker.provider}', which isn't wired as a chat adapter. Switch to xai / huggingface / anthropic / google.`,
      };
    }

    const focus = strOpt(input.focus);
    const maxWords = num(input.max_words, 200) ?? 200;
    const systemPrompt =
      worker.systemPrompt?.trim() ||
      `You are a precise summarizer. Output a clean ${maxWords}-word summary in the same language as the source. No preamble, no closing remarks — just the summary.`;
    const userPrompt = focus ? `${source}\n\n---\n\nFocus the summary on: ${focus}` : source;

    const params = (worker.params ?? {}) as {
      temperature?: number;
      max_tokens?: number;
    };
    try {
      const result = await adapter.chat({
        apiKey,
        model: worker.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: params.temperature ?? 0.3,
        maxTokens: params.max_tokens ?? Math.max(maxWords * 4, 600),
      });
      ctx.step?.setMeta({
        adapter: adapter.adapterName,
        worker_slug: worker.slug,
        source_length: source.length,
        summary_length: result.text.length,
        tokens_in: result.tokensIn,
        tokens_out: result.tokensOut,
      });
      return {
        ok: true,
        output: {
          summary: result.text,
          model: result.model,
          adapter: adapter.adapterName,
          tokens: { in: result.tokensIn ?? null, out: result.tokensOut ?? null },
        },
      };
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    }
  },
};

// ─── generate_image ────────────────────────────────────────────────

/** Slugify a prompt into a filename stem. Keeps a–z 0–9 and dashes,
 *  clamps to 60 chars so a long prompt doesn't blow the filename
 *  budget. Falls back to 'image' if nothing survives. */
function slugifyPrompt(prompt: string): string {
  const s = prompt
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return s.length > 0 ? s : 'image';
}

/** Map a Content-Type to a file extension. Image-gen providers return
 *  png/jpeg/webp; everything else is unexpected and we error out
 *  loudly rather than write a file with a wrong-extension name. */
function extForMime(mime: string): string {
  if (mime.includes('png')) return 'png';
  if (mime.includes('jpeg') || mime.includes('jpg')) return 'jpg';
  if (mime.includes('webp')) return 'webp';
  throw new Error(`generate_image: unsupported image mime '${mime}'`);
}

const GENERATED_IMAGES_FOLDER_SLUG = 'generated-images';
// ltree labels use underscores, not dashes — createFolder stores the
// dash slug as `generated_images`, so the path constant must match or the
// per-day subfolder's parent lookup fails ("parent folder not found").
const GENERATED_IMAGES_FOLDER_LTREE = `files.${dashToLtree(GENERATED_IMAGES_FOLDER_SLUG)}`;

/** Ensure /files/generated-images/<yyyy-mm-dd>/ exists. Returns the
 *  ltree path the file should land in. Idempotent — re-creating an
 *  existing folder is a no-op-with-error which we swallow. */
async function ensureGeneratedImagesDateFolder(ownerId: string): Promise<string> {
  // Top-level "Generated images" folder.
  const topPath = GENERATED_IMAGES_FOLDER_LTREE;
  const [topExists] = await db
    .select({ id: nodes.id })
    .from(nodes)
    .where(
      and(
        eq(nodes.ownerId, ownerId),
        eq(nodes.type, 'branch'),
        sql`${nodes.path}::text = ${topPath}`,
      ),
    )
    .limit(1);
  if (!topExists) {
    try {
      await createFolder({
        ownerId,
        parentPath: 'files',
        slug: GENERATED_IMAGES_FOLDER_SLUG,
        description: 'AI-generated images. Auto-created by the generate_image tool.',
      });
    } catch (err) {
      // Concurrent creation racing — swallow the unique-constraint
      // hit and keep going. Anything else re-throw.
      if (!(err instanceof Error) || !/duplicate|unique/i.test(err.message)) {
        throw err;
      }
    }
  }

  // Per-day subfolder so the top folder doesn't grow unboundedly.
  const today = new Date().toISOString().slice(0, 10); // 'YYYY-MM-DD'
  const datePath = `${topPath}.${today.replace(/-/g, '_')}`;
  const [dateExists] = await db
    .select({ id: nodes.id })
    .from(nodes)
    .where(
      and(
        eq(nodes.ownerId, ownerId),
        eq(nodes.type, 'branch'),
        sql`${nodes.path}::text = ${datePath}`,
      ),
    )
    .limit(1);
  if (!dateExists) {
    try {
      await createFolder({
        ownerId,
        parentPath: topPath,
        slug: today,
        description: `Generated images from ${today}.`,
      });
    } catch (err) {
      if (!(err instanceof Error) || !/duplicate|unique/i.test(err.message)) {
        throw err;
      }
    }
  }
  return datePath;
}

const generate_image: BuiltinToolDef = {
  slug: 'generate_image',
  name: 'Generate an image',
  description:
    "Generate an image from a prompt using the owner's default image_gen worker. The image is saved under /files/generated-images/<date>/ AND sent inline when running on Telegram. Use when the user asks for an illustration, mockup, sketch, or visual aid. Be concrete in the prompt — vague prompts produce vague images. After calling, summarise what you sent in one sentence (don't repeat the prompt verbatim).",
  inputSchema: {
    type: 'object',
    properties: {
      prompt: {
        type: 'string',
        minLength: 3,
        description:
          'The image prompt. Be specific — composition, subject, style, colour palette, lighting. Long prompts (300+ chars) are fine; the adapter trims if needed.',
      },
      // Every option below is REPLACED at toolset-assembly time by what the
      // owner's configured model actually accepts (see the dynamic-schema hook
      // at the foot of this file): unsupported options are removed outright and
      // the rest become enums. The static text here is the fallback for when
      // that resolution fails, so it stays deliberately generic — a hardcoded
      // per-provider list would go stale the moment a worker is switched.
      size: {
        type: 'string',
        description:
          "Output dimensions. Omit to use the size saved on the image_gen worker — pass one ONLY when the user asked for a specific size or shape, e.g. 'a wide banner'.",
      },
      aspect_ratio: {
        type: 'string',
        description: "Shape, e.g. '16:9'. Use instead of `size` when the user named a shape.",
      },
      style: {
        type: 'string',
        description: 'Style steering, where the model offers it.',
      },
      quality: {
        type: 'string',
        description: 'Quality tier. Higher tiers cost more and take longer.',
      },
      negative_prompt: {
        type: 'string',
        description: 'What the image should NOT contain.',
      },
      input_image_ids: {
        type: 'array',
        items: { type: 'string', format: 'uuid' },
        maxItems: 4,
        description:
          "File node ids of EXISTING images to edit or use as reference. Pass these to change a picture you already have ('make the sky orange', 'same house in winter') instead of describing it again from scratch — a fresh generation invents a different picture and bills for it. `prompt` then describes the CHANGE, not the whole scene.",
      },
    },
    required: ['prompt'],
  },
  handler: async (input, ctx): Promise<ToolHandlerResult> => {
    const prompt = str(input.prompt).trim();
    if (!prompt) return { ok: false, error: 'prompt required' };

    const resolved = await resolveDefaultWorker(ctx.ownerId, 'image_gen');
    if (!resolved.ok) return { ok: false, error: resolved.error };
    const { worker, apiKey } = resolved;
    const adapter = getImageGenAdapter(worker.provider);
    if (!adapter) {
      return {
        ok: false,
        error: `No image-gen adapter wired for '${worker.provider}'. Switch the default image_gen worker to openai / xai / google / huggingface.`,
      };
    }

    // Which options were asked for, which the adapter will forward, and which
    // must be reported as ignored. See image-params.ts for why this is its own
    // module: both field failures here were silent, not crashes.
    const { sent, ignored, get, supported } = resolveImageParams({
      input,
      worker,
      supports: adapter.supports,
    });

    // ── reference images (image-to-image) ──
    // Refused BEFORE the request, not warned about after: an adapter that
    // can't edit would happily generate something unrelated from the prompt
    // and charge for it, and "make the sky orange" coming back as a different
    // house is worse than an error.
    const inputImageIds = Array.isArray(input.input_image_ids)
      ? (input.input_image_ids as unknown[]).filter(
          (v): v is string => typeof v === 'string' && v.length > 0,
        )
      : [];
    const inputImages: Array<{ bytes: Buffer; mimeType: string; filename?: string }> = [];
    if (inputImageIds.length > 0) {
      if (!supported.has('inputImages')) {
        return {
          ok: false,
          error:
            `${worker.provider}/${worker.model} cannot edit an existing image, so nothing was generated ` +
            `(generating from the prompt alone would produce a different picture, not an edit). ` +
            `Switch the image_gen worker at /settings/ai-workers to OpenRouter, or to OpenAI with gpt-image-1.`,
        };
      }
      for (const id of inputImageIds) {
        const file = await fileById({ ownerId: ctx.ownerId, fileId: id });
        if (!file) return notFound('file', id, 'file_list / search_nodes');
        const mime = file.mimeType ?? 'application/octet-stream';
        if (!mime.startsWith('image/')) {
          return {
            ok: false,
            error: `'input_image_ids' entry ${id} is ${mime}, not an image. Pass the id of an image file (find it with file_list / search_nodes).`,
          };
        }
        const fetched = await readFileById({ ownerId: ctx.ownerId, fileId: id });
        if (!fetched) return { ok: false, error: `Couldn't read file ${id} from storage.` };
        inputImages.push({ bytes: fetched.bytes, mimeType: mime, filename: file.filename });
      }
    }

    let result;
    try {
      result = await adapter.generate({
        apiKey,
        prompt,
        model: worker.model,
        ...(inputImages.length > 0 ? { inputImages } : {}),
        size: get('size'),
        aspectRatio: get('aspectRatio'),
        style: get('style'),
        quality: get('quality'),
        negativePrompt: get('negativePrompt'),
      });
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    }

    // The adapter gets the last word. `supports` is per-provider, but several
    // gates are per-MODEL (OpenAI takes `style` on dall-e-3 and not on
    // gpt-image-1), and only the adapter knows which model ran. Anything it
    // reports back moves from "applied" to "ignored" before we tell anyone
    // the request was honoured.
    const adapterWarned = new Map(
      (result.warnings ?? []).map((w) => [w.param as ImageGenParam, w.reason]),
    );
    const applied = sent.filter((s) => !adapterWarned.has(s.param));
    for (const s of sent) {
      const reason = adapterWarned.get(s.param);
      if (reason) ignored.push({ ...s, reason });
    }

    // Persist as a file node under /files/generated-images/<date>/.
    // Naming: <unix-ms>-<slug>.<ext>. The unix prefix keeps natural
    // sort = chronological; the slug gives a human-readable hint of
    // the prompt.
    //
    // Title + prompt are set explicitly because the filename alone makes the
    // image UNFINDABLE. `nodes.search_tsv` weights title A and data B, but a
    // slug filename tokenizes as ONE long hyphenated term, so an FTS query of
    // the prompt's own words missed it; the vector arm can't help either until
    // the extractor has run. A freshly generated image was therefore invisible
    // to `search_nodes` on both arms in the very turn that most needs it — the
    // follow-up "put that image in a page".
    let nodeId: string | null = null;
    let storagePath: string | null = null;
    try {
      const parentPath = await ensureGeneratedImagesDateFolder(ctx.ownerId);
      const ext = extForMime(result.mimeType);
      const filename = `${Date.now()}-${slugifyPrompt(prompt)}.${ext}`;
      const file = await upsertFile({
        ownerId: ctx.ownerId,
        parentPath,
        filename,
        bytes: result.bytes,
        overwrite: false,
        title: prompt.length > 120 ? `${prompt.slice(0, 120)}…` : prompt,
        data: {
          generated_by: 'generate_image',
          prompt,
          model: result.model,
          ...(result.revisedPrompt ? { revised_prompt: result.revisedPrompt } : {}),
        },
      });
      nodeId = file.id;
      storagePath = `${parentPath}/${filename}`;
    } catch (err) {
      // File save failure is non-fatal for the tool — the image was
      // generated successfully, and on Telegram we can still deliver
      // it inline. Log it in the trace meta so it doesn't vanish.
      ctx.step?.setMeta({
        file_save_error: errorMessage(err),
      });
    }

    // Telegram delivery.
    let telegramMessageId: number | null = null;
    if (ctx.surface?.kind === 'telegram') {
      try {
        const account = await accountForChat(ctx.surface.telegramChatId);
        if (account) {
          const caption =
            result.revisedPrompt && result.revisedPrompt !== prompt
              ? `🎨 ${prompt}\n(rendered as: ${result.revisedPrompt})`
              : `🎨 ${prompt}`;
          telegramMessageId = await sendPhoto(account, ctx.surface.telegramChatId, result.bytes, {
            replyTo: ctx.surface.replyToTelegramMessageId,
            caption,
          });
        }
      } catch (err) {
        // Mirror the file-save handling — failure to deliver doesn't
        // void the rest of the tool's work, but we should surface it
        // in the trace so the operator sees what happened.
        ctx.step?.setMeta({
          telegram_send_error: errorMessage(err),
        });
      }
    }

    ctx.step?.setMeta({
      adapter: adapter.adapterName,
      worker_slug: worker.slug,
      bytes: result.bytes.length,
      mime: result.mimeType,
      model: result.model,
      saved_as: storagePath,
      telegram_message_id: telegramMessageId,
      ...(inputImages.length > 0 ? { edited_from: inputImageIds } : {}),
      applied_params: Object.fromEntries(applied.map((a) => [a.key, a.value])),
      // Present ONLY when something was asked for and not sent. An empty key
      // here is the whole point: "no news" has to mean "everything applied".
      ...(ignored.length > 0
        ? { ignored_params: Object.fromEntries(ignored.map((i) => [i.key, i.value])) }
        : {}),
    });

    // Emit the image as a sidecar artifact regardless of surface.
    // Telegram surface uses sendPhoto for in-chat delivery (above);
    // the web /assistant uses this artifact for inline rendering;
    // background callers ignore it. The base64 cost is acceptable —
    // an AI-generated 1024² PNG is ~1MB, which fits inline in our
    // turn-response JSON without trouble.
    const artifact: ToolArtifact = {
      kind: 'image',
      mimeType: result.mimeType,
      base64: result.bytes.toString('base64'),
      caption: prompt.length > 120 ? `${prompt.slice(0, 120)}…` : prompt,
      ...(nodeId ? { nodeId } : {}),
      producedBy: 'generate_image',
    };

    return {
      ok: true,
      output: {
        nodeId,
        storagePath,
        // The exact string to paste to place this picture in a page or reply.
        // Handing it over beats making the model reconstruct an id it can only
        // see truncated elsewhere (the corpus map shows `file#<8 chars>`).
        ...(nodeId
          ? {
              inlineRef: `![${prompt.slice(0, 80)}](media:${nodeId})`,
              inlineRefNote:
                'To place this image in a page or a later reply, paste inlineRef verbatim. Copy the id whole — never rebuild it from a shortened form.',
            }
          : {}),
        model: result.model,
        adapter: adapter.adapterName,
        mimeType: result.mimeType,
        bytes: result.bytes.length,
        // A new file either way: an edit does not overwrite its reference, so
        // the original is still there to go back to.
        ...(inputImageIds.length > 0 ? { editedFrom: inputImageIds } : {}),
        ...(applied.length > 0
          ? { appliedParams: Object.fromEntries(applied.map((a) => [a.key, a.value])) }
          : {}),
        // Surfaced to the MODEL, not just the trace: if the user asked for a
        // 16:9 banner and the configured model cannot do ratios, the reply has
        // to say so rather than present a square image as what was asked for.
        ...(ignored.length > 0
          ? {
              ignoredParams: Object.fromEntries(
                ignored.map((i) => [i.key, i.reason ? `${i.value} (${i.reason})` : i.value]),
              ),
              ignoredParamsNote: `${worker.provider}/${worker.model} does not accept ${ignored
                .map((i) => i.key)
                .join(
                  ', ',
                )}, so ${ignored.some((i) => i.fromCall) ? 'the request was rendered without it — say so plainly rather than implying it applied' : 'the saved worker default had no effect'}. Change the image_gen worker at /settings/ai-workers to a model that supports it.`,
            }
          : {}),
        ...(result.revisedPrompt ? { revisedPrompt: result.revisedPrompt } : {}),
        ...(telegramMessageId != null ? { telegramMessageId, deliveredVia: 'telegram' } : {}),
        ...(ctx.surface?.kind === 'web'
          ? { deliveredVia: 'web', note: 'Rendered inline in the assistant reply.' }
          : {}),
      },
      artifacts: [artifact],
    };
  },
};

// ─── generate_image: schema that matches the CONFIGURED model ───────
//
// Which sizes are valid depends on the owner's default image_gen worker, which
// is runtime state the model cannot see. Stating the options in prose was the
// old answer, and it failed in both directions: the prose went stale against
// whatever worker was actually configured, and the model still had to guess
// which provider it was talking to. Here the schema is rebuilt once per turn
// from the worker's own catalog entry, so a wrong value is unrepresentable
// rather than merely discouraged (the `invoke_agent` pattern — see
// dynamic-schema.ts). A hook failure falls back to the static schema, so a
// missing worker or an unwired provider never breaks a turn.

/** Map a tool param key to the adapter capability that gates it. */
const IMAGE_PARAM_BY_KEY: Readonly<Record<string, ImageGenParam>> = {
  size: 'size',
  aspect_ratio: 'aspectRatio',
  style: 'style',
  quality: 'quality',
  negative_prompt: 'negativePrompt',
  input_image_ids: 'inputImages',
};

/** Catalog enums, keyed by tool param. */
function enumForKey(key: string, entry: ImageGenModelInfo | undefined): readonly string[] | null {
  if (!entry) return null;
  if (key === 'size') return entry.supportedSizes ?? null;
  if (key === 'aspect_ratio') return entry.supportedAspectRatios ?? null;
  if (key === 'style') return entry.supportedStyles ?? null;
  if (key === 'quality') return entry.supportedQualities ?? null;
  return null;
}

/** Options whose absence from a model's catalog entry means the MODEL has no
 *  such control, so the option should vanish rather than appear unconstrained.
 *
 *  The distinction matters: an absent `supportedSizes` means "free-form, the
 *  model decides" (HF repos), but an absent `supportedStyles` means "there is
 *  no style knob here". Treating them alike is how a `style` stayed offered on
 *  gpt-image-1 — `supports` is per-provider and OpenAI-the-provider does have
 *  style, on a different model. The adapter would then drop it at request
 *  time, which is a warning we can avoid ever needing. */
const CATALOG_GATED = new Set(['style', 'quality', 'aspect_ratio']);

/** Return a COPY of the generate_image parameters with every option the
 *  configured model can't take REMOVED, and the rest constrained to its
 *  catalog values. Copies rather than mutates: `inputSchema` is a module
 *  singleton shared across every agent and turn. Exported for tests. */
export function withImageModelSchema(
  schema: Record<string, unknown>,
  supports: readonly ImageGenParam[],
  entry: ImageGenModelInfo | undefined,
  label: string,
): Record<string, unknown> {
  const props = (schema.properties as Record<string, unknown> | undefined) ?? {};
  const supported = new Set(supports);
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(props)) {
    const param = IMAGE_PARAM_BY_KEY[key];
    // `prompt` and anything unmapped is always kept.
    if (!param) {
      next[key] = value;
      continue;
    }
    if (!supported.has(param)) continue; // the provider can't take it: don't offer it
    const values = enumForKey(key, entry);
    // Catalog-gated and this model lists none: it has no such knob. Only drop
    // when the model IS in the catalog — an unknown model tells us nothing,
    // and hiding every option on it would be worse than offering them.
    if (!values && entry && CATALOG_GATED.has(key)) continue;
    const base = (value as Record<string, unknown>) ?? {};
    next[key] = values
      ? {
          ...base,
          enum: [...values],
          description:
            `${String(base.description ?? '')} ${label} accepts: ${values.join(', ')}.`.trim(),
        }
      : base;
  }
  return { ...schema, properties: next };
}

registerDynamicSchema('generate_image', async (current, ctx) => {
  const worker = await getDefaultWorker(ctx.ownerId, 'image_gen');
  if (!worker) return null;
  const adapter = getImageGenAdapter(worker.provider);
  if (!adapter) return null;
  const entry = adapter.staticCatalog().find((m) => m.id === worker.model);
  return {
    parameters: withImageModelSchema(
      current.parameters,
      adapter.supports,
      entry,
      `${worker.provider}/${worker.model}`,
    ),
  };
});

export const WORKER_DELEGATION_TOOLS: readonly BuiltinToolDef[] = [
  synthesize_speech,
  extract_from_image,
  summarize_text,
  generate_image,
];
