import { describe, expect, it } from 'vitest';
import { suggestBackupRoute } from './embedding-backup';

const keys = new Map([
  ['openrouter', 'k-or'],
  ['openai', 'k-oa'],
]);

describe('suggestBackupRoute', () => {
  it('OpenAI direct with no backup: the same model on OpenRouter (the 2026-10-04 case)', () => {
    expect(
      suggestBackupRoute(
        { model: 'text-embedding-3-large', primaryProvider: 'openai', backupEnabled: false },
        keys,
      ),
    ).toMatchObject({ provider: 'openrouter', apiKeyId: 'k-or', label: 'OpenRouter' });
  });

  it('OpenRouter with no backup: the same model on OpenAI direct', () => {
    expect(
      suggestBackupRoute(
        {
          model: 'openai/text-embedding-3-large',
          primaryProvider: 'openrouter',
          backupEnabled: false,
        },
        keys,
      ),
    ).toMatchObject({ provider: 'openai', apiKeyId: 'k-oa' });
  });

  it('nothing when a backup is set, the other key is missing, or the model is not OpenAI', () => {
    const base = {
      model: 'text-embedding-3-large',
      primaryProvider: 'openai',
      backupEnabled: false,
    };
    expect(suggestBackupRoute({ ...base, backupEnabled: true }, keys)).toBeNull();
    expect(suggestBackupRoute(base, new Map([['openai', 'k-oa']]))).toBeNull();
    expect(
      suggestBackupRoute(
        { ...base, model: 'embeddinggemma:latest', primaryProvider: 'local' },
        keys,
      ),
    ).toBeNull();
    expect(
      suggestBackupRoute(
        { ...base, model: 'google/gemini-embedding-2-preview', primaryProvider: 'openrouter' },
        keys,
      ),
    ).toBeNull();
    expect(suggestBackupRoute(null, keys)).toBeNull();
  });
});
