/**
 * Google (Gemini) STT adapter — implemented on top of generateContent.
 *
 * Unlike every other STT provider we wire, Google doesn't have a
 * dedicated transcription endpoint. The pattern is to send the audio
 * as an inline `audio/...` part inside a normal generateContent call,
 * with a system instruction telling the model to output just the
 * transcript with no commentary. Gemini handles 99 languages this way.
 *
 * Endpoint: POST {GOOGLE_BASE_URL}/models/{model}:generateContent
 * Auth:     `x-goog-api-key` header (same as google-chat)
 * Body:     {
 *             systemInstruction: { parts: [{ text: "Transcribe verbatim..." }] },
 *             contents: [{ role: 'user', parts: [{ inlineData: { mimeType, data } }] }],
 *             generationConfig: { temperature: 0, maxOutputTokens: 8192 }
 *           }
 *
 * Inline-vs-File-upload caveat: the inline-data path has a 20 MB body
 * limit. Gemini also offers a separate `/upload/v1beta/files` flow for
 * larger audio, but our use case (voice notes, short test recordings)
 * fits well under 20 MB. If we ever need long-form transcription this
 * adapter will need a Files API branch — guarding here so a future
 * 30 MB voice clip fails loudly instead of silently truncating.
 *
 * Why temperature=0: we want deterministic transcription, not creative
 * paraphrase. Without this, Gemini occasionally "improves" the
 * transcript by fixing what it perceives as the speaker's grammar.
 *
 * Duration: not surfaced by generateContent. Like xAI/ElevenLabs we
 * return null and rely on caller-side caps.
 *
 * Discovery: hits the standard /v1beta/models endpoint and intersects
 * with our STT catalog (the same list-models call google-chat uses,
 * just filtered to audio-capable model ids).
 */

import type { SttDispatcher } from './types';
import type { TranscribeOptions, TranscribeResult } from '../types';
import type { SttModelInfo } from '../catalog';
import type { DiscoveryResult } from '../discover';
import { GOOGLE_BASE_URL, GOOGLE_STT_MODELS } from '../catalogs/google';

const DEFAULT_MODEL = 'gemini-2.5-flash';
/** Inline-data body limit. Beyond this size we should be using the
 *  Files API; refuse so a silent truncate can't ship bad transcripts. */
const INLINE_MAX_BYTES = 20 * 1024 * 1024;

type GeminiInlineDataPart = { inlineData: { mimeType: string; data: string } };
type GeminiTextPart = { text: string };
type GeminiPart = GeminiInlineDataPart | GeminiTextPart;

type GeminiResponse = {
  candidates?: Array<{
    content?: { parts?: GeminiTextPart[] };
    finishReason?: string;
  }>;
  modelVersion?: string;
};

type GeminiListModelsResponse = {
  models?: Array<{
    name: string;
    supportedGenerationMethods?: string[];
  }>;
};

function transcribePrompt(language: string | undefined): string {
  // Plain transcription prompt. We add the language hint when known
  // because Gemini occasionally translates the audio to English on
  // its own when the request is ambiguous.
  const langClause = language
    ? ` The audio is in ${language}. Output the transcript in the same language.`
    : '';
  return (
    "You are a transcription engine. Transcribe the user's audio VERBATIM." +
    langClause +
    ' Output only the transcript text — no commentary, no quotation marks, no labels.' +
    ' Preserve filler words and stutters. If there is no speech, output an empty string.'
  );
}

export const googleSttAdapter: SttDispatcher = {
  providerId: 'google',
  adapterName: 'google-stt',
  async transcribe(audio: Buffer, opts: TranscribeOptions): Promise<TranscribeResult> {
    if (!opts.apiKey) throw new Error('google-stt: apiKey required');
    if (!audio || audio.length === 0) {
      throw new Error('google-stt: empty audio buffer');
    }
    if (audio.length > INLINE_MAX_BYTES) {
      throw new Error(
        `google-stt: audio is ${(audio.length / 1024 / 1024).toFixed(1)} MB; Gemini's inline-data path caps at 20 MB. ` +
          `Switch to OpenAI or Deepgram for this clip, or implement the Files API upload path.`,
      );
    }

    const model = opts.model || DEFAULT_MODEL;
    const audioPart: GeminiInlineDataPart = {
      inlineData: {
        mimeType: opts.mimeType || 'audio/webm',
        data: audio.toString('base64'),
      },
    };
    const body = {
      systemInstruction: {
        parts: [{ text: transcribePrompt(opts.language) }] as GeminiPart[],
      },
      contents: [
        {
          role: 'user',
          parts: [audioPart] as GeminiPart[],
        },
      ],
      generationConfig: {
        // Deterministic transcription, not creative paraphrase.
        temperature: 0,
        // 8K output tokens covers ~6 min of normal-rate speech, well
        // beyond our 3-min default cap.
        maxOutputTokens: 8192,
      },
    };

    const url = `${GOOGLE_BASE_URL}/models/${encodeURIComponent(model)}:generateContent`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'x-goog-api-key': opts.apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      throw new Error(`google-stt ${res.status}: ${errBody.slice(0, 400)}`);
    }
    const parsed = (await res.json()) as GeminiResponse;
    const text = (parsed.candidates?.[0]?.content?.parts ?? [])
      .map((p) => p.text ?? '')
      .join('')
      .trim();
    return {
      text,
      language: opts.language ?? null,
      // generateContent doesn't return audio duration. See header note.
      durationSeconds: null,
      model: parsed.modelVersion || model,
    };
  },

  async discoverModels(apiKey: string): Promise<DiscoveryResult<SttModelInfo>> {
    try {
      const res = await fetch(`${GOOGLE_BASE_URL}/models?key=${encodeURIComponent(apiKey)}`, {
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`google list-models ${res.status}: ${body.slice(0, 300)}`);
      }
      const parsed = (await res.json()) as GeminiListModelsResponse;
      const ids = new Set<string>();
      for (const m of parsed.models ?? []) {
        // Names come back as 'models/gemini-2.5-flash'. Strip the prefix.
        const id = m.name.replace(/^models\//, '');
        if (m.supportedGenerationMethods?.includes('generateContent')) {
          ids.add(id);
        }
      }
      return {
        available: GOOGLE_STT_MODELS.filter((m) => ids.has(m.id)),
        filtered: true,
        error: null,
      };
    } catch (err) {
      return {
        available: [...GOOGLE_STT_MODELS],
        filtered: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },
};
