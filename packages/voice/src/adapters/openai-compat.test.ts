/**
 * Direct unit tests for the shared OpenAI-compat translation helpers.
 *
 * The end-to-end behaviour of xai-chat and huggingface-chat already
 * exercises these helpers through tool-translation.test.ts +
 * chat-adapters.test.ts at the adapter boundary. This file pins down
 * the translation logic in isolation so a future provider opting into
 * the shared helper has a focused contract to refer to.
 */

import { describe, expect, it } from 'vitest';
import { extractOpenAICompatToolCalls, toOpenAICompatMessages } from './openai-compat';

describe('toOpenAICompatMessages', () => {
  describe('system messages', () => {
    it('passes string content through unchanged', () => {
      const out = toOpenAICompatMessages([{ role: 'system', content: 'you are saskia' }]);
      expect(out).toEqual([{ role: 'system', content: 'you are saskia' }]);
    });

    it('flattens block-array system to a joined string (caching is automatic for OpenAI-compat providers)', () => {
      const out = toOpenAICompatMessages([
        {
          role: 'system',
          content: [
            { type: 'text', text: 'persona block' },
            { type: 'text', text: 'digest block' },
          ],
        },
      ]);
      expect(out).toEqual([{ role: 'system', content: 'persona block\n\ndigest block' }]);
    });
  });

  describe('user messages', () => {
    it('passes string content through unchanged', () => {
      const out = toOpenAICompatMessages([{ role: 'user', content: 'hi' }]);
      expect(out).toEqual([{ role: 'user', content: 'hi' }]);
    });

    it('translates multimodal arrays with camelCase imageUrl → snake_case image_url', () => {
      const out = toOpenAICompatMessages([
        {
          role: 'user',
          content: [
            { type: 'text', text: 'what is this?' },
            {
              type: 'image_url',
              imageUrl: {
                url: 'data:image/png;base64,abc',
                detail: 'high',
              },
            },
          ],
        },
      ]);
      expect(out).toEqual([
        {
          role: 'user',
          content: [
            { type: 'text', text: 'what is this?' },
            {
              type: 'image_url',
              image_url: { url: 'data:image/png;base64,abc', detail: 'high' },
            },
          ],
        },
      ]);
    });

    it('omits the detail field when not provided', () => {
      const out = toOpenAICompatMessages([
        {
          role: 'user',
          content: [
            {
              type: 'image_url',
              imageUrl: { url: 'https://example.com/cat.png' },
            },
          ],
        },
      ]);
      const msg = out[0]! as { content: Array<Record<string, unknown>> };
      const imgBlock = msg.content[0]! as { image_url: Record<string, unknown> };
      expect(imgBlock.image_url).toEqual({ url: 'https://example.com/cat.png' });
      expect(imgBlock.image_url).not.toHaveProperty('detail');
    });
  });

  describe('assistant messages', () => {
    it('passes a text-only assistant turn through with null-safe content', () => {
      const out = toOpenAICompatMessages([{ role: 'assistant', content: 'done' }]);
      expect(out).toEqual([{ role: 'assistant', content: 'done' }]);
    });

    it('emits null content when the model only sent toolCalls', () => {
      const out = toOpenAICompatMessages([
        {
          role: 'assistant',
          content: null,
          toolCalls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'note_create', arguments: '{}' },
            },
          ],
        },
      ]);
      expect(out).toEqual([
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'note_create', arguments: '{}' },
            },
          ],
        },
      ]);
    });

    it('omits tool_calls when the assistant turn has none', () => {
      const out = toOpenAICompatMessages([{ role: 'assistant', content: 'just text' }]);
      expect(out[0]).not.toHaveProperty('tool_calls');
    });
  });

  describe('tool messages', () => {
    it('renames toolCallId → tool_call_id', () => {
      const out = toOpenAICompatMessages([
        { role: 'tool', toolCallId: 'call_1', content: '{"ok":true}' },
      ]);
      expect(out).toEqual([{ role: 'tool', tool_call_id: 'call_1', content: '{"ok":true}' }]);
    });
  });
});

describe('extractOpenAICompatToolCalls', () => {
  it('returns undefined when the message has no tool_calls field', () => {
    expect(extractOpenAICompatToolCalls({ role: 'assistant', content: 'hi' })).toBeUndefined();
  });

  it('returns undefined for an empty tool_calls array', () => {
    expect(
      extractOpenAICompatToolCalls({
        role: 'assistant',
        content: null,
        tool_calls: [],
      }),
    ).toBeUndefined();
  });

  it('normalises tool_calls to ChatToolCall[]', () => {
    const out = extractOpenAICompatToolCalls({
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'call_a',
          type: 'function',
          function: { name: 'fake_tool', arguments: '{"x":1}' },
        },
      ],
    });
    expect(out).toEqual([
      {
        id: 'call_a',
        type: 'function',
        function: { name: 'fake_tool', arguments: '{"x":1}' },
      },
    ]);
  });

  it('defaults missing arguments to "{}" so parseToolArgs sees a valid empty call', () => {
    const out = extractOpenAICompatToolCalls({
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'call_b',
          type: 'function',
          function: { name: 'fake_tool', arguments: undefined as unknown as string },
        },
      ],
    });
    expect(out?.[0]?.function.arguments).toBe('{}');
  });

  it('handles undefined message gracefully (model returned no message)', () => {
    expect(extractOpenAICompatToolCalls(undefined)).toBeUndefined();
  });
});
