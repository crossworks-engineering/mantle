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
import type {
  BuiltinToolDef,
  ToolArtifact,
  ToolHandlerContext,
  ToolHandlerResult,
  ToolPrecondition,
} from './types';

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

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}
function strOpt(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}
function num(v: unknown, dflt?: number): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  return dflt;
}

/**
 * Resolve `{worker, apiKey}` for a default worker of the given kind,
 * or return a structured error the tool can pass straight back to the
 * LLM. Centralised so every worker tool reports the same shape of
 * "not configured" message.
 */
async function resolveDefaultWorker(
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
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    ctx.step?.setMeta({
      adapter: adapter.adapterName,
      bytes: synth.bytes.length,
      voice: voiceId,
      worker_slug: worker.slug,
      surface: ctx.surface.kind,
    });

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
          },
        };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
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
      },
      artifacts: [artifact],
    };
  },
};

// ─── extract_from_image ────────────────────────────────────────────

const extract_from_image: BuiltinToolDef = {
  slug: 'extract_from_image',
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
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
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
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
};

// ─── summarize_text ────────────────────────────────────────────────

const summarize_text: BuiltinToolDef = {
  slug: 'summarize_text',
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
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
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
      size: {
        type: 'string',
        description:
          "Resolution like '1024x1024' or '1792x1024'. Provider-specific (OpenAI gpt-image-1: 1024x1024 / 1024x1536 / 1536x1024; DALL-E 3: 1024x1024 / 1024x1792 / 1792x1024; Imagen: 1024x1024 / 1408x768 / 768x1408). Adapter rejects unsupported sizes with a clear error.",
      },
      style: {
        type: 'string',
        description: "Style hint, currently only honoured by DALL-E 3 ('vivid' | 'natural').",
      },
      quality: {
        type: 'string',
        description:
          "Quality tier — DALL-E 3: 'standard' | 'hd'; gpt-image-1: 'low' | 'medium' | 'high' | 'auto'.",
      },
      negative_prompt: {
        type: 'string',
        description:
          'What the image should NOT contain. Honoured by Imagen + HF; OpenAI silently ignores.',
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

    const params = (worker.params ?? {}) as {
      size?: string;
      style?: string;
      quality?: string;
    };

    let result;
    try {
      result = await adapter.generate({
        apiKey,
        prompt,
        model: worker.model,
        size: strOpt(input.size) ?? params.size,
        style: strOpt(input.style) ?? params.style,
        quality: strOpt(input.quality) ?? params.quality,
        negativePrompt: strOpt(input.negative_prompt),
      });
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }

    // Persist as a file node under /files/generated-images/<date>/.
    // Naming: <unix-ms>-<slug>.<ext>. The unix prefix keeps natural
    // sort = chronological; the slug gives a human-readable hint of
    // the prompt.
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
      });
      nodeId = file.id;
      storagePath = `${parentPath}/${filename}`;
    } catch (err) {
      // File save failure is non-fatal for the tool — the image was
      // generated successfully, and on Telegram we can still deliver
      // it inline. Log it in the trace meta so it doesn't vanish.
      ctx.step?.setMeta({
        file_save_error: err instanceof Error ? err.message : String(err),
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
          telegram_send_error: err instanceof Error ? err.message : String(err),
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
        model: result.model,
        adapter: adapter.adapterName,
        mimeType: result.mimeType,
        bytes: result.bytes.length,
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

export const WORKER_DELEGATION_TOOLS: readonly BuiltinToolDef[] = [
  synthesize_speech,
  extract_from_image,
  summarize_text,
  generate_image,
];
