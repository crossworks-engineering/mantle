import { env } from '@mantle/config';
/**
 * OpenRouter dashboard attribution (HTTP-Referer / X-Title). Derived from the
 * install's public URL so a self-hosted brain attributes its own traffic; the
 * fallback is the project page, never a specific box hostname (this repo is
 * public). One helper so the three OpenRouter client sites stay in lockstep.
 */
export function openrouterClientMeta(): { httpReferer: string; appTitle: string } {
  const publicUrl = env('MANTLE_PUBLIC_URL')?.trim();
  return {
    httpReferer: publicUrl || 'https://github.com/crossworks-engineering/mantle',
    appTitle: 'Mantle',
  };
}
