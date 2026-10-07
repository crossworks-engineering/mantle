/**
 * The same-model backup route for the one embedding config (docs/embeddings.md
 * "Provider outages"). Pure: the Settings route, the save response and
 * onboarding all ask it, and the tests need no database.
 */
import type { EmbeddingConfigRow } from '@mantle/db';

/** A same-model backup route the brain could add at once. */
export type BackupSuggestion = {
  provider: 'openrouter' | 'openai';
  apiKeyId: string;
  label: string;
  /** Plain words for the form. */
  why: string;
};

const OPENAI_EMBED_RE = /^(?:openai\/)?text-embedding-3-(?:large|small)$/;

/**
 * Suggest a backup route when the config has none: the same OpenAI model
 * through the OTHER provider whose key the brain already holds. OpenAI direct
 * and OpenRouter serve `text-embedding-3-*` with the same vectors, and both
 * adapters take the same slug (the OpenAI one drops an `openai/` prefix), so
 * the backup needs no second model. Null when a backup is set, the model is
 * not an OpenAI one, or no key for the other provider is saved.
 */
export function suggestBackupRoute(
  config: Pick<EmbeddingConfigRow, 'model' | 'primaryProvider' | 'backupEnabled'> | null,
  keys: ReadonlyArray<{ id: string; service: string }>,
): BackupSuggestion | null {
  if (!config || config.backupEnabled) return null;
  if (!OPENAI_EMBED_RE.test(config.model)) return null;
  const other =
    config.primaryProvider === 'openai'
      ? 'openrouter'
      : config.primaryProvider === 'openrouter'
        ? 'openai'
        : null;
  if (!other) return null;
  const key = keys.find((k) => k.service === other);
  if (!key) return null;
  return other === 'openrouter'
    ? {
        provider: 'openrouter',
        apiKeyId: key.id,
        label: 'OpenRouter',
        why: 'OpenRouter serves the same OpenAI model with the same vectors, on your saved OpenRouter key.',
      }
    : {
        provider: 'openai',
        apiKeyId: key.id,
        label: 'OpenAI',
        why: 'OpenAI direct serves the same model with the same vectors, on your saved OpenAI key.',
      };
}
