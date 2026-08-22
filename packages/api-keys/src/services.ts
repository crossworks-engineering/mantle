/**
 * Catalog of NON-LLM services the runtime consumes an `api_keys` row for.
 *
 * Why this exists: AI providers get discovered through the provider dropdown
 * (SUPPORTED_PROVIDERS in @mantle/voice-client), but a service like Firecrawl
 * or Mapbox was invisible until the user somehow knew to type its slug into
 * the custom-service field. This list lets /settings/keys render an empty
 * placeholder row per service ("not configured — add key") so the capability
 * is discoverable.
 *
 * Deliberately NOT part of the voice-client provider catalog: ProviderId
 * feeds ai_workers dispatch and the adapter registries (with consistency
 * tests); these services have no adapter and must never appear in a worker
 * form. Server-side on purpose — the UI reads it from GET /api/keys, so a
 * new entry here reaches the client without a contract-package release.
 *
 * Add an entry ONLY for a service some shipped code path actually resolves
 * (`getApiKey(owner, '<service>')` or a manifest-seeded `{{secret:…}}` ref).
 * A placeholder for a service nothing consumes is a lie in the UI.
 */

export type KeyService = {
  /** The exact `api_keys.service` slug the runtime resolves. */
  service: string;
  /** Display name for the placeholder row. */
  label: string;
  /** One sentence: what turns on when the key is present. */
  description: string;
  /** Where the user gets a key. */
  signupUrl: string;
  /** The tools/features that consume it — shown as the row's hint. */
  usedFor: string;
};

export const KNOWN_KEY_SERVICES: readonly KeyService[] = [
  {
    service: 'firecrawl',
    label: 'Firecrawl',
    description:
      'Web crawling: turn whole websites into searchable documentation in the brain. Free tier ~1,000 pages/month.',
    signupUrl: 'https://www.firecrawl.dev',
    usedFor: 'web_map / web_crawl tools',
  },
  {
    service: 'mapbox',
    label: 'Mapbox',
    description:
      'Maps and places: reverse geocoding, directions, and inline route-map images. Generous free tier.',
    signupUrl: 'https://account.mapbox.com/access-tokens/',
    usedFor: 'mapbox_reverse_geocode / mapbox_directions / route maps',
  },
];
