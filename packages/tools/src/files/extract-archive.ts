/**
 * "Extract contents" of an archive (docs/files.md, "Archives"): one function
 * for the route POST/GET /api/files/files/:id/extract and the tool
 * `file_extract_archive`, so the two never drift.
 *
 * Never automatic (the owner, 2026-11-19: "a archive file must have an
 * extract context option, but never automatic"): nothing but this asks for
 * an extraction, and the extraction runs only for the stamp this asks
 * (@mantle/files archive-extract.ts). Rights: the edit of the archive (as a
 * reindex asks) and the add of a folder beside it, both in the caller's
 * scope; the files land in that new folder.
 */
import {
  archiveExtractBusy,
  archiveExtractStatus,
  startArchiveExtract,
  type ArchiveExtractRefusal,
  type ArchiveExtractStamp,
} from '@mantle/files';
import { UUID_RE } from '@mantle/std';
import type {
  ArchiveExtractAnswer,
  ArchiveExtractView,
} from '@mantle/client-types/dto/file-status';
import { CS } from '../client-sourced-rule';
import { FILE_ID_PRE } from '../builtins-common';
import type { BuiltinToolDef } from '../types';

/** The stamp as the client reads it. A queued or running stamp that is no
 *  longer busy (the agent stopped in the middle) reads as failed, so a
 *  person sees why and may ask again, as the claim allows. */
export function archiveExtractViewOf(stamp: ArchiveExtractStamp): ArchiveExtractView {
  const stopped =
    (stamp.state === 'queued' || stamp.state === 'running') && !archiveExtractBusy(stamp);
  const error = stopped
    ? 'The extraction stopped before it finished. Ask again to extract it.'
    : stamp.error;
  return {
    state: stopped ? 'failed' : stamp.state,
    folder: stamp.folder_id ? { id: stamp.folder_id, path: stamp.folder_path } : null,
    queuedAt: stamp.at,
    ...(stamp.started_at ? { startedAt: stamp.started_at } : {}),
    ...(stamp.finished_at ? { finishedAt: stamp.finished_at } : {}),
    files: stamp.files,
    folders: stamp.folders,
    bytes: stamp.bytes,
    skipped: stamp.skipped,
    flattened: stamp.flattened,
    refused: stamp.refused,
    refusedCount: stamp.refused_count,
    ...(error ? { error } : {}),
  };
}

export type ArchiveExtractResult =
  { ok: true; answer: ArchiveExtractAnswer } | (Omit<ArchiveExtractRefusal, 'ok'> & { ok: false });

/** The state of a file's last extraction, and whether it can be extracted
 *  (GET, and the tool's `check`). Read only. */
export async function archiveExtractAnswer(
  ownerId: string,
  fileId: string,
): Promise<ArchiveExtractResult> {
  if (!UUID_RE.test(fileId.trim())) {
    return { ok: false, status: 404, reason: 'not-found', error: 'No such file.' };
  }
  const res = await archiveExtractStatus(ownerId, fileId);
  if (!res.ok) return res;
  return {
    ok: true,
    answer: {
      file: res.file,
      extractable: res.extractable,
      ...(res.why ? { why: res.why } : {}),
      extract: res.stamp ? archiveExtractViewOf(res.stamp) : null,
    },
  };
}

/** Ask for the contents of an archive (POST, and the tool). The answer
 *  holds the `queued` state and the new folder; the refusal its status and
 *  sentence. */
export async function extractArchive(
  ownerId: string,
  fileId: string,
): Promise<ArchiveExtractResult> {
  if (!UUID_RE.test(fileId.trim())) {
    return { ok: false, status: 404, reason: 'not-found', error: 'No such file.' };
  }
  const res = await startArchiveExtract(ownerId, fileId);
  if (!res.ok) return res;
  const answer = await archiveExtractAnswer(ownerId, fileId);
  if (answer.ok) return answer;
  // Read back failed (the file went meanwhile): the queued state as asked.
  return {
    ok: true,
    answer: {
      file: { id: fileId.trim().toLowerCase(), name: res.folder.name },
      extractable: true,
      extract: archiveExtractViewOf(res.stamp),
    },
  };
}

export const file_extract_archive: BuiltinToolDef = {
  slug: 'file_extract_archive',
  policy: {
    // The edit of the archive, as a reindex asks; the new folder beside it
    // is made in the caller's scope (the add of its folder, the database's
    // check).
    matrix: { action: 'edit', param: 'file_id', kinds: ['file'] },
    effect: 'write',
    // The tool calls no model: it queues. Each file it makes is read as an
    // upload is, behind the extract's own gates and caps.
    spends: 'none',
    // It makes many files, each read with model work: an API key or a peer
    // must have the tool named. A member keeps what he may do by hand.
    peerRisky: true,
    scope: 'any',
    keyArea: 'files',
    itemArgs: [{ param: 'file_id' }],
    // The archive's own bytes, unpacked beside it; nothing new reaches
    // anyone.
    clientSourced: CS.onNodes('file_id'),
    // A recipe never unpacks an archive: only a person's ask.
    recipe: { step: 'forbidden' },
  },
  name: 'Extract an archive',
  description:
    "Extract an archive (ZIP, TAR, .tar.gz, .tgz, .gz) into a NEW folder beside it, named after it, only when the person asks: archives are never unpacked by themselves. Each file inside becomes a file, read like an upload; folders are kept (past three levels below Files, deeper folder names join the file's name). Refused and listed with a reason: paths climbing out (`../`) or absolute, links, devices, encrypted entries, files past 128 MB; the whole archive past 512 MB or 10,000 files. Nested archives stay archives; 7z and RAR are not extracted. Runs in the background: the answer is `queued`; call with `check: true` for progress and result. Needs the right to change the file.",
  preconditions: FILE_ID_PRE,
  inputSchema: {
    type: 'object',
    properties: {
      file_id: {
        type: 'string',
        format: 'uuid',
        description: "The archive file's id (UUID), from `file_list` or `search`.",
      },
      check: {
        type: 'boolean',
        description:
          'true: only read the state of the last extraction (and whether the file can be extracted); start nothing.',
      },
    },
    required: ['file_id'],
  },
  handler: async (input, ctx) => {
    const fileId = typeof input.file_id === 'string' ? input.file_id : '';
    const res =
      input.check === true
        ? await archiveExtractAnswer(ctx.ownerId, fileId)
        : await extractArchive(ctx.ownerId, fileId);
    if (!res.ok) return { ok: false, error: res.error };
    return { ok: true, output: res.answer };
  },
};
