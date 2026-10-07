import { env } from '@mantle/config';
// The subpath, not the barrel: tests that vi.mock('@openrouter/sdk') keep working.
import { HTTPClient } from '@openrouter/sdk/lib/http.js';
import { providerFetch } from './adapters/provider-fetch';

let httpClient: HTTPClient | undefined;

/**
 * OpenRouter dashboard attribution (HTTP-Referer / X-Title). Derived from the
 * install's public URL so a self-hosted brain attributes its own traffic; the
 * fallback is the project page, never a specific box hostname (this repo is
 * public). One helper so the three OpenRouter client sites stay in lockstep.
 *
 * It also hands the SDK the shared provider pool (see provider-fetch.ts), so
 * parallel SDK calls are not sent one at a time.
 */
export function openrouterClientMeta(): {
  httpReferer: string;
  appTitle: string;
  httpClient: HTTPClient;
} {
  const publicUrl = env('MANTLE_PUBLIC_URL')?.trim();
  httpClient ??= new HTTPClient({ fetcher: providerFetch });
  return {
    httpReferer: publicUrl || 'https://github.com/crossworks-engineering/mantle',
    appTitle: 'Mantle',
    httpClient,
  };
}
