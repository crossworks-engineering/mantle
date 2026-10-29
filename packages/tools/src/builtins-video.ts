/**
 * `video_ingest`: point at an uploaded video (or audio) file, get a
 * searchable transcript page + a durable audio artifact into the brain.
 *
 * Pipeline:
 *
 *   file_node_id ──▶ read bytes ──▶ parser /extract-audio ──▶ save mp3 ──▶ STT ──▶ page
 *
 * The audio is saved BEFORE transcription so a failed STT still leaves a
 * durable, retryable artifact. STT bills per clip, so the worker is resolved
 * before any byte is read.
 *
 * No links: the tool fetches nothing. A video on the web is downloaded by the
 * user and uploaded. ffmpeg runs in the parser
 * service (server/parser), never in this process.
 *
 * Owner-only (tool group `video-ingest`, never the team responder): it
 * spends the owner's STT key.
 */

import { bumpWorkerUsage } from '@mantle/db';
import { fileById, parserExtractAudio, readFileById, upsertFile } from '@mantle/files';
import { createPage, markdownToDoc } from '@mantle/content';
import { getSttAdapter } from '@mantle/voice';
import { recordIngest, step } from '@mantle/tracing';
import type { BuiltinToolDef, ToolHandlerResult } from './types';
import { isOwnerSurface, OWNER_ONLY_ERROR } from './surface';
import { notFound } from './errors';
import { defaultWorkerOrError } from './builtins-workers';
import { str } from './coerce';
import { formatTimestamp, transcriptWordCount } from './video-transcript';
import { envNum } from '@mantle/config';
import { errorDetail, errorMessage, publicProviderErrorMessage } from '@mantle/std';

// ─── caps ──────────────────────────────────────────────────────────
// The STT duration cap deliberately does NOT inherit the voice path's 180 s
// default — that cap exists to refuse long MIC clips before paying; a
// tutorial video is 10–40 minutes and paying for it is this tool's job.
// 3600 s at 32 kbps mono ≈ 14.4 MB, inside both Google's 20 MB inline cap
// and Whisper's 25 MB file cap.
const MAX_STT_DURATION_S = () => envNum('VIDEO_INGEST_MAX_STT_DURATION_S');
const MAX_AUDIO_BYTES = () => envNum('VIDEO_INGEST_MAX_AUDIO_BYTES');
const MAX_FILE_BYTES = () => envNum('VIDEO_INGEST_MAX_FILE_BYTES');

type TranscriptSource = `stt:${string}`;

/** What the transcript page says about the recording. */
type RecordingInfo = { title: string | null; durationSeconds: number | null };

// ─── the tool ──────────────────────────────────────────────────────

const video_ingest: BuiltinToolDef = {
  slug: 'video_ingest',
  usageTier: 2,
  policy: {
    matrix: { action: 'read', param: 'file_node_id', kinds: ['file'] },
    // Audit only: the row names it (the queue asks nothing of it).
    itemArgs: [{ param: 'file_node_id', least: 'none' }],
    effect: 'write',
    spends: 'ownerKey',
    startsModelWork: true,
    scope: 'admin',
    peerRisky: true,
    clientSourced: { kind: 'write', nodes: [], creates: true },
  },
  ownerOnly: true,
  name: 'Transcribe a recording into the brain',
  description:
    "Turn an uploaded video or audio file (a file node in Files) into a searchable transcript page: the audio is extracted and transcribed by the speech-to-text worker. The extracted audio is kept as a file beside the source. This tool does not fetch links: for a video on the web, ask the user to download it and upload the file, then pass its file_node_id. For the user's own reference material. Long-running: up to several minutes for a long recording.",
  inputSchema: {
    type: 'object',
    properties: {
      file_node_id: {
        type: 'string',
        description: 'Id of a video or audio file node already in Files.',
      },
      language: {
        type: 'string',
        description: "Optional ISO-639-1 hint for speech-to-text (e.g. 'en', 'af').",
      },
    },
    required: ['file_node_id'],
  },
  // Checked centrally before the handler runs; catches the classic
  // filename-instead-of-uuid mistake with a teaching error instead of a raw
  // Postgres 22P02.
  preconditions: [
    {
      kind: 'node_exists',
      param: 'file_node_id',
      nodeType: 'file',
      lookup: 'file_list / search_nodes',
    },
  ],
  handler: async (input, ctx): Promise<ToolHandlerResult> => {
    // Belt-and-braces on top of the tool-group grant and the dispatch gate
    // (the MCP server calls handlers directly): it spends the owner's key.
    if (!isOwnerSurface(ctx.surface)) return { ok: false, error: OWNER_ONLY_ERROR };
    if (str(input.url).trim()) {
      return {
        ok: false,
        error:
          'video_ingest does not fetch links. Ask the user to download the video and upload the file, then pass its file_node_id.',
      };
    }
    const fileNodeId = str(input.file_node_id).trim();
    if (!fileNodeId) {
      return {
        ok: false,
        error:
          "pass `file_node_id` (a video or audio file node's UUID from file_list / search_nodes)",
      };
    }
    const language = str(input.language) || undefined;
    const notes: string[] = [];

    // Metadata FIRST: mime + size gates must run before the bytes are read,
    // or the size cap can only refuse an allocation that already happened
    // (and >2 GiB throws out of fs.readFile before any guard runs).
    const meta = await fileById({ ownerId: ctx.ownerId, fileId: fileNodeId });
    if (!meta) return notFound('file', fileNodeId, 'file_list / search_nodes');
    const mime = meta.mimeType ?? '';
    if (!mime.startsWith('video/') && !mime.startsWith('audio/')) {
      return {
        ok: false,
        error: `file_node_id must be a video/* or audio/* file: node '${meta.filename}' is ${mime || 'not a media file'}`,
      };
    }
    if (meta.sizeBytes > MAX_FILE_BYTES()) {
      return {
        ok: false,
        error: `file is ${meta.sizeBytes} bytes, over the ${MAX_FILE_BYTES()}-byte cap (VIDEO_INGEST_MAX_FILE_BYTES)`,
      };
    }
    // The STT worker BEFORE the bytes: never extract audio for a
    // transcription that cannot run.
    const stt = await defaultWorkerOrError(ctx.ownerId, 'stt');
    if (!stt.ok) return { ok: false, error: stt.error };
    const adapter = getSttAdapter(stt.worker.provider);
    if (!adapter) {
      return { ok: false, error: `no STT adapter is wired for provider '${stt.worker.provider}'` };
    }
    const loaded = await readFileById({ ownerId: ctx.ownerId, fileId: fileNodeId });
    if (!loaded) return notFound('file', fileNodeId, 'file_list / search_nodes');
    const maxDuration = MAX_STT_DURATION_S();
    const extracted = await step(
      { name: 'video_extract_audio', kind: 'http', input: { bytes_in: loaded.bytes.length } },
      async (h) => {
        const r = await parserExtractAudio(loaded.bytes, {
          maxDurationSeconds: maxDuration,
          maxAudioBytes: MAX_AUDIO_BYTES(),
        });
        h.setMeta(r.ok ? { bytes: r.value.bytes.length } : { error: r.code });
        return r;
      },
    );
    if (!extracted.ok) {
      return {
        ok: false,
        error:
          extracted.code === 'too_large'
            ? `${extracted.message}. Raise VIDEO_INGEST_MAX_STT_DURATION_S or VIDEO_INGEST_MAX_AUDIO_BYTES, or upload a shorter recording.`
            : `the audio could not be extracted (${extracted.code}: ${extracted.message})`,
      };
    }

    // The clip lives BESIDE its video (same folder), linked by sourceFileId.
    // Named `<base>-audio.mp3` and NEVER overwriting: `<base>.mp3` would be
    // the source file itself when the input is an mp3, and could be a user's
    // own sibling file next to a video — both unrecoverable losses.
    const parentLtree = loaded.row.parentPath;
    const baseName = loaded.row.filename.replace(/\.[^.]+$/, '');
    const audioData = {
      source: 'video_ingest',
      sourceFileId: fileNodeId,
      durationSeconds: extracted.value.durationSeconds,
      indexing: 'metadata',
    };
    let savedFile;
    try {
      savedFile = await upsertFile({
        ownerId: ctx.ownerId,
        parentPath: parentLtree,
        filename: `${baseName}-audio.mp3`,
        bytes: extracted.value.bytes,
        overwrite: false,
        data: audioData,
        tags: ['audio', 'video-ingest'],
      });
    } catch (err) {
      if (err instanceof Error && /already exists/i.test(err.message)) {
        // A previous run (or a same-named user file) holds the slot — take a
        // timestamped name instead of clobbering it.
        savedFile = await upsertFile({
          ownerId: ctx.ownerId,
          parentPath: parentLtree,
          filename: `${baseName}-audio-${Date.now()}.mp3`,
          bytes: extracted.value.bytes,
          overwrite: false,
          data: audioData,
          tags: ['audio', 'video-ingest'],
        });
      } else {
        throw err;
      }
    }
    const text = await transcribeStep(extracted.value.bytes, {
      adapter,
      apiKey: stt.credential.apiKey,
      workerId: stt.worker.id,
      workerSlug: stt.worker.slug,
      model: stt.worker.model,
      maxDurationSeconds: maxDuration,
      language,
    });
    if (!text.ok) {
      return {
        ok: true,
        output: {
          ok: true,
          partial: true,
          audioFileId: savedFile.id,
          transcriptPageId: null,
          error: `audio extracted and saved, but transcription failed: ${text.error}. Re-run later.`,
        },
      };
    }
    notes.push('transcript is machine-transcribed speech (untimestamped) — accuracy varies');
    return await finishWithPage(ctx.ownerId, {
      transcriptMd: text.markdown,
      source: `stt:${stt.worker.provider}`,
      sttModel: stt.worker.model,
      info: {
        title: meta.title || meta.filename,
        durationSeconds: extracted.value.durationSeconds,
      },
      audioFileId: savedFile.id,
      videoFileId: fileNodeId,
      notes,
    });
  },
};

// ─── shared stages ─────────────────────────────────────────────────

async function transcribeStep(
  bytes: Buffer,
  opts: {
    adapter: NonNullable<ReturnType<typeof getSttAdapter>>;
    apiKey: string;
    workerId: string;
    workerSlug: string;
    model: string | null;
    maxDurationSeconds: number;
    language?: string;
  },
): Promise<{ ok: true; markdown: string } | { ok: false; error: string }> {
  return step(
    {
      name: 'video_transcribe',
      kind: 'llm_call',
      input: { bytes: bytes.length, worker_slug: opts.workerSlug },
    },
    async (h) => {
      try {
        const r = await opts.adapter.transcribe(bytes, {
          apiKey: opts.apiKey,
          mimeType: 'audio/mpeg',
          model: opts.model ?? undefined,
          language: opts.language,
          // Explicitly the VIDEO path's cap — not the 180 s voice default.
          maxDurationSeconds: opts.maxDurationSeconds,
        });
        void bumpWorkerUsage(opts.workerId);
        h.setMeta({ model: r.model, durationSeconds: r.durationSeconds, chars: r.text.length });
        if (!r.text.trim()) return { ok: false as const, error: 'STT returned empty text' };
        // Adapters return plain text (no segments), so the STT transcript is
        // a single untimestamped body — stated honestly in the page + notes.
        return { ok: true as const, markdown: r.text.trim() };
      } catch (err) {
        // The detail for the owner's trace: a refused key's provider and
        // status only, never its body (errorDetail).
        h.setMeta({ error: errorDetail(err) });
        return {
          ok: false as const,
          // The tool text (the model reads it, a member may see it) is the
          // fixed sentence; the provider's own text stays in the trace.
          error: publicProviderErrorMessage(err, 'video_ingest'),
        };
      }
    },
  );
}

async function finishWithPage(
  ownerId: string,
  args: {
    transcriptMd: string;
    source: TranscriptSource;
    sttModel: string | null;
    info: RecordingInfo;
    audioFileId: string | null;
    videoFileId: string | null;
    notes: string[];
  },
): Promise<ToolHandlerResult> {
  const { info } = args;
  const meta = [
    info.durationSeconds != null ? `Duration: ${formatTimestamp(info.durationSeconds)}` : null,
    `Transcript: speech-to-text (${args.sttModel ?? args.source.slice('stt:'.length)})`,
    `Fetched: ${new Date().toISOString().slice(0, 10)}`,
  ]
    .filter(Boolean)
    .map((l) => `> ${l}`)
    .join('\n');
  const md = `${meta}\n\n${args.transcriptMd}`;

  let pageId: string;
  try {
    const page = await createPage(ownerId, {
      title: `Transcript — ${info.title ?? 'video'}`,
      doc: markdownToDoc(md) as Record<string, unknown>,
      tags: ['transcript', 'video'],
      data: {
        source: 'video_ingest',
        transcriptSource: args.source,
        // Derived-node convention — but ONLY toward the VIDEO. The transcript
        // is the durable knowledge and the mp3 is a disposable byproduct;
        // pointing sourceFileId at the audio would let "tidy up the clips"
        // reap the transcript page along with a 15 MB mp3.
        ...(args.videoFileId ? { sourceFileId: args.videoFileId } : {}),
      },
    });
    pageId = page.id;
  } catch (err) {
    // The transcription succeeded — don't lose the text to the turn.
    return {
      ok: true,
      output: {
        ok: true,
        partial: true,
        audioFileId: args.audioFileId,
        transcriptPageId: null,
        preview: args.transcriptMd.slice(0, 1500),
        error: `transcription succeeded but the page could not be created: ${errorMessage(err)}`,
      },
    };
  }

  void recordIngest({
    source: 'agent_tool',
    ownerId,
    nodeId: pageId,
    summary: `Video ingested: ${info.title ?? 'recording'}`,
    payload: {
      via: 'video_ingest_tool',
      transcriptSource: args.source,
      audioFileId: args.audioFileId,
      videoFileId: args.videoFileId,
    },
    snippet: args.transcriptMd.slice(0, 2000),
  });

  return {
    ok: true,
    output: {
      ok: true,
      video: {
        title: info.title,
        durationSeconds: info.durationSeconds,
      },
      transcriptPageId: pageId,
      transcriptSource: args.source,
      ...(args.audioFileId ? { audioFileId: args.audioFileId } : {}),
      ...(args.videoFileId ? { videoFileId: args.videoFileId } : {}),
      wordCount: transcriptWordCount(args.transcriptMd),
      preview: args.transcriptMd.slice(0, 500),
      ...(args.notes.length ? { notes: args.notes } : {}),
    },
  };
}

export const VIDEO_TOOLS: readonly BuiltinToolDef[] = [video_ingest];
