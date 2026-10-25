/**
 * Several images in ONE vision request: the drawing check asks a vision
 * model narrow questions about a circuit, each on one or more close-up
 * crops, batched into as few requests as it can.
 *
 * Not a method on VisionDispatcher on purpose: that type is a published
 * contract (@mantle/voice-client), and only OpenRouter takes several images
 * here today. A provider that cannot is named by `multiImageProvider`, so
 * the caller says so instead of guessing. Spend is recorded like every
 * other vision call (./spend.ts).
 */
import { openrouterExtractImages } from './openrouter-vision';
import { recordVision } from './spend';
import type { VisionExtractOptions, VisionExtractResult } from './types';

export type VisionImage = { bytes: Buffer; mimeType: string; caption?: string };

const MULTI = new Set(['openrouter']);

/** Whether `provider` takes several images in one request here. */
export function multiImageProvider(provider: string): boolean {
  return MULTI.has(provider);
}

/** Ask one question set over several images in one request. Throws for a
 *  provider `multiImageProvider` refuses. */
export async function extractImages(
  provider: string,
  images: readonly VisionImage[],
  opts: VisionExtractOptions,
): Promise<VisionExtractResult> {
  if (provider !== 'openrouter') {
    throw new Error(`vision: provider '${provider}' cannot take several images in one request`);
  }
  const r = await openrouterExtractImages(images, opts);
  recordVision(provider, opts, r);
  return r;
}
