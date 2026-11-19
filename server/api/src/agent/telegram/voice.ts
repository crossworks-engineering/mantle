/**
 * Telegram turn, voice side: transcribing an inbound voice note before
 * anything downstream reads `row.text`, and the audio-tag prompt suffix that
 * tells the responder which speech cues its TTS worker honours. Split out of
 * runtime.ts on 2026-09-02 (audit, bloat B2).
 */
import { and, eq } from 'drizzle-orm';
import {
  db,
  telegramMessages,
  bumpWorkerUsage as bumpAiWorkerUsage,
  getDefaultWorker,
  getAgentTtsWorker,
  type Agent,
  type SttParams,
} from '@mantle/db';
import { accountById, downloadTelegramFile } from '@mantle/telegram';
import { getApiKeyById, resolveProviderKey } from '@mantle/api-keys';
import { composeAudioTagInstructions, getSttAdapter, getTtsAdapter } from '@mantle/voice';
import { step } from '@mantle/tracing';
import { callThroughWaits, errorMessage, providerWaitOf, type ProviderWait } from '@mantle/std';
import type { InboundRow } from './types';

/** What became of a voice note: its transcript was kept (`long`: longer
 *  than the STT worker's `max_duration_seconds`, read in full all the same),
 *  or not (`wait`: the provider said "not now", after the turn waited a
 *  little for it). */
export type VoiceTranscript =
  { ok: true; long: boolean; durationSeconds: number | null } | { ok: false; wait?: ProviderWait };

/** What the transcription calls: stand-ins in a test. */
export type VoiceDeps = {
  sleep?: (ms: number) => Promise<void>;
};

/** The default STT worker's `max_duration_seconds` when it sets none. */
export const VOICE_LONG_SECONDS = 180;

/**
 * Transcribe the voice note behind `voiceFileId`, then replace the placeholder
 * text on the in-memory row AND the DB row so the rest of the pipeline
 * (load_context, history, embeddings, extractor) sees real words.
 *
 * A note longer than the STT worker's `max_duration_seconds` is kept and
 * used whole (cap sweep L5; owner rule 2026-11-19, everything is consumed in
 * full): the duration is a word for the turn (`long`), never a reason to
 * throw a transcript that was paid for away. So the adapters are called
 * with no duration cap of their own (0).
 *
 * The provider's "not now" (a rate limit, busy: @mantle/std provider-wait.ts)
 * is waited through for a short while inside the turn
 * (callThroughWaits); still "not now", or no credit, the answer says so
 * (`wait`), and the turn tells the person why. Any other failure: `ok:
 * false`, and the sequencer apologises in text rather than crashing the
 * trace.
 */
export async function transcribeInboundVoice(args: {
  ownerId: string;
  row: InboundRow;
  voiceFileId: string;
  deps?: VoiceDeps;
}): Promise<VoiceTranscript> {
  const { ownerId, row, voiceFileId } = args;
  let wait: ProviderWait | undefined;
  const transcript = await step(
    {
      name: 'transcribe_voice',
      kind: 'compute',
      input: { fileId: voiceFileId },
    },
    async (h) => {
      // Look up the configured STT worker. If one exists with an
      // api_key, use its provider + model + params. Otherwise
      // fall back to the bare 'service=openai' key for backwards-
      // compat with older setups that haven't migrated to
      // ai_workers yet (treats it as an OpenAI/Whisper call).
      const sttWorker = await getDefaultWorker(ownerId, 'stt');
      let apiKey: string | null;
      let providerId = 'openai';
      let model = 'whisper-1';
      let language: string | undefined;
      let longSeconds = VOICE_LONG_SECONDS;
      if (sttWorker?.apiKeyId) {
        apiKey = (await getApiKeyById(sttWorker.apiKeyId))?.apiKey ?? null;
        providerId = sttWorker.provider;
        model = sttWorker.model;
        const sttParams = (sttWorker.params ?? {}) as SttParams;
        language = sttParams.language;
        longSeconds = sttParams.max_duration_seconds ?? VOICE_LONG_SECONDS;
      } else {
        apiKey = (await resolveProviderKey(ownerId, 'openai'))?.apiKey ?? null;
      }
      if (!apiKey) {
        h.setMeta({ error: 'no openai api_key configured' });
        throw new Error(
          'voice received but no OpenAI api_key configured. Either add an STT worker at /settings/ai-workers or add a bare openai key at /settings/api-keys.',
        );
      }
      const adapter = getSttAdapter(providerId);
      if (!adapter) {
        h.setMeta({ error: `no STT adapter for '${providerId}'` });
        throw new Error(
          `STT provider '${providerId}' is not yet wired. Currently supported: openai. ` +
            'Switch the STT worker to a wired provider at /settings/ai-workers.',
        );
      }
      const account = await accountById(row.accountId);
      if (!account) {
        throw new Error('no telegram account available for voice download');
      }
      const downloaded = await downloadTelegramFile(account, voiceFileId);
      h.setMeta({
        bytes: downloaded.bytes.length,
        worker_slug: sttWorker?.slug ?? null,
        adapter: adapter.adapterName,
      });
      // One call, waited through a short "not now". A throw that is no
      // wait ends here as before.
      type Try = { result?: Awaited<ReturnType<typeof adapter.transcribe>>; wait?: ProviderWait };
      const tried = await callThroughWaits<Try>(
        () =>
          adapter
            .transcribe(downloaded.bytes, {
              apiKey,
              mimeType: downloaded.mimeType,
              model,
              language,
              // No cap of the adapter's own: a long note is transcribed,
              // paid for, and kept (L5).
              maxDurationSeconds: 0,
            })
            .then(
              (result) => ({ result }),
              (err: unknown) => {
                const w = providerWaitOf(err);
                if (!w) throw err;
                return { wait: w };
              },
            ),
        (t) => t.wait,
        args.deps?.sleep ? { sleep: args.deps.sleep } : {},
      );
      if (!tried.result) {
        wait = tried.wait;
        h.setMeta({ wait: tried.wait?.reason ?? null });
        return null;
      }
      const result = tried.result;
      if (sttWorker) void bumpAiWorkerUsage(sttWorker.id);
      const long = result.durationSeconds != null && result.durationSeconds > longSeconds;
      h.setOutput({
        model: result.model,
        language: result.language,
        durationSeconds: result.durationSeconds,
        chars: result.text.length,
        ...(long ? { long: true, longSeconds } : {}),
      });
      return { ...result, long };
    },
  ).catch((err) => {
    console.error('[agent] voice transcription failed:', errorMessage(err));
    return null;
  });

  if (!transcript) return wait ? { ok: false, wait } : { ok: false };
  if (!transcript.text) return { ok: false };

  row.text = transcript.text;
  await db
    .update(telegramMessages)
    .set({
      text: transcript.text,
      attachments: (row.attachments ?? []).map((a) =>
        a.kind === 'voice'
          ? {
              ...a,
              transcript: transcript.text,
              transcript_model: transcript.model,
              transcript_language: transcript.language,
              duration_seconds: transcript.durationSeconds,
              ...(transcript.long ? { long: true } : {}),
            }
          : a,
      ),
    })
    .where(and(eq(telegramMessages.id, row.id)));
  return { ok: true, long: transcript.long, durationSeconds: transcript.durationSeconds };
}

/** The line before a long note's transcript in the turn: the responder
 *  hears that the note is long and was read in full. */
export function longVoiceNote(durationSeconds: number | null): string {
  if (durationSeconds == null) return '[A long voice note, transcribed in full.]';
  const s = Math.round(durationSeconds);
  return `[A long voice note (${Math.floor(s / 60)} min ${s % 60} s), transcribed in full.]`;
}

/** The apology of a voice note the provider would not transcribe now: why,
 *  in the provider-wait words, and what to do. */
export function voiceWaitApology(wait: ProviderWait): string {
  return wait.reason === 'quota'
    ? "I couldn't transcribe that voice note: the voice service's account has no credit left. Please type it out for now, or send it again once credit is added."
    : "I couldn't transcribe that voice note just now: the voice service is busy. Please send it again in a few minutes, or type it out.";
}

/**
 * Tell the responder which speech tags its configured TTS will honour:
 * inline cues (ElevenLabs v3 [laughs]/[sighs]; OpenAI none) AND wrapping
 * styles (xAI Grok <whisper>…</whisper>/<soft>/<slow>). Looked up once per
 * turn so the prompt stays current if the TTS worker is swapped between
 * turns. Empty when there is no TTS worker, no tags-capable model, or no
 * adapter — the prompt concat is then a no-op. Best-effort decoration: a DB
 * blip here never kills the turn.
 */
export async function audioTagInstructionsFor(ownerId: string, agent: Agent): Promise<string> {
  try {
    const ttsWorkerForTags = await getAgentTtsWorker(ownerId, agent.ttsWorkerId);
    if (!ttsWorkerForTags) return '';
    const ttsAdapterForTags = getTtsAdapter(ttsWorkerForTags.provider);
    const tags = ttsAdapterForTags?.supportedAudioTags?.(ttsWorkerForTags.model) ?? [];
    const wrappingTags = ttsAdapterForTags?.supportedWrappingTags?.(ttsWorkerForTags.model) ?? [];
    return composeAudioTagInstructions(tags, wrappingTags);
  } catch (err) {
    console.error('[agent] audio-tag prompt injection skipped:', errorMessage(err));
    return '';
  }
}
