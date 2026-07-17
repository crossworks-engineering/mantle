import { describe, expect, it } from 'vitest';
import {
  parseOpenRouter,
  parseOpenAiLike,
  parseAnthropic,
  parseGoogle,
  parseMistral,
  parseCohere,
  parseXaiLanguageModels,
  queryModels,
} from './model-explorer';
import type { ExplorerModel } from './model-explorer';

describe('parseOpenRouter', () => {
  it('extracts context, pricing (per-1M), modality, and keeps raw', () => {
    const m = parseOpenRouter([
      {
        id: 'anthropic/claude-sonnet-4.6',
        name: 'Anthropic: Claude Sonnet 4.6',
        description: 'A great model',
        created: 1_700_000_000,
        context_length: 200000,
        architecture: { modality: 'text+image->text', input_modalities: ['text', 'image'] },
        pricing: { prompt: '0.000003', completion: '0.000015', image: '0.0048', request: '0' },
        top_provider: { context_length: 1000000, max_completion_tokens: 64000 },
      },
    ])[0]!;
    expect(m.id).toBe('anthropic/claude-sonnet-4.6');
    expect(m.name).toBe('Anthropic: Claude Sonnet 4.6');
    expect(m.contextTokens).toBe(1000000); // top_provider wins over model-level
    expect(m.maxOutputTokens).toBe(64000);
    expect(m.inputPricePerM).toBeCloseTo(3, 6);
    expect(m.outputPricePerM).toBeCloseTo(15, 6);
    expect(m.modality).toBe('text+image->text');
    expect(m.created).toBe(new Date(1_700_000_000 * 1000).toISOString());
    // only nonzero, non-prompt/completion dims surface as extras
    expect(m.extraPricing).toEqual([{ label: 'image', value: '$0.0048' }]);
    expect(m.raw).toBeTruthy();
  });

  it('keeps free models (0 price) as 0, not undefined', () => {
    const m = parseOpenRouter([
      { id: 'x/free', context_length: 8000, pricing: { prompt: '0', completion: '0' } },
    ])[0]!;
    expect(m.inputPricePerM).toBe(0);
    expect(m.outputPricePerM).toBe(0);
    expect(m.extraPricing).toBeUndefined();
  });
});

describe('parseOpenAiLike', () => {
  it('maps bare ids and infers kind', () => {
    const rows = parseOpenAiLike([
      { id: 'gpt-4o', created: 1_700_000_000 },
      { id: 'text-embedding-3-large' },
      { id: 'whisper-1' },
      { id: 'dall-e-3' },
    ]);
    expect(rows.map((r) => r.kind)).toEqual(['chat', 'embedding', 'stt', 'image']);
    expect(rows[0]!.created).toBe(new Date(1_700_000_000 * 1000).toISOString());
  });
});

describe('parseAnthropic', () => {
  it('uses display_name + created_at', () => {
    const m = parseAnthropic([
      {
        type: 'model',
        id: 'claude-opus-4-7',
        display_name: 'Claude Opus 4.7',
        created_at: '2026-01-01T00:00:00Z',
      },
    ])[0]!;
    expect(m.id).toBe('claude-opus-4-7');
    expect(m.name).toBe('Claude Opus 4.7');
    expect(m.created).toBe('2026-01-01T00:00:00Z');
    expect(m.kind).toBe('chat');
  });
});

describe('parseGoogle', () => {
  it('strips models/ prefix, reads token limits + method-based kind', () => {
    const rows = parseGoogle([
      {
        name: 'models/gemini-2.5-pro',
        displayName: 'Gemini 2.5 Pro',
        inputTokenLimit: 1048576,
        outputTokenLimit: 65536,
        supportedGenerationMethods: ['generateContent'],
      },
      {
        name: 'models/text-embedding-004',
        supportedGenerationMethods: ['embedContent'],
      },
    ]);
    expect(rows[0]!.id).toBe('gemini-2.5-pro');
    expect(rows[0]!.contextTokens).toBe(1048576);
    expect(rows[0]!.maxOutputTokens).toBe(65536);
    expect(rows[0]!.kind).toBe('chat');
    expect(rows[1]!.kind).toBe('embedding');
  });
});

describe('parseMistral', () => {
  it('reads max_context_length + vision capability', () => {
    const m = parseMistral([
      {
        id: 'pixtral-large',
        description: 'multimodal',
        max_context_length: 131072,
        capabilities: { completion_chat: true, vision: true },
      },
    ])[0]!;
    expect(m.contextTokens).toBe(131072);
    expect(m.modality).toBe('text+image→text');
  });
});

describe('parseCohere', () => {
  it('derives kind from endpoints', () => {
    const rows = parseCohere([
      { name: 'command-r-plus', endpoints: ['chat'], context_length: 128000 },
      { name: 'embed-v4', endpoints: ['embed'] },
      { name: 'rerank-v3', endpoints: ['rerank'] },
    ]);
    expect(rows.map((r) => r.kind)).toEqual(['chat', 'embedding', 'rerank']);
    expect(rows[0]!.contextTokens).toBe(128000);
  });
});

describe('parseXaiLanguageModels', () => {
  it('builds modality and surfaces prices verbatim', () => {
    const m = parseXaiLanguageModels([
      {
        id: 'grok-4',
        input_modalities: ['text', 'image'],
        output_modalities: ['text'],
        prompt_text_token_price: 30,
        completion_text_token_price: 150,
      },
    ])[0]!;
    expect(m.modality).toBe('text+image→text');
    expect(m.extraPricing).toEqual([
      { label: 'prompt text token price', value: '30' },
      { label: 'completion text token price', value: '150' },
    ]);
  });
});

describe('queryModels', () => {
  const mk = (over: Partial<ExplorerModel> & { id: string }): ExplorerModel => ({
    raw: {},
    ...over,
  });
  const models: ExplorerModel[] = [
    mk({ id: 'a/chat', name: 'Alpha', kind: 'chat', contextTokens: 100, inputPricePerM: 5 }),
    mk({ id: 'b/embed', name: 'Beta', kind: 'embedding', contextTokens: 800, inputPricePerM: 1 }),
    mk({ id: 'c/chat', name: 'Gamma', kind: 'chat', contextTokens: 400, inputPricePerM: 9 }),
  ];

  it('returns distinct kinds over the full list', () => {
    const { kinds } = queryModels(models, { limit: 50, offset: 0 });
    expect(kinds).toEqual(['chat', 'embedding']);
  });

  it('filters by query (id/name/description)', () => {
    const { rows, total } = queryModels(models, { q: 'beta', limit: 50, offset: 0 });
    expect(total).toBe(1);
    expect(rows[0]!.id).toBe('b/embed');
  });

  it('filters by kind', () => {
    const { total } = queryModels(models, { kind: 'chat', limit: 50, offset: 0 });
    expect(total).toBe(2);
  });

  it('sorts by context desc and paginates', () => {
    const { rows, total } = queryModels(models, { sort: 'context', limit: 2, offset: 0 });
    expect(total).toBe(3);
    expect(rows.map((r) => r.id)).toEqual(['b/embed', 'c/chat']); // 800, 400
  });

  it('sorts by input price asc', () => {
    const { rows } = queryModels(models, { sort: 'input', limit: 50, offset: 0 });
    expect(rows.map((r) => r.inputPricePerM)).toEqual([1, 5, 9]);
  });
});

describe('robustness', () => {
  it('tolerates empty / malformed entries without throwing', () => {
    expect(() => parseOpenRouter([{}, null as unknown as object])).not.toThrow();
    expect(parseOpenAiLike([{}]).at(0)?.id).toBe('');
  });
});
