/**
 * Files on messenger lines (fleet chat phase 1, plan page f2f19c7b section
 * 8): the bytes of messenger_attachments (0335 made the table and its read
 * rule; this fills it).
 *
 *  - **Upload.** A live participant uploads one file to a chat: the bytes
 *    go to the object store by their sha256, through the files store's
 *    broker (stageFileObject), and a row ties them to the chat, with no line yet.
 *    The send claims it (messenger.ts claimAttachments). The caps are the
 *    Send to IT numbers: 10 MB per file, 5 per line, the task file types
 *    (no svg or html). Nothing is read into the brain: no parser, no model.
 *  - **Read.** Who reads the line reads the file: the row is read in the
 *    login's scope, where its row security asks the line's (an unsent file:
 *    its uploader only). There is no Admin exception, as for the chat.
 *  - **Save to Files.** A reader copies one file into a folder of Files, in
 *    the login's own scope: the folder's create right is the login's own,
 *    as an upload by hand.
 *
 * A file a line carried to a handle's group, or back, is a new row on the
 * same stored bytes (messenger.ts copyAttachments). No row is deleted
 * here, and nothing deletes the bytes: never thrown away.
 */
import { Readable } from 'node:stream';
import { sql } from 'drizzle-orm';
import { db } from '@mantle/db';
import { TASK_FILE_EXTS, isTaskFileType } from '@mantle/client-types/task-files';
import {
  extOf,
  mimeForExt,
  sanitizeFilename,
  upsertFile,
  type FileRow,
  type SpooledUpload,
} from '@mantle/files';
import { getContent } from '@mantle/storage';
import { stageFileObject, stageSpooledObject } from '@mantle/files/broker';
import { InputError, isUuid } from '@mantle/std';
import {
  MESSENGER_ATTACHMENT_MAX_BYTES,
  MessengerNotFoundError,
  addMessengerAttachmentRow,
  q,
  takeBudget,
  type MessengerActor,
  type MessengerAttachmentView,
} from './messenger';

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);

/** Why a file may not go on a line, or null when it may. Pure: the route
 *  and the tool ask it before anything is stored. */
export function messengerFileRefusal(filename: string, sizeBytes: number): string | null {
  if (!isTaskFileType(filename)) {
    return `A chat file is one of these types: ${TASK_FILE_EXTS.join(', ')}.`;
  }
  if (sizeBytes <= 0) return 'The file is empty.';
  if (sizeBytes > MESSENGER_ATTACHMENT_MAX_BYTES) {
    return `Too big. A chat file is at most ${MESSENGER_ATTACHMENT_MAX_BYTES / 1024 / 1024} MB.`;
  }
  return null;
}

/**
 * Upload one file to a chat the actor is in, for a line it will send:
 * `bytes` (MCP) or a spooled upload (the route, read as a stream). Answers
 * the file as a line shows it; its id goes in the send's `attachments`.
 */
export async function uploadMessengerAttachment(
  actor: MessengerActor,
  conversationId: string,
  file: {
    filename: string;
    bytes?: Buffer;
    spooled?: SpooledUpload;
  },
): Promise<MessengerAttachmentView> {
  takeBudget(actor, 'write');
  if (!isUuid(conversationId)) throw new MessengerNotFoundError();
  const name = sanitizeFilename(file.filename);
  if (!name) throw new InputError('The file name is not valid.');
  const size = file.bytes ? file.bytes.byteLength : (file.spooled?.size ?? 0);
  const refusal = messengerFileRefusal(name, size);
  if (refusal) throw new InputError(refusal);
  const ext = extOf(name);
  const mime = mimeForExt(ext);
  const kind = IMAGE_EXTS.has(ext) ? ('image' as const) : ('file' as const);
  // Content-addressed bytes first (users of a brain are trusted; the
  // same bytes land once), then the row with the participant check.
  // Through the files store's broker (docs/store-brokers.md): the key is
  // the content address, so its last part is the sha256.
  const { key } = file.bytes
    ? await stageFileObject(file.bytes, mime)
    : await stageSpooledObject(file.spooled!, mime);
  const stored = { key, size, sha256: key.slice(key.lastIndexOf('/') + 1) };
  const id = await addMessengerAttachmentRow(actor, conversationId, {
    kind,
    name,
    mime,
    bytes: stored.size,
    sha256: stored.sha256,
    path: stored.key,
  });
  return { id, name, mime, bytes: stored.size, kind };
}

type ReadRow = { id: string; name: string; mime: string; bytes: string | number; path: string };

/** The row of a file the actor may read, or null: an unsent upload, its
 *  uploader only; a sent one, a reader of its live line (the row security
 *  of messenger_messages holds the participant rule, in the login's
 *  scope). A deleted line serves no file. */
async function readable(actor: MessengerActor, id: string): Promise<ReadRow | null> {
  if (!isUuid(id)) return null;
  const [row] = await q<ReadRow>(
    db,
    sql`select a.id::text as id, a.name, a.mime, a.bytes, a.path
          from messenger_attachments a
          join messenger_conversations c on c.id = a.conversation_id
         where a.id = ${id}::uuid and c.owner_id = ${actor.ownerId}::uuid
           and ((a.message_id is null and a.uploader_login_id = ${actor.loginId}::uuid)
                or exists (select 1 from messenger_messages m
                            where m.id = a.message_id and m.deleted_at is null))`,
  );
  return row ?? null;
}

/** A file's bytes as a stream, for a reader of its line (GET
 *  /api/messenger/attachments/:id); null for anyone else. */
export async function openMessengerAttachment(
  actor: MessengerActor,
  id: string,
): Promise<{ name: string; mime: string; bytes: number; body: Readable } | null> {
  const row = await readable(actor, id);
  if (!row) return null;
  const obj = await getContent(row.path);
  return { name: row.name, mime: row.mime, bytes: Number(row.bytes), body: obj.body };
}

/** A file's bytes whole (at most 10 MB), for a reader of its line. */
async function bytesOf(
  actor: MessengerActor,
  id: string,
): Promise<{ row: ReadRow; bytes: Buffer }> {
  const row = await readable(actor, id);
  if (!row) throw new MessengerNotFoundError('File not found (or you do not read its chat).');
  const obj = await getContent(row.path);
  const chunks: Buffer[] = [];
  for await (const c of obj.body) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  return { row, bytes: Buffer.concat(chunks) };
}

/**
 * Save to Files: copy one file the actor reads into folder `parentPath` of
 * Files, in the actor's own scope (the folder's create right is the
 * login's, as an upload by hand; a taken name is a 409). Answers the new
 * file. Its own folder decides how it is read into the brain.
 */
export async function saveMessengerAttachment(
  actor: MessengerActor,
  id: string,
  parentPath: string,
): Promise<FileRow> {
  takeBudget(actor, 'write');
  const { row, bytes } = await bytesOf(actor, id);
  return upsertFile({ ownerId: actor.ownerId, parentPath, filename: row.name, bytes });
}
