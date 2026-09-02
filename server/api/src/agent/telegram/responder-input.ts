/**
 * Telegram turn: what the responder is asked. Attachment → responder input
 * (transcript-default, shared with web via decideImageRouting): prefer the
 * inline-extracted text folded into the turn; for an IMAGE with no
 * transcript, fall back to inlining the raw pixels when the model is
 * vision-capable and within its size limit. The node id is surfaced either
 * way so the responder can re-read it (extract_from_image / file_read) on a
 * follow-up. `responderUserText` is the text-only form — also the retry
 * fallback if the responder chokes on the raw picture (parity with web, b2).
 * Split out of runtime.ts on 2026-09-02 (audit, bloat B2).
 */
import { buildAttachmentContextText, type UserImage } from '@mantle/runtime/agent';
import { decideImageRouting } from '@mantle/runtime/assistant';
import { telegramCaption } from './helpers';
import type { AttachmentContext } from './types';

export interface ResponderInput {
  responderUserText: string;
  imagePrimaryText: string;
  userImage: UserImage | undefined;
  canSeeImage: boolean;
}

export function buildResponderInput(args: {
  rowText: string;
  model: string;
  attachmentContext: AttachmentContext | null;
}): ResponderInput {
  const { rowText, model, attachmentContext } = args;
  if (!attachmentContext) {
    return {
      responderUserText: rowText,
      imagePrimaryText: rowText,
      userImage: undefined,
      canSeeImage: false,
    };
  }
  const caption = telegramCaption(rowText);
  const baseText =
    caption ||
    (attachmentContext.kind === 'image'
      ? "Here's an image — tell me what you see."
      : "I've attached a file — take a look and tell me what's in it.");
  const canSeeImage = decideImageRouting({
    model,
    hasImage: attachmentContext.kind === 'image',
    imageBytes: attachmentContext.bytes.length,
    hasTranscript: attachmentContext.transcript.trim().length > 0,
    logPrefix: '[agent]',
  });
  const responderUserText = buildAttachmentContextText(baseText, {
    kind: attachmentContext.kind,
    transcript: attachmentContext.transcript,
    note: attachmentContext.note,
    nodeId: attachmentContext.nodeId,
    filename: attachmentContext.filename,
  });
  return {
    responderUserText,
    imagePrimaryText: canSeeImage ? baseText : rowText,
    userImage: canSeeImage
      ? { base64: attachmentContext.bytes.toString('base64'), mimeType: attachmentContext.mimeType }
      : undefined,
    canSeeImage,
  };
}
