/**
 * Client-side FormData → JSON for the worker form. The form is uncontrolled
 * (builds a FormData at submit); these helpers turn that into the body the
 * `/api/ai-workers` create/patch endpoints expect — the same field mapping the
 * old server actions did with parseParamsFromForm / parseBackupFromForm, moved
 * to the client now that the screen fetches.
 */
import type { AiWorkerKind } from '@mantle/client-types';

function str(v: FormDataEntryValue | null): string | undefined {
  if (v == null) return undefined;
  const s = String(v).trim();
  return s.length > 0 ? s : undefined;
}
function num(v: FormDataEntryValue | null): number | undefined {
  if (v == null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** Kind-specific params (the jsonb `params` column). Mirrors the server's switch. */
export function paramsFromForm(kind: AiWorkerKind, fd: FormData): Record<string, unknown> {
  switch (kind) {
    case 'tts':
      return {
        voice: str(fd.get('voice')),
        speed: num(fd.get('speed')),
        format: str(fd.get('format')),
        instructions: str(fd.get('instructions')),
        language: str(fd.get('language')),
      };
    case 'stt':
      return {
        language: str(fd.get('language')),
        max_duration_seconds: num(fd.get('max_duration_seconds')),
      };
    case 'vision':
      return {
        extraction_prompt: str(fd.get('extraction_prompt')),
        max_tokens: num(fd.get('max_tokens')),
      };
    case 'document':
      return {
        extraction_prompt: str(fd.get('extraction_prompt')),
        max_tokens: num(fd.get('max_tokens')),
        prefer_native: fd.get('prefer_native') === 'on',
      };
    case 'image_gen':
      return {
        size: str(fd.get('size')),
        style: str(fd.get('style')),
        quality: str(fd.get('quality')),
      };
    case 'reflector':
      return {
        temperature: num(fd.get('temperature')),
        max_tokens: num(fd.get('max_tokens')),
        window_size: num(fd.get('window_size')),
        max_notes_per_run: num(fd.get('max_notes_per_run')),
        huggingface_routing: str(fd.get('huggingface_routing')),
      };
    case 'extractor': {
      const targetTypes = str(fd.get('target_types'));
      return {
        temperature: num(fd.get('temperature')),
        max_tokens: num(fd.get('max_tokens')),
        target_types: targetTypes
          ? targetTypes.split(',').map((s) => s.trim()).filter(Boolean)
          : undefined,
        extract_facts: fd.get('extract_facts') === 'on',
        extract_cost_cap_micro_usd: num(fd.get('extract_cost_cap_micro_usd')),
        huggingface_routing: str(fd.get('huggingface_routing')),
      };
    }
    case 'summarizer':
      return {
        temperature: num(fd.get('temperature')),
        max_tokens: num(fd.get('max_tokens')),
        summarize_threshold: num(fd.get('summarize_threshold')),
        summarize_batch: num(fd.get('summarize_batch')),
        huggingface_routing: str(fd.get('huggingface_routing')),
      };
    case 'narrator':
      // Plain chat knobs. The verbosity dial is the systemPrompt (handled by
      // buildWorkerBody) + max_tokens — no narrator-specific params.
      return {
        temperature: num(fd.get('temperature')),
        max_tokens: num(fd.get('max_tokens')),
        huggingface_routing: str(fd.get('huggingface_routing')),
      };
    default:
      return {};
  }
}

function backupFromForm(fd: FormData) {
  return {
    backupEnabled: fd.get('backup_enabled') === 'on',
    backupProvider: str(fd.get('backup_provider')) ?? null,
    backupModel: str(fd.get('backup_model')) ?? null,
    backupApiKeyId: (fd.get('backup_api_key_id') as string) || null,
    baseUrl: str(fd.get('base_url')) ?? null,
    viaTailnet: fd.get('via_tailnet') === 'on',
    backupBaseUrl: str(fd.get('backup_base_url')) ?? null,
    backupViaTailnet: fd.get('backup_via_tailnet') === 'on',
  };
}

export interface WorkerBody {
  kind: AiWorkerKind;
  name: string;
  provider: string;
  model: string;
  apiKeyId: string | null;
  systemPrompt: string | null;
  params: Record<string, unknown>;
  enabled: boolean;
  isDefault: boolean;
  priority?: number;
  backupEnabled: boolean;
  backupProvider: string | null;
  backupModel: string | null;
  backupApiKeyId: string | null;
  baseUrl: string | null;
  viaTailnet: boolean;
  backupBaseUrl: string | null;
  backupViaTailnet: boolean;
}

/**
 * Build the create/patch body from the form's FormData. The PATCH endpoint
 * ignores the fields it doesn't accept (kind, isDefault) — Zod strips them — so
 * one builder serves both; the caller handles isDefault via the default endpoint
 * on edit.
 */
export function buildWorkerBody(fd: FormData): WorkerBody {
  const kind = String(fd.get('kind') ?? '') as AiWorkerKind;
  return {
    kind,
    name: String(fd.get('name') ?? '').trim(),
    provider: String(fd.get('provider') ?? '').trim(),
    model: String(fd.get('model') ?? '').trim(),
    apiKeyId: (fd.get('apiKeyId') as string) || null,
    systemPrompt: (fd.get('systemPrompt') as string) || null,
    params: paramsFromForm(kind, fd),
    enabled: fd.get('enabled') === 'on',
    isDefault: fd.get('isDefault') === 'on',
    ...(num(fd.get('priority')) !== undefined ? { priority: num(fd.get('priority')) } : {}),
    ...backupFromForm(fd),
  };
}
