/**
 * Extractor: the vision asks of an own Reader (docs/pipelines.md, "Vision
 * asks of an own Reader"). An own Reader's step may ask the box's vision
 * worker a question on a picture it wrote (`needs.workers.vision`, at most
 * READER_VISION_ASKS_MAX a file, the runner holds the cap). The file
 * database pass (./auto-table.ts) gives this answer only while the file has
 * no database for its bytes, so the same bytes are not asked about again.
 *
 * The file database pass runs before the extract's own cost guard, so this
 * asks the same guard itself (`llmWorkAllowed`), as the decider does
 * (./pdf-kind.ts): a file that gets no model work gets no vision call, and
 * none of its pictures leave the box.
 */
import { llmWorkAllowed } from '@mantle/db';
import {
  READER_VISION_QUESTION_MAX,
  VISION_WORKER,
  type PipelineCall,
  type PipelineCallAnswer,
  type ReaderVisionAsk,
} from '@mantle/files';
import { runVisionWorker } from '@mantle/runtime/agent';
import { step } from '@mantle/tracing';

/** The largest picture one ask sends, in bytes. */
export const READER_VISION_PICTURE_MAX_BYTES = 10 * 1024 * 1024;
/** The longest answer of one ask, in tokens. */
const ANSWER_MAX_TOKENS = 1500;

/** The picture type by its first bytes: the three every vision provider
 *  takes. Null: none of them. */
export function visionMimeOf(bytes: Buffer): string | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) {
    return 'image/png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    bytes.length >= 12 &&
    bytes.toString('latin1', 0, 4) === 'RIFF' &&
    bytes.toString('latin1', 8, 12) === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

/** The picture and the question of a vision ask, or why it is refused. */
export function visionAskOf(
  call: PipelineCall & { call: 'worker' },
  pictures: ReadonlyMap<string, Buffer>,
): { bytes: Buffer; mime: string; question: string } | { refused: string } {
  if (call.worker !== VISION_WORKER) return { refused: 'not the vision worker' };
  const input = (call.input ?? {}) as Partial<Record<keyof ReaderVisionAsk, unknown>>;
  const { picture, question } = input;
  if (typeof picture !== 'string' || typeof question !== 'string') {
    return { refused: 'a vision ask names a picture and a question' };
  }
  if (question.trim() === '' || question.length > READER_VISION_QUESTION_MAX) {
    return { refused: `the question is 1 to ${READER_VISION_QUESTION_MAX} characters` };
  }
  const bytes = pictures.get(picture);
  if (!bytes) return { refused: 'the picture is not in the step answer' };
  if (bytes.length > READER_VISION_PICTURE_MAX_BYTES) {
    return { refused: 'the picture is over 10 MB' };
  }
  const mime = visionMimeOf(bytes);
  if (!mime) return { refused: 'the picture is not a PNG, JPEG or WebP' };
  return { bytes, mime, question };
}

/**
 * Answer one vision ask of an own Reader's step: `{ text, model }`, or
 * `refused` (a bad ask, or no model work for this file) or `not_available`
 * (no vision worker, or it gave no text). The call and its spend are a step
 * of the upload's trace.
 */
export async function askReaderVision(
  ownerId: string,
  nodeId: string,
  call: PipelineCall & { call: 'worker' },
  pictures: ReadonlyMap<string, Buffer>,
): Promise<PipelineCallAnswer> {
  const ask = visionAskOf(call, pictures);
  if ('refused' in ask) return { ok: false, error: 'refused', reason: ask.refused };
  if (!(await llmWorkAllowed(nodeId))) {
    return { ok: false, error: 'refused', reason: 'no model work for this file' };
  }
  const r = await step(
    {
      name: 'reader_vision_ask',
      kind: 'llm_call',
      input: { mime: ask.mime, bytes: ask.bytes.length },
    },
    async (h) => {
      const out = await runVisionWorker({
        ownerId,
        bytes: ask.bytes,
        mimeType: ask.mime,
        prompt: ask.question,
        maxTokens: ANSWER_MAX_TOKENS,
        leastThinking: true,
      });
      h.setMeta({
        ran: out.ran,
        note: out.note,
        model: out.model,
        adapter: out.adapterName,
        tokensIn: out.tokensIn,
        tokensOut: out.tokensOut,
        textLength: out.text.length,
      });
      return out;
    },
  );
  if (!r.text) return { ok: false, error: 'not_available', reason: r.note ?? 'no text' };
  return { ok: true, output: { text: r.text, model: r.model } };
}
