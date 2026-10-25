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
import {
  openrouterExtractImages,
  type ImagesRequestExtra,
  type ImagesResult,
} from './openrouter-vision';
import { isProviderTimeout, recordVision, recordVisionTimeout } from './spend';
import type { VisionExtractOptions } from './types';

export type { ImagesRequestExtra, ImagesResult };

export type VisionImage = { bytes: Buffer; mimeType: string; caption?: string };

const MULTI = new Set(['openrouter']);

/** Whether `provider` takes several images in one request here. */
export function multiImageProvider(provider: string): boolean {
  return MULTI.has(provider);
}

/** Ask one question set over several images in one request. Throws for a
 *  provider `multiImageProvider` refuses, and on a timeout: the request may
 *  still be billed by the provider and no usage came back, so the attempt
 *  is recorded with no tokens, marked timed out, before the throw. */
export async function extractImages(
  provider: string,
  images: readonly VisionImage[],
  opts: VisionExtractOptions,
  extra: ImagesRequestExtra = {},
): Promise<ImagesResult> {
  if (provider !== 'openrouter') {
    throw new Error(`vision: provider '${provider}' cannot take several images in one request`);
  }
  let r: ImagesResult;
  try {
    r = await openrouterExtractImages(images, opts, extra);
  } catch (err) {
    if (isProviderTimeout(err)) recordVisionTimeout(provider, opts);
    throw err;
  }
  recordVision(provider, opts, r);
  return r;
}
