/**
 * `video_ingest` — paste a video link (or point at an uploaded video file),
 * get a searchable transcript page + a durable audio artifact into the brain.
 *
 * Pipeline (both entry paths converge on the same artifact set):
 *
 *   url ──▶ ssrf ──▶ probe ──▶ captions? ──yes──▶ transcript (free, timestamped)
 *                        │no / garbage
 *                        ▼
 *              stt-resolve ──▶ /audio ──▶ save mp3 ──▶ STT ──▶ transcript
 *
 *   file_node_id ──▶ read bytes ──▶ /extract-audio ──▶ save mp3 ──▶ STT ──▶ …
 *
 * Order is the economics: captions cost nothing and are usually already
 * timestamped; STT bills per clip, so it runs only when captions are absent
 * or junk (video-transcript.ts owns that judgement, pure + tested). The
 * audio clip is saved BEFORE transcription so a failed STT still leaves a
 * durable, retryable artifact — and audio is only fetched at all on the STT
 * path (the captions path downloads nothing).
 *
 * Safety: owner-only (tool group `video-ingest`, never the team responder —
 * this is an outbound fetch of an arbitrary URL) plus a surface refusal here
 * as belt-and-braces. The URL is SSRF-checked BEFORE the sidecar sees it;
 * the sidecar itself (infra/media-sidecar) has no DB/secrets/file access.
 * The heavy lifting (yt-dlp/ffmpeg) never runs in this process.
 */

import { and, eq, sql } from 'drizzle-orm';
import { db, nodes, bumpWorkerUsage } from '@mantle/db';
import {
  createFolder,
  dashToLtree,
  fileById,
  mediaAudio,
  mediaCaptions,
  mediaExtractAudio,
  mediaProbe,
  mediaSidecarEnabled,
  mediaVideo,
  readFileById,
  upsertFile,
  type MediaBytes,
  type MediaProbe,
} from '@mantle/files';
import { createPage, markdownToDoc } from '@mantle/content';
import { getSttAdapter } from '@mantle/voice';
import { recordIngest, step } from '@mantle/tracing';
import type { BuiltinToolDef, ToolHandlerResult } from './types';
import { assertFetchableUrl } from './ssrf-guard';
import { notFound } from './errors';
import { resolveDefaultWorker } from './builtins-workers';
import { str } from './coerce';
import {
  buildTranscriptMarkdown,
  captionsGarbageReason,
  formatTimestamp,
  parseVtt,
  transcriptWordCount,
} from './video-transcript';

// ─── caps ──────────────────────────────────────────────────────────
// The STT duration cap deliberately does NOT inherit the voice path's 180 s
// default — that cap exists to refuse long MIC clips before paying; a
// tutorial video is 10–40 minutes and paying for it is this tool's job.
// 3600 s at 32 kbps mono ≈ 14.4 MB, inside both Google's 20 MB inline cap
// and Whisper's 25 MB file cap.
function intEnv(name: string, dflt: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : dflt;
}
const MAX_STT_DURATION_S = () => intEnv('MEDIA_MAX_STT_DURATION_S', 3600);
const MAX_AUDIO_BYTES = () => intEnv('MEDIA_MAX_AUDIO_BYTES', 20_000_000);
const MAX_VIDEO_BYTES = () => intEnv('MEDIA_MAX_VIDEO_BYTES', 1024 ** 3);

// ─── files/video-ingest/<date>/ (the generated-images folder pattern) ──────
const VIDEO_INGEST_FOLDER_SLUG = 'video-ingest';
const VIDEO_INGEST_FOLDER_LTREE = `files.${dashToLtree(VIDEO_INGEST_FOLDER_SLUG)}`;

async function ensureFolder(
  ownerId: string,
  parentPath: string,
  slug: string,
  description: string,
) {
  const path = `${parentPath}.${dashToLtree(slug)}`;
  const [exists] = await db
    .select({ id: nodes.id })
    .from(nodes)
    .where(
      and(eq(nodes.ownerId, ownerId), eq(nodes.type, 'branch'), sql`${nodes.path}::text = ${path}`),
    )
    .limit(1);
  if (!exists) {
    try {
      await createFolder({ ownerId, parentPath, slug, description });
    } catch (err) {
      // Concurrent creation racing — swallow the unique hit, keep going.
      if (!(err instanceof Error) || !/duplicate|unique/i.test(err.message)) throw err;
    }
  }
  return path;
}

async function ensureVideoIngestDateFolder(ownerId: string): Promise<string> {
  await ensureFolder(
    ownerId,
    'files',
    VIDEO_INGEST_FOLDER_SLUG,
    'Audio + video pulled in by the video_ingest tool.',
  );
  const today = new Date().toISOString().slice(0, 10);
  return ensureFolder(ownerId, VIDEO_INGEST_FOLDER_LTREE, today, `Video ingests from ${today}.`);
}

function slugBase(title: string | null, fallback: string): string {
  const s = (title ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return s || fallback;
}

/** Unwrap a MediaResult into the tool's error shape, or hand back the value. */
function mediaFail(r: { ok: false; code: string; message: string }): ToolHandlerResult {
  return { ok: false, error: `${r.code}: ${r.message}` };
}

type TranscriptSource = `captions:${'manual' | 'auto'}` | `stt:${string}`;

// ─── the tool ──────────────────────────────────────────────────────

const video_ingest: BuiltinToolDef = {
  slug: 'video_ingest',
  name: 'Ingest a video into the brain',
  description:
    "Turn a video into a searchable, timestamped transcript page. Pass `url` for an online video (captions are used when available — free; otherwise the audio is extracted and transcribed via the STT worker), or `file_node_id` for a video file already in Files (always audio + STT). The extracted audio is kept as a file beside the source; `keep_video: true` additionally stores the video itself. For the user's own reference material. Long-running — up to several minutes for an uncaptioned video.",
  inputSchema: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'http(s) link to the video. Exactly one of url / file_node_id.',
      },
      file_node_id: {
        type: 'string',
        description: 'Id of a video file node already in Files. Exactly one of url / file_node_id.',
      },
      language: {
        type: 'string',
        description: "Optional ISO-639-1 hint for captions/STT (e.g. 'en', 'af').",
      },
      keep_video: {
        type: 'boolean',
        default: false,
        description: 'Also store the full video file (url path only). Default false — disk.',
      },
      force_stt: {
        type: 'boolean',
        default: false,
        description: 'Skip captions and transcribe the audio even when captions exist.',
      },
    },
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
    // Belt-and-braces on top of the tool-group grant: an outbound fetch of an
    // arbitrary URL never runs for a team surface.
    if (ctx.surface?.kind === 'team' || ctx.surface?.kind === 'forum') {
      return { ok: false, error: 'owner-side tool — not available on the team surfaces' };
    }
    if (!mediaSidecarEnabled()) {
      return {
        ok: false,
        error:
          'Media ingestion is not enabled on this box — it needs the `media` compose profile plus MEDIA_SIDECAR_TOKEN (see docs/video-ingest.md).',
      };
    }
    const url = str(input.url).trim();
    const fileNodeId = str(input.file_node_id).trim();
    if (url && fileNodeId) {
      return { ok: false, error: 'pass EITHER url OR file_node_id, not both' };
    }
    if (!url && !fileNodeId) {
      return {
        ok: false,
        error:
          "pass one of `url` (an http(s) link) or `file_node_id` (a file node's UUID from file_list / search_nodes)",
      };
    }
    const language = str(input.language) || undefined;
    const forceStt = input.force_stt === true;
    let keepVideo = input.keep_video === true;
    const notes: string[] = [];
    if (keepVideo && ctx.surface?.kind !== 'web') {
      // A full video download can add 25 minutes to an already-long turn;
      // off the web surface (Telegram especially) that reads as a hang.
      keepVideo = false;
      notes.push('keep_video ignored on this surface — re-run from the web app to store the video');
    }

    if (url) {
      // ── URL path ────────────────────────────────────────────────
      try {
        await assertFetchableUrl(url);
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }

      const probe = await step({ name: 'video_probe', kind: 'http', input: { url } }, async (h) => {
        const r = await mediaProbe(url);
        if (r.ok) {
          h.setMeta({
            title: r.value.title,
            durationSeconds: r.value.durationSeconds,
            captionsManual: r.value.captions.manual.length,
            captionsAuto: r.value.captions.auto.length,
          });
        } else {
          h.setMeta({ error: r.code });
        }
        return r;
      });
      if (!probe.ok) return mediaFail(probe);
      const info = probe.value;
      if (info.isLive) {
        return {
          ok: false,
          error:
            'this is a LIVE stream — there is no bounded video to ingest. Try again after it ends.',
        };
      }
      const maxDuration = MAX_STT_DURATION_S();
      const hasCaptions = info.captions.manual.length > 0 || info.captions.auto.length > 0;
      const overCap = info.durationSeconds != null && info.durationSeconds > maxDuration;
      if (overCap && (!hasCaptions || forceStt)) {
        // Never start a doomed download.
        return {
          ok: false,
          error: `video is ${Math.round(info.durationSeconds!)}s — over the ${maxDuration}s STT cap — and ${forceStt ? 'force_stt was requested' : 'has no captions'}. Raise MEDIA_MAX_STT_DURATION_S or pick a shorter video.`,
        };
      }

      // Captions first — free, near-instant, usually already timestamped.
      let transcriptMd: string | null = null;
      let source: TranscriptSource | null = null;
      if (hasCaptions && !forceStt) {
        const caps = await step(
          { name: 'video_captions', kind: 'http', input: { url, language } },
          async (h) => {
            const r = await mediaCaptions(url, { lang: language, prefer: 'any' });
            h.setMeta(r.ok ? { source: r.value.source, lang: r.value.lang } : { error: r.code });
            return r;
          },
        );
        if (caps.ok) {
          const cues = parseVtt(caps.value.content);
          const garbage = captionsGarbageReason(cues, info.durationSeconds, {
            // Human-authored subtitles are never second-guessed on vocabulary
            // or density — a 4h conference with terse captions must not be
            // thrown away by a heuristic tuned for auto-caption junk.
            trusted: caps.value.source === 'manual',
          });
          if (garbage) {
            notes.push(`${caps.value.source} captions rejected: ${garbage}; falling back to STT`);
          } else {
            transcriptMd = buildTranscriptMarkdown(cues);
            source = `captions:${caps.value.source}`;
            if (caps.value.source === 'auto') {
              notes.push('transcript is from machine-generated captions — accuracy varies');
            }
          }
        } else if (caps.code === 'no_captions') {
          notes.push('advertised captions were not downloadable; falling back to STT');
        } else {
          return mediaFail(caps);
        }
      }

      let audioFileId: string | null = null;
      let sttModel: string | null = null;
      if (!transcriptMd) {
        if (overCap) {
          return {
            ok: false,
            error: `captions were unusable and the video is ${Math.round(info.durationSeconds!)}s — over the ${maxDuration}s STT cap.`,
          };
        }
        // Resolve the STT worker BEFORE fetching audio — never download for
        // a transcription that can't run.
        const stt = await resolveDefaultWorker(ctx.ownerId, 'stt');
        if (!stt.ok) {
          return {
            ok: false,
            error: `this video has no usable captions and ${stt.error}`,
          };
        }
        const adapter = getSttAdapter(stt.worker.provider);
        if (!adapter) {
          return {
            ok: false,
            error: `no STT adapter is wired for provider '${stt.worker.provider}'`,
          };
        }
        const audio = await step(
          { name: 'video_audio_fetch', kind: 'http', input: { url } },
          async (h) => {
            const r = await mediaAudio(url, {
              maxDurationSeconds: maxDuration,
              maxBytes: MAX_AUDIO_BYTES(),
            });
            h.setMeta(r.ok ? { bytes: r.value.bytes.length } : { error: r.code });
            return r;
          },
        );
        if (!audio.ok) return mediaFail(audio);

        // Save BEFORE transcribing: a failed STT still leaves a durable,
        // retryable artifact (re-run with the file node later).
        const saved = await saveAudio(ctx.ownerId, audio.value, {
          sourceUrl: url,
          videoTitle: info.title,
          slugFallback: 'video',
        });
        if (!saved.ok) return saved;
        audioFileId = saved.fileId;

        const text = await transcribeStep(audio.value.bytes, {
          adapter,
          apiKey: stt.apiKey,
          workerId: stt.worker.id,
          workerSlug: stt.worker.slug,
          model: stt.worker.model,
          maxDurationSeconds: maxDuration,
          language,
        });
        if (!text.ok) {
          // Partial success — the audio artifact survived.
          return {
            ok: true,
            output: {
              ok: true,
              partial: true,
              audioFileId,
              transcriptPageId: null,
              error: `audio saved, but transcription failed: ${text.error}. Re-run video_ingest with file_node_id later.`,
            },
          };
        }
        transcriptMd = text.markdown;
        source = `stt:${stt.worker.provider}`;
        sttModel = stt.worker.model;
        notes.push('transcript is machine-transcribed speech (untimestamped) — accuracy varies');
      }

      // Opt-in: keep the video itself, beside the audio.
      let videoFileId: string | null = null;
      if (keepVideo) {
        const vid = await step(
          { name: 'video_download', kind: 'http', input: { url } },
          async (h) => {
            const r = await mediaVideo(url, { maxBytes: MAX_VIDEO_BYTES() });
            h.setMeta(r.ok ? { bytes: r.value.bytes.length } : { error: r.code });
            return r;
          },
        );
        if (vid.ok) {
          const parentPath = await ensureVideoIngestDateFolder(ctx.ownerId);
          const file = await upsertFile({
            ownerId: ctx.ownerId,
            parentPath,
            filename: `${Date.now()}-${slugBase(info.title, 'video')}.mp4`,
            bytes: vid.value.bytes,
            overwrite: false,
            title: info.title ?? undefined,
            data: {
              source: 'video_ingest',
              sourceUrl: url,
              durationSeconds: info.durationSeconds,
              indexing: 'metadata',
            },
            tags: ['video', 'video-ingest'],
          });
          videoFileId = file.id;
          if (audioFileId) {
            // Derived-node convention: the video is the provenance ROOT.
            // Re-stamp the audio clip so deleting the video reaps (or at
            // least surfaces) its derived clip instead of orphaning it.
            await db
              .update(nodes)
              .set({
                data: sql`${nodes.data} || ${JSON.stringify({ sourceFileId: file.id })}::jsonb`,
              })
              .where(and(eq(nodes.id, audioFileId), eq(nodes.ownerId, ctx.ownerId)));
          }
        } else {
          notes.push(
            `keep_video failed (${vid.code}: ${vid.message}); transcript and audio are unaffected`,
          );
        }
      }

      return await finishWithPage(ctx.ownerId, {
        transcriptMd: transcriptMd!,
        source: source!,
        sttModel,
        info,
        sourceUrl: url,
        audioFileId,
        videoFileId,
        notes,
      });
    }

    // ── file-node path ────────────────────────────────────────────
    // Metadata FIRST: mime + size gates must run before the bytes are read,
    // or the size cap can only refuse an allocation that already happened
    // (and >2 GiB throws out of fs.readFile before any guard runs).
    const meta = await fileById({ ownerId: ctx.ownerId, fileId: fileNodeId });
    if (!meta) return notFound('file', fileNodeId, 'file_list / search_nodes');
    const mime = meta.mimeType ?? '';
    if (!mime.startsWith('video/') && !mime.startsWith('audio/')) {
      return {
        ok: false,
        error: `node '${meta.filename}' is ${mime || 'not a media file'} — video_ingest wants a video/* or audio/* file`,
      };
    }
    if (meta.sizeBytes > MAX_VIDEO_BYTES()) {
      return {
        ok: false,
        error: `file is ${meta.sizeBytes} bytes — over the ${MAX_VIDEO_BYTES()}-byte cap`,
      };
    }
    const loaded = await readFileById({ ownerId: ctx.ownerId, fileId: fileNodeId });
    if (!loaded) return notFound('file', fileNodeId, 'file_list / search_nodes');
    const stt = await resolveDefaultWorker(ctx.ownerId, 'stt');
    if (!stt.ok) return { ok: false, error: stt.error };
    const adapter = getSttAdapter(stt.worker.provider);
    if (!adapter) {
      return { ok: false, error: `no STT adapter is wired for provider '${stt.worker.provider}'` };
    }
    const maxDuration = MAX_STT_DURATION_S();
    const extracted = await step(
      { name: 'video_extract_audio', kind: 'http', input: { bytes_in: loaded.bytes.length } },
      async (h) => {
        const r = await mediaExtractAudio(loaded.bytes, {
          maxDurationSeconds: maxDuration,
          maxAudioBytes: MAX_AUDIO_BYTES(),
        });
        h.setMeta(r.ok ? { bytes: r.value.bytes.length } : { error: r.code });
        return r;
      },
    );
    if (!extracted.ok) return mediaFail(extracted);

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
      apiKey: stt.apiKey,
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
        channel: null,
        uploadDate: null,
        extractor: null,
        isLive: false,
        captions: { manual: [], auto: [] },
        filesizeApprox: null,
      },
      sourceUrl: null,
      audioFileId: savedFile.id,
      videoFileId: fileNodeId,
      notes,
    });
  },
};

// ─── shared stages ─────────────────────────────────────────────────

async function saveAudio(
  ownerId: string,
  audio: MediaBytes,
  opts: { sourceUrl: string; videoTitle: string | null; slugFallback: string },
): Promise<{ ok: true; fileId: string } | { ok: false; error: string }> {
  try {
    const parentPath = await ensureVideoIngestDateFolder(ownerId);
    const file = await upsertFile({
      ownerId,
      parentPath,
      filename: `${Date.now()}-${slugBase(opts.videoTitle, opts.slugFallback)}.mp3`,
      bytes: audio.bytes,
      overwrite: false,
      title: opts.videoTitle ? `${opts.videoTitle} (audio)` : undefined,
      data: {
        source: 'video_ingest',
        sourceUrl: opts.sourceUrl,
        videoTitle: opts.videoTitle,
        durationSeconds: audio.durationSeconds,
        // Metadata-only spine (name/type/tags, no content read): the clip's
        // KNOWLEDGE lives in the transcript page; indexing the mp3 itself
        // would be an unsupported_media skip at best.
        indexing: 'metadata',
      },
      tags: ['audio', 'video-ingest'],
    });
    return { ok: true, fileId: file.id };
  } catch (err) {
    return {
      ok: false,
      error: `audio was extracted but could not be saved: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

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
        h.setMeta({ error: err instanceof Error ? err.message : String(err) });
        return {
          ok: false as const,
          error: err instanceof Error ? err.message : String(err),
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
    info: MediaProbe;
    sourceUrl: string | null;
    audioFileId: string | null;
    videoFileId: string | null;
    notes: string[];
  },
): Promise<ToolHandlerResult> {
  const { info } = args;
  const meta = [
    args.sourceUrl ? `Source: ${args.sourceUrl}` : null,
    info.channel ? `Channel: ${info.channel}` : null,
    info.durationSeconds != null ? `Duration: ${formatTimestamp(info.durationSeconds)}` : null,
    `Transcript: ${
      args.source.startsWith('captions:')
        ? `${args.source.slice('captions:'.length)} captions`
        : `speech-to-text (${args.sttModel ?? args.source.slice('stt:'.length)})`
    }`,
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
        ...(args.sourceUrl ? { sourceUrl: args.sourceUrl } : {}),
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
        error: `transcription succeeded but the page could not be created: ${err instanceof Error ? err.message : String(err)}`,
      },
    };
  }

  void recordIngest({
    source: 'agent_tool',
    ownerId,
    nodeId: pageId,
    summary: `Video ingested: ${info.title ?? args.sourceUrl ?? 'video'}`,
    payload: {
      via: 'video_ingest_tool',
      transcriptSource: args.source,
      sourceUrl: args.sourceUrl,
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
        channel: info.channel,
        url: args.sourceUrl,
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
