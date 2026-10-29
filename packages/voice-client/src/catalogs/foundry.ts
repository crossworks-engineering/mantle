/**
 * Microsoft Foundry (Azure AI Foundry, Azure OpenAI) static catalog and
 * endpoint rules. docs/foundry.md has the API as checked against Microsoft
 * Learn and the v1 OpenAPI file.
 *
 * Pure data and pure functions: this contract package has no dependencies,
 * so the env reads (MANTLE_FOUNDRY_*) live in the adapter
 * (`@mantle/voice` adapters/foundry-chat.ts), which passes the values in.
 *
 * Model ids are DEPLOYMENT names. The owner names each deployment in the
 * Foundry portal; the portal suggests the model id, so the seed below lists
 * model ids as the likely deployment names. Any other name the owner types
 * works the same. No prices: Foundry bills by deployment type (Global, Data
 * Zone, Regional) and region, and the API answers with no cost, so a seed
 * price would be a guess. No context windows for the same reason a
 * deployment can be set below the model's own.
 */

import type { ChatModelInfo } from '../adapters/types';

/** The path the v1 API lives under, on either host form. */
export const FOUNDRY_V1_PATH = '/openai/v1';

/** The API version the v1 route needs no query for. */
export const FOUNDRY_DEFAULT_API_VERSION = 'v1';

/** How an endpoint or API version can be wrong, in fixed words. Never echoes
 *  the value: an endpoint a login typed is not ours to repeat in a log. */
export const FOUNDRY_ENDPOINT_PROBLEM =
  'Microsoft Foundry needs an endpoint: set the route Base URL or MANTLE_FOUNDRY_ENDPOINT to the resource URL (https://<resource>.openai.azure.com or https://<resource>.services.ai.azure.com).';
export const FOUNDRY_ENDPOINT_INVALID =
  'The Microsoft Foundry endpoint is not a plain https URL (no user, query or fragment). Use the resource URL, e.g. https://<resource>.openai.azure.com.';
export const FOUNDRY_API_VERSION_INVALID =
  "MANTLE_FOUNDRY_API_VERSION must be 'v1', 'preview' or a date version such as 2024-10-21 or 2025-04-01-preview.";

/** A parsed MANTLE_FOUNDRY_API_VERSION. `v1` and `preview` use the v1 route;
 *  a date version uses the older per-deployment route. */
export type FoundryApiVersion =
  { kind: 'v1'; query: null } | { kind: 'v1'; query: 'preview' } | { kind: 'dated'; query: string };

/**
 * Parse an API version. Blank or unset is `v1`. Returns null for anything
 * else that is not `v1`, `preview` or `YYYY-MM-DD` with an optional
 * `-preview`, so a stray value can never reach the URL.
 */
export function parseFoundryApiVersion(raw: string | null | undefined): FoundryApiVersion | null {
  const v = (raw ?? '').trim();
  if (!v || v === FOUNDRY_DEFAULT_API_VERSION) return { kind: 'v1', query: null };
  if (v === 'preview') return { kind: 'v1', query: 'preview' };
  if (/^\d{4}-\d{2}-\d{2}(?:-preview)?$/.test(v)) return { kind: 'dated', query: v };
  return null;
}

/**
 * The resource root of an endpoint: `https://host[/gateway-path]` with any
 * trailing `/openai/v1` or `/openai` (and slashes) taken off, so the owner
 * can paste the root or the v1 base URL the portal shows. Null when it is
 * not an https URL, or carries a user, a query or a fragment (a key in a
 * URL would end up in logs). A path other than the openai suffix stays: an
 * API Management gateway fronts the resource under its own prefix.
 */
export function foundryResourceRoot(endpoint: string | null | undefined): string | null {
  const raw = (endpoint ?? '').trim();
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  if (url.username || url.password || url.search || url.hash) return null;
  const path = url.pathname
    .replace(/\/+$/, '')
    .replace(/\/openai(?:\/v1)?$/i, '')
    .replace(/\/+$/, '');
  return `${url.origin}${path}`;
}

/** The chat completions URL for a deployment. */
export function foundryChatUrl(
  root: string,
  deployment: string,
  version: FoundryApiVersion,
): string {
  if (version.kind === 'dated') {
    return `${root}/openai/deployments/${encodeURIComponent(deployment)}/chat/completions?api-version=${version.query}`;
  }
  const q = version.query ? `?api-version=${version.query}` : '';
  return `${root}${FOUNDRY_V1_PATH}/chat/completions${q}`;
}

/** The model list URL for an API version: the base models the resource can
 *  use (NOT its deployments; no data plane call lists those). */
export function foundryModelsUrl(root: string, version: FoundryApiVersion): string {
  return version.kind === 'dated'
    ? `${root}/openai/models?api-version=${version.query}`
    : `${root}${FOUNDRY_V1_PATH}/models`;
}

const TOOLS = ['function_calling', 'json_mode'] as const;
const TOOLS_VISION = ['function_calling', 'json_mode', 'vision'] as const;
const TOOLS_VISION_REASONING = ['function_calling', 'json_mode', 'vision', 'reasoning'] as const;
const TOOLS_REASONING = ['function_calling', 'json_mode', 'reasoning'] as const;
const REASONING = ['reasoning'] as const;

const HINT = 'The deployment name, if you named it after the model.';

/**
 * The seed the model dropdown shows. Each id is the model id, which is the
 * deployment name only when the owner kept the portal's suggestion. Live
 * discovery adds the base model ids the resource reports, as hints of the
 * same kind.
 */
export const FOUNDRY_CHAT_MODELS: readonly ChatModelInfo[] = [
  // ── OpenAI (Azure OpenAI) ────────────────────────────────────────
  {
    id: 'gpt-5',
    label: 'GPT-5',
    description: `OpenAI reasoning flagship. ${HINT}`,
    capabilities: TOOLS_VISION_REASONING,
  },
  {
    id: 'gpt-5-mini',
    label: 'GPT-5 mini',
    description: `OpenAI reasoning, lower cost. ${HINT}`,
    capabilities: TOOLS_VISION_REASONING,
  },
  {
    id: 'gpt-5-nano',
    label: 'GPT-5 nano',
    description: `OpenAI reasoning, cheapest. ${HINT}`,
    capabilities: TOOLS_VISION_REASONING,
  },
  {
    id: 'gpt-4.1',
    label: 'GPT-4.1',
    description: `OpenAI non-reasoning, long context. ${HINT}`,
    capabilities: TOOLS_VISION,
  },
  {
    id: 'gpt-4.1-mini',
    label: 'GPT-4.1 mini',
    description: `OpenAI non-reasoning, fast. ${HINT}`,
    capabilities: TOOLS_VISION,
  },
  {
    id: 'gpt-4o',
    label: 'GPT-4o',
    description: `OpenAI multimodal. ${HINT}`,
    capabilities: TOOLS_VISION,
  },
  {
    id: 'gpt-4o-mini',
    label: 'GPT-4o mini',
    description: `OpenAI multimodal, cheap. ${HINT}`,
    capabilities: TOOLS_VISION,
  },
  {
    id: 'o4-mini',
    label: 'o4-mini',
    description: `OpenAI reasoning (o-series). ${HINT}`,
    capabilities: TOOLS_VISION_REASONING,
  },
  // ── Foundry models from other vendors (v1 chat completions) ──────
  {
    id: 'DeepSeek-V3.1',
    label: 'DeepSeek V3.1',
    description: `DeepSeek, sold by Azure. ${HINT}`,
    capabilities: TOOLS,
  },
  {
    id: 'DeepSeek-R1',
    label: 'DeepSeek R1',
    description: `DeepSeek reasoning, sold by Azure. No tool calling. ${HINT}`,
    capabilities: REASONING,
  },
  {
    id: 'grok-4',
    label: 'Grok 4',
    description: `xAI, sold by Azure. ${HINT}`,
    capabilities: TOOLS_REASONING,
  },
  {
    id: 'Llama-3.3-70B-Instruct',
    label: 'Llama 3.3 70B Instruct',
    description: `Meta open model. ${HINT}`,
    capabilities: TOOLS,
  },
];
