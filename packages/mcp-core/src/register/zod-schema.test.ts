/**
 * The JSON-Schema to zod bridge on a type union: each listed type is
 * accepted, not only the first. model_call's message `content` is
 * `['string', 'array']`: a text turn, or text and picture parts. With the
 * first type only, an MCP client could send no picture at all.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { BUILTIN_TOOLS } from '@mantle/tools';
import { buildZodShape, zodForDef } from './zod-schema';

const PNG = 'data:image/png;base64,iVBORw0KGgo=';

describe('zodForDef on a type union', () => {
  it('accepts each listed type, and null only when listed', () => {
    const both = zodForDef({ type: ['string', 'array'], items: { type: 'object' } });
    expect(both.safeParse('hi').success).toBe(true);
    expect(both.safeParse([{ type: 'text', text: 'hi' }]).success).toBe(true);
    expect(both.safeParse(3).success).toBe(false);
    expect(both.safeParse(null).success).toBe(false);
    const nullable = zodForDef({ type: ['string', 'null'] });
    expect(nullable.safeParse(null).success).toBe(true);
    expect(nullable.safeParse('x').success).toBe(true);
    expect(nullable.safeParse(1).success).toBe(false);
  });
});

describe('model_call on the MCP surface', () => {
  const def = BUILTIN_TOOLS.find((t) => t.slug === 'model_call')!;
  const schema = z.object(buildZodShape(def.inputSchema as Record<string, unknown>));

  it('takes a packet with picture parts, as the app sends it', () => {
    const packet = {
      model: 'openai/gpt-6-astra',
      max_tokens: 24000,
      reasoning_effort: 'medium',
      messages: [
        { role: 'developer', content: 'Read the drawing.' },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Page 3' },
            { type: 'image_url', image_url: { url: PNG, detail: 'high' } },
          ],
        },
      ],
    };
    const r = schema.safeParse(packet);
    expect(r.error?.issues ?? []).toEqual([]);
  });

  it('still takes a plain prompt', () => {
    expect(schema.safeParse({ model: 'm', prompt: 'hi' }).success).toBe(true);
  });
});
