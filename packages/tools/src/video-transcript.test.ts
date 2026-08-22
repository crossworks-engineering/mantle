/**
 * The caption→transcript logic decides what lands in the brain for every
 * ingested video, so we pin:
 *   - VTT parsing incl. the auto-caption shapes (hour-less timestamps,
 *     inline word-timing tags, rolling-window duplication);
 *   - the garbage heuristic's three trips (bracket-only, density, repetition)
 *     AND that a normal talk passes;
 *   - the markdown shape (## [m:ss] headings) the chunker's headingPath
 *     depends on.
 */

import { describe, expect, it } from 'vitest';
import {
  buildTranscriptMarkdown,
  captionsGarbageReason,
  formatTimestamp,
  parseVtt,
  transcriptWordCount,
  type CaptionCue,
} from './video-transcript';

const SIMPLE_VTT = `WEBVTT

00:00:01.000 --> 00:00:04.000
First we open the settings menu.

00:00:04.000 --> 00:00:08.000
Then we set the APN to internet.
`;

const AUTO_VTT = `WEBVTT
Kind: captions
Language: en

00:00:00.320 --> 00:00:02.800 align:start position:0%
first<00:00:00.560><c> we</c><00:00:01.040><c> open</c>

00:00:02.800 --> 00:00:05.200 align:start position:0%
first we open
the<00:00:03.200><c> settings</c><00:00:03.680><c> menu</c>
`;

describe('parseVtt', () => {
  it('parses plain cues with hour-less timestamps', () => {
    const cues = parseVtt(SIMPLE_VTT);
    expect(cues).toHaveLength(2);
    expect(cues[0]).toMatchObject({ startSec: 1, endSec: 4 });
    expect(cues[0]!.text).toBe('First we open the settings menu.');
  });

  it('parses hour-carrying timestamps', () => {
    const cues = parseVtt('WEBVTT\n\n01:02:03.500 --> 01:02:05.000\nhello\n');
    expect(cues[0]!.startSec).toBeCloseTo(3723.5);
  });

  it('strips inline word-timing tags and collapses the rolling window', () => {
    const cues = parseVtt(AUTO_VTT);
    expect(cues.map((c) => c.text)).toEqual(['first we open', 'the settings menu']);
  });
});

describe('captionsGarbageReason', () => {
  const cue = (text: string, i: number): CaptionCue => ({
    startSec: i * 4,
    endSec: i * 4 + 3,
    text,
  });

  it('accepts a normal talk', () => {
    const cues = Array.from({ length: 60 }, (_, i) =>
      cue(`sentence number ${i} explains a different concrete step of the setup`, i),
    );
    expect(captionsGarbageReason(cues, 240)).toBeNull();
  });

  it('flags a track that is mostly [Music]', () => {
    const cues = Array.from({ length: 20 }, (_, i) => cue(i % 10 === 0 ? 'yeah' : '[Music]', i));
    expect(captionsGarbageReason(cues, 80)).toMatch(/non-speech/);
  });

  it('flags density too low for the duration', () => {
    const cues = [cue('hello there everyone welcome back to the channel', 0)];
    expect(captionsGarbageReason(cues, 1800)).toMatch(/density/);
  });

  it('flags a repetitive loop on a long video', () => {
    const cues = Array.from({ length: 100 }, (_, i) => cue('la la la la la', i));
    expect(captionsGarbageReason(cues, 400)).toMatch(/repetitive/);
  });

  it('flags an empty parse', () => {
    expect(captionsGarbageReason([], 100)).toMatch(/zero cues/);
  });

  it('never second-guesses a trusted (manual) track beyond the zero-cue check', () => {
    // The exact shape that trips the auto heuristics: long video, terse
    // repetitive human captions. Trusted -> accepted.
    const cues = Array.from({ length: 100 }, (_, i) => cue('la la la la la', i));
    expect(captionsGarbageReason(cues, 14_400, { trusted: true })).toBeNull();
    expect(captionsGarbageReason([], 100, { trusted: true })).toMatch(/zero cues/);
  });
});

describe('buildTranscriptMarkdown', () => {
  it('sections on ~45s boundaries with timestamp headings', () => {
    const cues: CaptionCue[] = Array.from({ length: 20 }, (_, i) => ({
      startSec: i * 10,
      endSec: i * 10 + 8,
      text: `sentence ${i}.`,
    }));
    const md = buildTranscriptMarkdown(cues);
    expect(md).toContain('## [0:00]');
    expect(md).toContain('## [0:50]');
    // No section splits mid-cue: every sentence appears exactly once.
    for (let i = 0; i < 20; i++) expect(md).toContain(`sentence ${i}.`);
  });

  it('drops bracket-only cues from the body', () => {
    const md = buildTranscriptMarkdown([
      { startSec: 0, endSec: 2, text: '[Music]' },
      { startSec: 2, endSec: 5, text: 'real words' },
    ]);
    expect(md).not.toContain('[Music]');
    expect(md).toContain('real words');
  });
});

describe('formatTimestamp', () => {
  it('formats minutes and hours', () => {
    expect(formatTimestamp(0)).toBe('0:00');
    expect(formatTimestamp(754.2)).toBe('12:34');
    expect(formatTimestamp(3921)).toBe('1:05:21');
  });
});

describe('transcriptWordCount', () => {
  it('counts body words, not headings', () => {
    expect(transcriptWordCount('## [0:00]\n\none two three')).toBe(3);
  });
});
