# Video ingest — paste a link, get a searchable transcript

`video_ingest` turns a video into knowledge the brain can answer from: a
timestamped transcript **page** (summarised, embedded, chunked like any other
page) plus a durable **audio clip** in Files. The point is that "what did that
video tell me to do at 4:12" is answerable months later, from the brain,
without the video.

## Two entry points, one artifact set

- **A link** (`url`): the sidecar probes metadata, then tries **captions
  first** — free, near-instant, already timestamped. Only when the video has
  no usable captions does it download audio and pay for STT.
- **A stored video file** (`file_node_id`): a video already in Files has no
  captions to try, so it always takes the audio route; the extracted mp3
  lands beside the video in the same folder.

Both paths converge on: a transcript page + (on the STT path) an audio file +
provenance links (`data.sourceUrl`, `data.sourceFileId` — the derived-node
convention, so reaping and the integrity audit see them).

## The captions-first economics

Most videos already carry a transcript (manual subtitles or auto-captions).
Reading those costs nothing; STT bills per clip. The pipeline therefore only
transcribes when captions are absent — or when the pure garbage heuristic
(`packages/tools/src/video-transcript.ts`) rejects them: tracks that are
mostly `[Music]`, absurdly sparse, or looped filler fall through to STT with
the reason recorded. `force_stt: true` skips captions deliberately.

The reply always states which source produced the transcript
(`captions:manual`, `captions:auto`, `stt:<provider>`) and notes that
machine-generated text varies in accuracy. Caption transcripts carry
`## [m:ss]` section headings; the chunker folds those into each retrieval
chunk's `headingPath`, which is what makes timestamp-anchored recall work.
STT transcripts are a single untimestamped body in V1 (adapters return plain
text, no segments).

## The media sidecar

yt-dlp and ffmpeg never run in the app process. They live in their own
container (`infra/media-sidecar`, compose service `media`, image
`mantle-media`), behind a bearer-authed internal-only HTTP interface —
no DB, no secrets, no file-store mounts. Two deliberate inversions of house
policy, both scoped to this one container:

1. **yt-dlp is never pinned.** It breaks the moment a site changes its player
   and upstream fixes land within days, so the entrypoint refreshes it from
   PyPI at boot and daily. The running version is on `/healthz`, the system
   health panel, and the integrity readiness panel — a stale or failed update
   is visible, not silent.
2. **It fetches arbitrary URLs by design.** The app SSRF-checks every URL
   (`assertFetchableUrl`) before the sidecar sees it, and the sidecar's
   isolation bounds what a hostile page could reach.

Enable it per box:

```sh
# .env
COMPOSE_PROFILES=media            # or append to the existing list
MEDIA_SIDECAR_TOKEN=<openssl rand -hex 32>
```

Without the profile (or the token) the tool refuses cleanly with "not enabled
on this box". Dev: `docker compose -f docker-compose.dev.yml up media` builds
the stage locally on `127.0.0.1:8095` (see `.env.example`).

## Caps

| env | default | what it bounds |
|---|---|---|
| `MEDIA_MAX_STT_DURATION_S` | 3600 | STT-path video length. Deliberately NOT the voice path's 180 s — that cap refuses long mic clips; paying for a 40-minute tutorial is this feature's job. 60 min at 32 kbps mono ≈ 14.4 MB, inside Google's 20 MB inline and Whisper's 25 MB caps. |
| `MEDIA_MAX_AUDIO_BYTES` | 20 MB | extracted clip size |
| `MEDIA_MAX_VIDEO_BYTES` | 1 GiB | `keep_video` download / file-node read |
| `MEDIA_MAX_UPLOAD_BYTES` | 1 GiB | sidecar `/extract-audio` body (sidecar env) |
| `MEDIA_MAX_CONCURRENT` | 2 | sidecar-side heavy-op semaphore |

Duration is checked at probe time, **before** any download — an over-cap
video costs one metadata call. Captions have no duration cap (they're free).

## Failure honesty

Every dead end is a structured error naming the recovery move, and a
half-completed run is an explicit **partial success**, never a silent one:
the audio clip is saved *before* transcription, so a failed STT returns the
audio file id with "re-run with file_node_id later". A transcript whose page
creation failed comes back with a preview so the text isn't lost to the turn.

## Safety and grants

Owner-only. The `video-ingest` tool group is granted to the persona and is
**never granted to the team responder** — an outbound fetch of an arbitrary
URL is exactly the capability `team-read` exists to exclude. The handler
additionally refuses on team/forum surfaces. Uploaded media files are
**never auto-transcribed** by the extractor or the disk-sync watcher
(cost-safety: no trigger may cause unattended LLM spend); transcription
happens only through this explicit tool. The tool description carries the
copyright line: this is for the user's own reference material.

## Relation to the file layer

Media files in Files (`MEDIA_EXTS`: mp4/mov/webm/mkv/mp3/m4a/wav/ogg/flac)
are stored, served with real `audio/*`/`video/*` MIME types (which is what
lights up the inline players in chat, forums, and shares), and honestly
skipped by the extractor with disposition `unsupported_media` — findable by
name, indexed only when a transcript exists. See `packages/files/src/slug.ts`
and the hollow-body guard in `server/api/src/agent/extractor.ts`.

## Later (recorded on the dev-brain task, not built)

- Pages media embed (needs a markdown-legible node + a paired jackdaw
  release).
- A **video worker** for silent footage (scene description via keyframes —
  "identify the collision damage on the right front corner"), sharing the
  ffmpeg frame extractor with keyframe OCR for screen recordings.
- STT-path timestamps (needs adapter segment support) and >60-minute chunked
  transcription.
