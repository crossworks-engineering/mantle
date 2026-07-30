/**
 * Showing a stored image to the person you're talking to.
 *
 * Every other image tool in the stack turns pixels into words —
 * `extract_from_image` OCRs, the vision worker describes. This one goes the
 * other way, and exists because some answers cannot be said. A manual's
 * screenshot of a settings screen, a wiring diagram, a chart: describing them
 * is a poor substitute for putting them in front of someone. Since the
 * extractor now pulls those pictures out of documents and stores them as
 * ordinary image files, the missing piece was simply the ability to hand one
 * back.
 *
 * Nothing is generated, fetched or transformed here — this only re-serves
 * bytes the owner already has, addressed by node id.
 *
 * ## Surfaces
 *
 * Web `/assistant` renders a `ToolArtifact` inline in the reply bubble;
 * Telegram has no artifact channel and needs an explicit `sendPhoto`, exactly
 * as `generate_image` does. Both are covered, because a tool that silently
 * shows nothing on one of the two surfaces is worse than one that refuses.
 *
 * In Pages the agent doesn't call this at all — it writes
 * `![alt](media:<file-id>)`, which the Pages dialect already resolves to the
 * stored file. Same node id, different surface.
 */

import { fileById, readFileById } from '@mantle/files';
import { accountForChat, sendPhoto } from '@mantle/telegram';
import { nodeUrl } from '@mantle/content';
import type { BuiltinToolDef, ToolArtifact, ToolHandlerResult, ToolPrecondition } from './types';
import { str } from './coerce';
import { notFound } from './errors';

const IMAGE_FILE_ID_PRE: readonly ToolPrecondition[] = [
  {
    kind: 'node_exists',
    param: 'file_id',
    nodeType: 'file',
    lookup: 'search_nodes / file_list',
  },
];

/** Ceiling on what we'll inline as base64 in a turn response. Extracted
 *  document images are screenshots and diagrams — comfortably under this —
 *  but a full-page scan can be much larger, and a 20 MB base64 blob in the
 *  reply JSON would hurt every surface that has to carry it. */
const MAX_INLINE_IMAGE_BYTES = 6_000_000;

const show_image: BuiltinToolDef = {
  slug: 'show_image',
  name: 'Show an image',
  description:
    "Display a stored image inline in the conversation; returns the file's metadata and renders the picture in the reply. Use whenever the answer is visual and words are a poor substitute — a diagram, a screenshot of a UI step, a chart. Images pulled out of documents (tagged `extracted-image`) are the common case: locate one with `search_nodes`, then show it instead of describing it. **To quote a document's text use `file_read`; to put an image INTO a page write `![alt](media:<file-id>)` rather than calling this.** Re-serves stored bytes only — generates nothing.",
  preconditions: IMAGE_FILE_ID_PRE,
  inputSchema: {
    type: 'object',
    properties: {
      file_id: {
        type: 'string',
        format: 'uuid',
        description:
          "The image file's node id (UUID) — from `search_nodes` / `file_list`. Must be a file whose stored bytes are an image.",
      },
      caption: {
        type: 'string',
        description:
          "Optional one-line caption shown with the image. Defaults to the file's own title, which for an extracted document image already names the document and the step.",
      },
    },
    required: ['file_id'],
  },
  handler: async (input, ctx): Promise<ToolHandlerResult> => {
    const fileId = str(input.file_id);
    if (!fileId) return { ok: false, error: 'file_id required' };

    const meta = await fileById({ ownerId: ctx.ownerId, fileId });
    if (!meta) return notFound('file', fileId, 'search_nodes / file_list');

    const mimeType = meta.mimeType ?? 'application/octet-stream';
    if (!mimeType.startsWith('image/')) {
      return {
        ok: false,
        error: `file ${fileId} is ${mimeType}, not an image — show_image can only display images. To read this file's text use file_read; to find the images extracted from it, search_nodes for tag 'extracted-image'.`,
      };
    }

    const fetched = await readFileById({ ownerId: ctx.ownerId, fileId });
    if (!fetched) {
      return {
        ok: false,
        error: `file ${fileId} has no readable bytes in storage (the node exists but its object is missing). Pick a different image with search_nodes, or tell the user the original is unavailable.`,
      };
    }
    if (fetched.bytes.length > MAX_INLINE_IMAGE_BYTES) {
      // Deliberately not a silent downscale: resampling someone's diagram
      // without saying so is its own bug. Link it instead.
      return {
        ok: false,
        error: `That image is ${Math.round(fetched.bytes.length / 1_000_000)} MB, too large to show inline. Link the user to ${nodeUrl(fileId)} instead.`,
      };
    }

    const caption = str(input.caption) || meta.title || undefined;

    // Telegram delivery — no artifact channel on that surface.
    let telegramMessageId: number | null = null;
    if (ctx.surface?.kind === 'telegram') {
      try {
        const account = await accountForChat(ctx.surface.telegramChatId);
        if (account) {
          telegramMessageId = await sendPhoto(account, ctx.surface.telegramChatId, fetched.bytes, {
            replyTo: ctx.surface.replyToTelegramMessageId,
            ...(caption ? { caption } : {}),
          });
        }
      } catch (err) {
        // Mirrors generate_image: a delivery failure is surfaced on the trace
        // but doesn't void the call — the artifact below may still land.
        ctx.step?.setMeta({
          telegram_send_error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    ctx.step?.setMeta({
      file_id: fileId,
      bytes: fetched.bytes.length,
      mime: mimeType,
      telegram_message_id: telegramMessageId,
    });

    const artifact: ToolArtifact = {
      kind: 'image',
      mimeType,
      base64: fetched.bytes.toString('base64'),
      nodeId: fileId,
      ...(caption ? { caption } : {}),
      producedBy: 'show_image',
    };

    return {
      ok: true,
      // Metadata only — the LLM should reason about "I showed them the
      // diagram", not carry a megabyte of base64 it can't read.
      output: {
        shown: true,
        fileId,
        title: meta.title,
        mimeType,
        bytes: fetched.bytes.length,
        url: nodeUrl(fileId),
        ...(telegramMessageId != null
          ? { telegramMessageId, deliveredVia: 'telegram' }
          : { deliveredVia: 'web', note: 'Rendered inline in the assistant reply.' }),
      },
      artifacts: [artifact],
    };
  },
};

export const IMAGE_TOOLS: readonly BuiltinToolDef[] = [show_image];
