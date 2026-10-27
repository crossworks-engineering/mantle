# Video ingest: upload a recording, get a searchable transcript

`video_ingest` turns a recording into knowledge the brain can answer from: a
transcript **page** (summarised, embedded, chunked like any other page) plus
a durable **audio clip** in Files. The point is that "what did that
recording say about the valve change" is answerable months later, from the
brain, without the video.

## One entry point: an uploaded file

The tool takes `file_node_id`, a video or audio file already in Files. The
pipeline (`packages/tools/src/builtins-video.ts`):

1. the size and type gates run on the file's metadata, before any byte is
   read;
2. the speech-to-text worker is resolved before the bytes too: audio is
   never extracted for a transcription that cannot run;
3. the parser service takes the audio track out with ffmpeg
   (`POST /extract-audio`, [parser.md](parser.md)); the duration cap is
   checked there before any transcoding;
4. the mp3 is saved beside the source in the same folder
   (`<name>-audio.mp3`, never overwriting) **before** transcription;
5. speech to text, then the transcript page, linked to its sources by
   `data.sourceFileId` (the derived-node convention, so reaping and the
   integrity audit see them).

**No links.** The tool fetches nothing. Passing a `url` is refused with
"video_ingest does not fetch links. Ask the user to download the video and
upload the file, then pass its file_node_id." The link path (yt-dlp and a
captions-first read in the media sidecar) was removed with the sidecar when
the parser service replaced it: a video on the web is downloaded by the user
and uploaded like any other file.

STT transcripts are a single untimestamped body (adapters return plain
text, no segments), and the reply says the text is machine-transcribed.

## Caps

| env | default | what it bounds |
|---|---|---|
| `VIDEO_INGEST_MAX_STT_DURATION_S` | 3600 | the recording's length. Deliberately NOT the voice path's 180 s: that cap refuses long mic clips; paying for a 40-minute recording is this feature's job. 60 min at 32 kbps mono is about 14.4 MB, inside Google's 20 MB inline and Whisper's 25 MB caps. |
| `VIDEO_INGEST_MAX_AUDIO_BYTES` | 20 MB | the extracted clip's size |
| `VIDEO_INGEST_MAX_FILE_BYTES` | 1 GiB | the uploaded recording the tool reads |

The old names (`MEDIA_MAX_STT_DURATION_S`, `MEDIA_MAX_AUDIO_BYTES`,
`MEDIA_MAX_VIDEO_BYTES`) are still read on a box that sets them and not the
new ones. The parser's own body cap (`PARSER_MAX_UPLOAD_MB`, default 1024)
bounds what it accepts.

## Failure honesty

Every dead end is a structured error naming the recovery move, and a
half-completed run is an explicit **partial success**, never a silent one:
the audio clip is saved *before* transcription, so a failed STT returns the
audio file id and "Re-run later." A transcript whose page
creation failed comes back with a preview so the text isn't lost to the turn.

## Safety and grants

Owner-only. The `video-ingest` tool group is granted to the persona and is
**never granted to the team responder**: it spends the owner's STT key. The
handler additionally refuses on team and forum surfaces. Uploaded media files are
**never auto-transcribed** by the extractor or the disk-sync watcher
(cost-safety: no trigger may cause unattended LLM spend); transcription
happens only through this explicit tool. The tool description carries the
copyright line: this is for the user's own reference material.

## Relation to the file layer

Media files in Files (`MEDIA_EXTS`: mp4/mov/webm/mkv/mp3/m4a/wav/ogg/flac)
are stored, served with real `audio/*`/`video/*` MIME types (which is what
lights up the inline players in chat, forums, and shares), and honestly
skipped by the extractor with disposition `unsupported_media`: findable by
name, indexed only when a transcript exists. See `packages/files/src/slug.ts`
and the hollow-body guard in `server/api/src/agent/extractor.ts`.

## Later (recorded on the dev-brain task, not built)

- Pages media embed (needs a markdown-legible node + a paired jackdaw
  release).
- A **video worker** for silent footage (scene description via keyframes:
  "identify the collision damage on the right front corner"), sharing an
  ffmpeg frame extractor in the parser with keyframe OCR for screen recordings.
- STT-path timestamps (needs adapter segment support) and >60-minute chunked
  transcription.
