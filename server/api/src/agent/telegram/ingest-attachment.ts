/**
 * Telegram turn, stage: attachment ingest. A photo OR a document is saved to
 * /files as a real file node (the extractor owns durable metadata) and
 * extracted inline for THIS turn's reply. Runs in its own photo_ingest /
 * content_ingest trace; the responder turn gets its own. Returns null when
 * the bytes could not be fetched, so the sequencer can apologise instead of
 * crashing the turn. Split out of runtime.ts on 2026-09-02 (audit, bloat B2).
 */
import { accountById, downloadTelegramFile } from '@mantle/telegram';
import { ensureDatedUploadFolder, upsertFile } from '@mantle/files';
import { recordIngest, startTrace, step } from '@mantle/tracing';
import { extractAttachmentForTurn } from '@mantle/agent-runtime';
import { errorMessage } from '@mantle/std';
import { telegramCaption } from './helpers';
import type { AttachmentContext, FileAttachment, InboundRow } from './types';

export async function ingestTelegramAttachment(args: {
  ownerId: string;
  row: InboundRow;
  fileAttachment: FileAttachment;
}): Promise<AttachmentContext | null> {
  const { ownerId, row, fileAttachment } = args;
  const isPhoto = fileAttachment.kind === 'photo';
  const caption = telegramCaption(row.text);
  return startTrace(
    {
      kind: isPhoto ? 'photo_ingest' : 'content_ingest',
      ownerId,
      subjectId: row.id,
      subjectKind: 'telegram_message',
      data: {
        telegramChatId: row.telegramChatId,
        fileId: fileAttachment.file_id,
        attachmentKind: fileAttachment.kind,
      },
    },
    async () => {
      const account = await accountById(row.accountId);
      if (!account) {
        console.error('[agent] no telegram account for attachment download', row.telegramChatId);
        return null;
      }
      let downloaded: Awaited<ReturnType<typeof downloadTelegramFile>>;
      try {
        downloaded = await step(
          { name: 'download_file', kind: 'compute', input: { fileId: fileAttachment.file_id } },
          async (h) => {
            const file = await downloadTelegramFile(account, fileAttachment.file_id);
            h.setMeta({ bytes: file.bytes.length, mime: file.mimeType });
            return file;
          },
        );
      } catch (err) {
        // Transient download failure (network / Telegram 5xx). Return null
        // so the caller can apologise instead of crashing the turn.
        console.error('[agent] telegram attachment download failed:', errorMessage(err));
        return null;
      }

      // Documents declare their own name + mime; photos have neither, so
      // derive from the caption + detected mime.
      const mimeType = fileAttachment.mime || downloaded.mimeType;
      const ext = (mimeType.split('/')[1] || 'bin').replace(/[^a-z0-9]/gi, '') || 'bin';
      const baseName =
        fileAttachment.name?.trim() ||
        `${
          (caption || (isPhoto ? 'photo' : 'file'))
            .toLowerCase()
            .replace(/[^\w-]+/g, '-')
            .slice(0, 60)
            .replace(/^-+|-+$/g, '') || (isPhoto ? 'photo' : 'file')
        }.${ext}`;

      // Save the bytes as a real file node first — even if extraction fails
      // we want the file persisted + searchable in /files.
      let nodeId: string | null = null;
      try {
        const parentPath = await ensureDatedUploadFolder({
          ownerId,
          topSlug: 'telegram-uploads',
          topDescription: 'Files sent to Saskia on Telegram. Auto-created.',
        });
        const filename = `${Date.now()}-${baseName}`;
        const saved = await step({ name: 'persist_file', kind: 'db_write' }, async (h) => {
          const file = await upsertFile({
            ownerId,
            parentPath,
            filename,
            bytes: downloaded.bytes,
            overwrite: false,
          });
          h.setMeta({ nodeId: file.id, filename, bytes: file.sizeBytes });
          return file;
        });
        nodeId = saved.id;
        void recordIngest({
          source: 'telegram_upload',
          ownerId,
          nodeId: saved.id,
          summary: `${isPhoto ? 'Image' : 'File'} received via Telegram: ${filename}`,
          payload: {
            chatId: row.telegramChatId,
            telegramMessageId: row.telegramMessageId,
            filename,
            mimeType,
            sizeBytes: saved.sizeBytes,
          },
        });
      } catch (err) {
        console.error('[agent] telegram attachment save failed:', errorMessage(err));
      }

      // Inline extraction for THIS turn's reply (question-aware vision for
      // images, doc parse for files) via the shared helper. Durable metadata
      // is the extractor's job, fired by the save above.
      const extract = await step(
        {
          name: 'extract_attachment',
          kind: 'llm_call',
          input: {
            mime: mimeType,
            bytes: downloaded.bytes.length,
            hasQuestion: caption.length > 0,
          },
        },
        async (h) => {
          const r = await extractAttachmentForTurn({
            ownerId,
            bytes: downloaded.bytes,
            mimeType,
            filename: baseName,
            question: caption || undefined,
          });
          h.setMeta({ attachmentKind: r.kind, note: r.note, textLength: r.text.length });
          return r;
        },
      );

      return {
        kind: extract.kind === 'image' ? ('image' as const) : ('file' as const),
        transcript: extract.text,
        note: extract.note,
        nodeId,
        bytes: downloaded.bytes,
        mimeType,
        filename: baseName,
      };
    },
  );
}
