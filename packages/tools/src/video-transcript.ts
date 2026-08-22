/**
 * Pure caption-track → transcript-markdown logic for `video_ingest`.
 *
 * Kept side-effect-free and separate from the tool so the three judgement
 * calls that decide what lands in the brain are unit-testable without a
 * sidecar or an LLM:
 *
 *   1. VTT parsing incl. the auto-caption mess (inline word-timing tags,
 *      rolling-window line duplication);
 *   2. the garbage heuristic — auto captions on music/noise produce tracks
 *      that LOOK like transcripts and index as junk; falling back to STT is
 *      the right move and must be a decision, not an accident;
 *   3. the markdown shape: `## [m:ss]` section headings, because the chunker
 *      (packages/content/src/chunk.ts) folds markdown headings into each
 *      retrieval chunk's headingPath — that is what makes "what did he say
 *      at 4:12" answerable from a chunk, for free.
 */

export type CaptionCue = { startSec: number; endSec: number; text: string };

const TS_RE = /(?:(\d{1,2}):)?(\d{1,2}):(\d{2})\.(\d{3})/;
const CUE_LINE_RE = new RegExp(`^${TS_RE.source}\\s+-->\\s+${TS_RE.source}`);

function parseTs(m: RegExpMatchArray, offset: number): number {
  const h = m[offset] ? parseInt(m[offset]!, 10) : 0;
  const min = parseInt(m[offset + 1]!, 10);
  const s = parseInt(m[offset + 2]!, 10);
  const ms = parseInt(m[offset + 3]!, 10);
  return h * 3600 + min * 60 + s + ms / 1000;
}

/** Strip inline VTT/auto-caption markup: word-timing tags, <c> spans, &nbsp;. */
function cleanCueText(raw: string): string {
  return raw
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Parse a WEBVTT track into cues, collapsing the auto-caption rolling window
 * (each cue repeats the previous cue's line before adding its own — kept
 * verbatim, a 10-minute video reads twice as long and every sentence appears
 * twice in the index).
 */
export function parseVtt(content: string): CaptionCue[] {
  const cues: CaptionCue[] = [];
  const lines = content.split(/\r?\n/);
  let i = 0;
  let lastLines: string[] = [];
  while (i < lines.length) {
    const m = CUE_LINE_RE.exec(lines[i]!.trim());
    if (!m) {
      i++;
      continue;
    }
    const startSec = parseTs(m, 1);
    const endSec = parseTs(m, 5);
    i++;
    const textLines: string[] = [];
    while (i < lines.length && lines[i]!.trim() !== '' && !CUE_LINE_RE.test(lines[i]!.trim())) {
      const cleaned = cleanCueText(lines[i]!);
      if (cleaned) textLines.push(cleaned);
      i++;
    }
    // Rolling-window dedupe: drop leading lines that just repeat the tail of
    // the previous cue.
    let fresh = textLines;
    for (let k = 0; k < textLines.length; k++) {
      const tail = lastLines.slice(lastLines.length - (textLines.length - k));
      if (tail.length && tail.join('\n') === textLines.slice(0, tail.length).join('\n')) {
        fresh = textLines.slice(tail.length);
        break;
      }
    }
    lastLines = textLines;
    const text = fresh.join(' ').trim();
    if (text) cues.push({ startSec, endSec, text });
  }
  return cues;
}

/** `[Music]`, `[Applause]`, `(laughs)` … — a cue with no actual speech. */
function isBracketOnly(text: string): boolean {
  return /^[\s[\](){}♪♫.…-]*(\[[^\]]*\]|\([^)]*\)|♪+)[\s[\](){}♪♫.…-]*$/.test(text);
}

/**
 * Cheap no-LLM screen for caption tracks that exist but carry no usable
 * speech. Returns the human-readable reason (goes into the tool's `notes`
 * and the trace) or null when the track looks fine. Thresholds are heuristics
 * tuned to fail toward STT — a wrongly-rejected good track costs one
 * transcription; a wrongly-accepted junk track pollutes the index silently.
 */
export function captionsGarbageReason(
  cues: CaptionCue[],
  durationSeconds: number | null,
): string | null {
  if (cues.length === 0) return 'caption track parsed to zero cues';
  const speech = cues.filter((c) => !isBracketOnly(c.text));
  if (cues.length >= 5 && speech.length / cues.length < 0.2) {
    return `captions are ${Math.round((1 - speech.length / cues.length) * 100)}% non-speech markers ([Music] etc.)`;
  }
  const words = speech.flatMap((c) => c.text.toLowerCase().split(/\s+/).filter(Boolean));
  const minutes = durationSeconds ? durationSeconds / 60 : null;
  const floor = Math.max(20, minutes ? Math.round(minutes * 10) : 20);
  if (words.length < floor) {
    return `caption density too low (${words.length} words${minutes ? ` over ${Math.round(minutes)} min` : ''})`;
  }
  if (durationSeconds != null && durationSeconds > 120) {
    // 0.08, not higher: vocabulary ratio falls naturally with length (a real
    // hour-long talk can sit near 0.13), while looped filler ("la la la",
    // repeated jingle lines) sits near 0.01. The gap is wide; aim between.
    const unique = new Set(words).size;
    if (unique / words.length < 0.08) {
      return `caption vocabulary suspiciously repetitive (${unique} unique of ${words.length} words)`;
    }
  }
  return null;
}

/** `754.2` → `12:34`; `3921` → `1:05:21`. */
export function formatTimestamp(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rest = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${rest}` : `${m}:${rest}`;
}

/**
 * Cues → markdown. Sections of ~`sectionSeconds`, each headed `## [m:ss]` so
 * chunk headingPath carries the timestamp anchor. Section breaks only happen
 * on cue boundaries — a sentence is never split mid-cue.
 */
export function buildTranscriptMarkdown(cues: CaptionCue[], sectionSeconds = 45): string {
  const sections: string[] = [];
  let sectionStart: number | null = null;
  let buffer: string[] = [];
  const flush = () => {
    if (sectionStart == null || buffer.length === 0) return;
    sections.push(`## [${formatTimestamp(sectionStart)}]\n\n${buffer.join(' ')}`);
    buffer = [];
  };
  for (const cue of cues) {
    if (isBracketOnly(cue.text)) continue;
    if (sectionStart == null) sectionStart = cue.startSec;
    if (cue.startSec - sectionStart >= sectionSeconds && buffer.length > 0) {
      flush();
      sectionStart = cue.startSec;
    }
    buffer.push(cue.text);
  }
  flush();
  return sections.join('\n\n');
}

/** Word count over the built transcript body (headings excluded). */
export function transcriptWordCount(markdown: string): number {
  return markdown
    .split('\n')
    .filter((l) => !l.startsWith('## ['))
    .join(' ')
    .split(/\s+/)
    .filter(Boolean).length;
}
