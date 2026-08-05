/**
 * generate_image's parameter surface.
 *
 * Two mechanisms, one purpose: an option must never LOOK like it applied when
 * it didn't. The field failure was an OpenRouter worker with
 * `{size, style, quality}` saved and shown in the UI, an adapter that sent
 * none of them, and no trace anywhere recording the gap.
 *
 *  · `withImageModelSchema` removes options the configured model can't take
 *    and constrains the rest to its catalog values, so a wrong value is
 *    unrepresentable rather than discouraged in prose.
 *  · the handler's applied/ignored split reports whatever still slips past.
 */

import { describe, expect, it } from 'vitest';
import { withImageModelSchema } from './builtins-workers';
import type { ImageGenModelInfo } from '@mantle/voice';

const SCHEMA = {
  type: 'object',
  properties: {
    prompt: { type: 'string', description: 'The image prompt.' },
    size: { type: 'string', description: 'Output dimensions.' },
    aspect_ratio: { type: 'string', description: 'Shape.' },
    style: { type: 'string', description: 'Style steering.' },
    quality: { type: 'string', description: 'Quality tier.' },
    negative_prompt: { type: 'string', description: 'What to avoid.' },
  },
  required: ['prompt'],
};

const DALLE3: ImageGenModelInfo = {
  id: 'dall-e-3',
  label: 'DALL-E 3',
  description: '',
  supportedSizes: ['1024x1024', '1024x1792', '1792x1024'],
  supportedStyles: ['vivid', 'natural'],
  supportedQualities: ['standard', 'hd'],
};

const props = (s: Record<string, unknown>) =>
  s.properties as Record<string, Record<string, unknown>>;

describe('withImageModelSchema', () => {
  it('constrains supported options to the model’s own values', () => {
    const out = withImageModelSchema(
      SCHEMA,
      ['size', 'style', 'quality'],
      DALLE3,
      'openai/dall-e-3',
    );
    expect(props(out).size!.enum).toEqual(['1024x1024', '1024x1792', '1792x1024']);
    expect(props(out).style!.enum).toEqual(['vivid', 'natural']);
    expect(props(out).quality!.enum).toEqual(['standard', 'hd']);
    expect(props(out).size!.description).toContain('openai/dall-e-3 accepts');
  });

  it('REMOVES options the adapter does not forward', () => {
    const out = withImageModelSchema(
      SCHEMA,
      ['size', 'style', 'quality'],
      DALLE3,
      'openai/dall-e-3',
    );
    // Neither is on the OpenAI images endpoint; offering them would invite a
    // request that silently evaporates.
    expect(props(out)).not.toHaveProperty('negative_prompt');
    expect(props(out)).not.toHaveProperty('aspect_ratio');
  });

  it('always keeps prompt and never mutates the shared singleton', () => {
    const before = JSON.stringify(SCHEMA);
    const out = withImageModelSchema(SCHEMA, [], undefined, 'xai/grok-imagine-image');
    expect(props(out)).toHaveProperty('prompt');
    expect(Object.keys(props(out))).toEqual(['prompt']);
    expect(JSON.stringify(SCHEMA)).toBe(before);
  });

  it('keeps a supported option unconstrained when the catalog has no list', () => {
    const hf: ImageGenModelInfo = { id: 'flux', label: 'FLUX', description: '' };
    const out = withImageModelSchema(SCHEMA, ['size', 'negativePrompt'], hf, 'huggingface/flux');
    expect(props(out).size).not.toHaveProperty('enum');
    expect(props(out)).toHaveProperty('negative_prompt');
  });

  it('survives a model that is not in its provider’s catalog', () => {
    const out = withImageModelSchema(SCHEMA, ['size'], undefined, 'openai/some-new-model');
    expect(props(out).size).not.toHaveProperty('enum');
    expect(Object.keys(props(out))).toEqual(['prompt', 'size']);
  });
});

const GPT_IMAGE_1: ImageGenModelInfo = {
  id: 'gpt-image-1',
  label: 'gpt-image-1',
  description: '',
  supportedSizes: ['1024x1024', '1024x1536', '1536x1024'],
  supportedQualities: ['low', 'medium', 'high', 'auto'],
  // no supportedStyles: this model has no style knob at all
};

describe('withImageModelSchema — catalog-gated options', () => {
  it('drops style on a model that lists none, even though the PROVIDER has it', () => {
    // `supports` is per-provider and OpenAI does offer style, on dall-e-3.
    // Offering it on gpt-image-1 would produce a request the adapter then
    // has to warn about.
    const out = withImageModelSchema(
      SCHEMA,
      ['size', 'style', 'quality'],
      GPT_IMAGE_1,
      'openai/gpt-image-1',
    );
    expect(props(out)).not.toHaveProperty('style');
    expect(props(out).quality!.enum).toEqual(['low', 'medium', 'high', 'auto']);
  });

  it('keeps a free-form size, because absent sizes mean "the model decides"', () => {
    const hf: ImageGenModelInfo = { id: 'flux', label: 'FLUX', description: '' };
    const out = withImageModelSchema(SCHEMA, ['size', 'negativePrompt'], hf, 'huggingface/flux');
    expect(props(out)).toHaveProperty('size');
    expect(props(out).size).not.toHaveProperty('enum');
  });

  it('offers everything supported when the model is unknown to the catalog', () => {
    const out = withImageModelSchema(SCHEMA, ['size', 'style'], undefined, 'openai/brand-new');
    expect(Object.keys(props(out))).toEqual(['prompt', 'size', 'style']);
  });
});

describe('withImageModelSchema — editing', () => {
  const SCHEMA_WITH_INPUTS = {
    ...SCHEMA,
    properties: {
      ...SCHEMA.properties,
      input_image_ids: { type: 'array', description: 'Existing images to edit.' },
    },
  };

  it('offers input_image_ids only when the adapter can edit', () => {
    const canEdit = withImageModelSchema(
      SCHEMA_WITH_INPUTS,
      ['size', 'inputImages'],
      undefined,
      'openrouter/gemini',
    );
    expect(props(canEdit)).toHaveProperty('input_image_ids');

    const cannot = withImageModelSchema(SCHEMA_WITH_INPUTS, ['size'], undefined, 'xai/grok');
    expect(props(cannot)).not.toHaveProperty('input_image_ids');
  });
});
