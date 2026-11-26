/**
 * OpenRouter's billed cost reaches the recorder, on every capability
 * (docs/spend-recording.md, "Cost"). A made-up reply with `usage.cost` goes
 * in at the wire; the adapter's result carries it as `reportedCostUsd`, and
 * the usage the recording point writes carries it too.
 *
 * Why: until 2026-11-26 the vision reads built their result without the
 * cost, and the embedding, image and transcription adapters never read it.
 * Each call was priced from the static table, and a model with no row there
 * was recorded at $0 while the provider billed it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ recorded: [] as Array<Record<string, unknown>> }));

vi.mock('@mantle/tracing', async (orig) => ({
  ...(await orig<typeof import('@mantle/tracing')>()),
  recordUsage: (u: Record<string, unknown>) => {
    h.recorded.push(u);
    return 0;
  },
}));

import { openrouterEmbedding } from './openrouter-embedding';
import { openrouterImageAdapter } from './openrouter-image';
import { openrouterSttAdapter } from './openrouter-stt';
import { openrouterVisionAdapter } from './openrouter-vision';
import {
  recordingEmbedding,
  recordingImageGen,
  recordingStt,
  recordingVision,
  REPORTS_COST,
} from './spend';
import { extractImages } from './vision-images';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  h.recorded.length = 0;
});

function reply(body: unknown): void {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;
}

const COST = 0.004321;
/** A model with no row in the price table: only the reported cost prices it. */
const MODEL = 'made-up/vision-model';
const chatReply = (extra: Record<string, unknown> = {}) => ({
  model: MODEL,
  choices: [{ finish_reason: 'stop', message: { content: 'read', ...extra } }],
  usage: { prompt_tokens: 1500, completion_tokens: 400, cost: COST },
});
const png = Buffer.from('made-up image');
const pdf = Buffer.from('%PDF-1.4 made-up');
const visionOpts = { apiKey: 'k', model: MODEL, prompt: 'read it', mimeType: 'image/png' };

/** One case per capability: the call, and the cost its result must carry. */
const CASES: Array<{
  name: string;
  capability: string;
  run: () => Promise<{ reportedCostUsd?: number }>;
}> = [
  {
    name: 'vision: one image',
    capability: 'vision',
    run: () => {
      reply(chatReply());
      return recordingVision(openrouterVisionAdapter).extract(png, visionOpts);
    },
  },
  {
    name: 'vision: a document',
    capability: 'vision',
    run: () => {
      reply(chatReply());
      return recordingVision(openrouterVisionAdapter).extractDocument!(pdf, {
        ...visionOpts,
        mimeType: 'application/pdf',
      });
    },
  },
  {
    name: 'vision: several images',
    capability: 'vision',
    run: () => {
      reply(chatReply());
      return extractImages('openrouter', [{ bytes: png, mimeType: 'image/png' }], visionOpts);
    },
  },
  {
    name: 'vision: a parsed PDF page',
    capability: 'vision',
    run: () => {
      reply(
        chatReply({
          annotations: [{ type: 'file', file: { content: [{ type: 'text', text: 'PAGE' }] } }],
        }),
      );
      return recordingVision(openrouterVisionAdapter).parsePdf!(pdf, {
        apiKey: 'k',
        model: MODEL,
        engine: 'mistral-ocr',
      });
    },
  },
  {
    name: 'embedding',
    capability: 'embedding',
    run: () => {
      reply({
        data: [{ embedding: [0.1, 0.2], index: 0 }],
        model: MODEL,
        usage: { prompt_tokens: 9000, total_tokens: 9000, cost: COST },
      });
      return recordingEmbedding(openrouterEmbedding).embed({
        apiKey: 'k',
        model: MODEL,
        input: ['some text'],
      });
    },
  },
  {
    name: 'image generation',
    capability: 'image_gen',
    run: () => {
      reply({
        data: [{ b64_json: png.toString('base64'), media_type: 'image/png' }],
        usage: { prompt_tokens: 12, completion_tokens: 1290, total_tokens: 1302, cost: COST },
      });
      return recordingImageGen(openrouterImageAdapter).generate({
        apiKey: 'k',
        model: MODEL,
        prompt: 'a made-up picture',
      });
    },
  },
  {
    name: 'transcription',
    capability: 'stt',
    run: () => {
      reply({ text: 'made-up words', usage: { seconds: 9.2, total_tokens: 40, cost: COST } });
      return recordingStt(openrouterSttAdapter).transcribe(Buffer.from('made-up audio'), {
        apiKey: 'k',
        model: MODEL,
        mimeType: 'audio/ogg',
      });
    },
  },
];

describe('openrouter: the billed cost reaches the recorder', () => {
  for (const c of CASES) {
    it(`${c.name}: usage.cost is the result's reportedCostUsd and the recorded cost`, async () => {
      const result = await c.run();
      expect(result.reportedCostUsd).toBe(COST);
      expect(h.recorded).toHaveLength(1);
      expect(h.recorded[0]).toMatchObject({
        capability: c.capability,
        provider: 'openrouter',
        reportedCostUsd: COST,
      });
    });
  }

  it('a reply with no cost records none (the price table then prices it)', async () => {
    reply({ data: [{ embedding: [0.1], index: 0 }], usage: { prompt_tokens: 3 } });
    const r = await recordingEmbedding(openrouterEmbedding).embed({
      apiKey: 'k',
      model: MODEL,
      input: ['x'],
    });
    expect(r.reportedCostUsd).toBeUndefined();
    expect(h.recorded[0]).not.toHaveProperty('reportedCostUsd');
  });

  it('every capability OpenRouter is listed to report a cost on has a test', () => {
    // Chat and stream: openrouter-chat.test.ts ("surfaces reportedCostUsd").
    // Decision: openrouter-decision.test.ts. Research (the research tool's
    // own call): captureLlmUsage in packages/tracing/src/spend.test.ts.
    const elsewhere = ['chat', 'decision', 'research'];
    const here = CASES.map((c) => c.capability);
    for (const capability of REPORTS_COST.openrouter ?? []) {
      expect([...here, ...elsewhere], capability).toContain(capability);
    }
    // Speech answers with raw audio and no cost: it must not be listed.
    expect(REPORTS_COST.openrouter).not.toContain('tts');
  });
});
