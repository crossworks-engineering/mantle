/**
 * Catalog of pre-known OpenAPI-described services — the `KNOWN_MCP_SERVERS`
 * twin for OpenAPI connectors. Server-driven on purpose: the connectors API
 * returns it so the settings UI can render a placeholder row per entry
 * ("not connected: add") without the user knowing a slug or a spec URL.
 *
 * `whenToUse` is the load-bearing field: it becomes part of the generated
 * connector group description, the prose rung of "call this vs the built-in
 * tools". `baseUrl` matters when a spec carries no usable root `servers`
 * entry (Open-Meteo's per-product specs only declare path-level servers,
 * which the compiler deliberately ignores).
 *
 * Only LIVE-VERIFIED entries belong here. Never auto-provisioned.
 */

export type KnownOpenapiApi = {
  /** Connector slug — the group becomes `openapi-<slug>`. */
  slug: string;
  /** Display name for the placeholder row. */
  label: string;
  /** One sentence: what connecting this API adds. */
  description: string;
  /** Where the OpenAPI 3.x document is fetched from. */
  specUrl: string;
  /** Base URL the compiled tools call, when the spec's own servers list
   *  cannot supply one. */
  baseUrl?: string;
  /** `api_keys.service` the credential is stored under, when key-authed. */
  secretService?: string;
  /** Where the user gets a key / reads about the API. */
  docsUrl: string;
  /** Selection guidance folded into the generated group description. */
  whenToUse: string;
};

export const KNOWN_OPENAPI_APIS: readonly KnownOpenapiApi[] = [
  {
    slug: 'open-meteo',
    label: 'Open-Meteo weather',
    description:
      'Free weather forecast API (no key): current conditions, hourly and daily forecasts for any coordinates.',
    specUrl: 'https://raw.githubusercontent.com/open-meteo/open-meteo/main/openapi/forecast.yml',
    baseUrl: 'https://api.open-meteo.com',
    docsUrl: 'https://open-meteo.com/en/docs',
    whenToUse:
      'Use for weather questions that need live numbers (forecast, temperature, wind) for a known latitude/longitude. For general web questions use the researcher instead; nothing here searches or geocodes.',
  },
];

export function knownOpenapiApi(slug: string): KnownOpenapiApi | undefined {
  return KNOWN_OPENAPI_APIS.find((s) => s.slug === slug);
}
