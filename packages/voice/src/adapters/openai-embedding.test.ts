import { describe, expect, it } from 'vitest';
import { openaiModelId } from './openai-embedding';

describe('openaiModelId', () => {
  it('takes the OpenRouter slug too, so one model id serves both embedding routes', () => {
    expect(openaiModelId('openai/text-embedding-3-large')).toBe('text-embedding-3-large');
    expect(openaiModelId('text-embedding-3-large')).toBe('text-embedding-3-large');
    expect(openaiModelId('google/gemini-embedding-2-preview')).toBe(
      'google/gemini-embedding-2-preview',
    );
  });
});
