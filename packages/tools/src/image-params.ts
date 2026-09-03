/**
 * generate_image's option resolution: which values were asked for, which the
 * adapter will actually forward, and which must be reported as ignored.
 *
 * Lifted out of the generate_image handler (bodies moved verbatim, dedented by
 * one level). It was 57 lines of pure decision-making buried at indent 4 in a
 * 342-line tool definition, reachable from a test only by driving the whole
 * handler with a worker, an adapter, a file store and a surface.
 *
 * It is worth having on its own because this is the logic that FAILED in the
 * field twice, and both failures were about honesty rather than crashes: a
 * saved 1024x1024 default silently outranking "make it a 16:9 banner", and an
 * OpenRouter worker showing size/style/quality in the UI while the adapter
 * forwarded none of them. Neither throws. Both are only visible if you can
 * assert on the applied/ignored split directly.
 */

import { strOpt } from './coerce';
import type { ImageGenParam } from '@mantle/voice';

export type RequestedImageParam = {
  param: ImageGenParam;
  key: string;
  value: string;
  fromCall: boolean;
  /** Set when the ADAPTER rejected it for this model, not the caller. */
  reason?: string;
};

export function resolveImageParams(args: {
  /** Raw tool input; each option is coerced here. */
  input: Record<string, unknown>;
  /** The image_gen worker's saved defaults (`worker.params`). */
  worker: { params?: unknown };
  /** What this provider's adapter forwards (`adapter.supports`). */
  supports: readonly ImageGenParam[];
}): {
  requested: RequestedImageParam[];
  sent: RequestedImageParam[];
  ignored: RequestedImageParam[];
  get: (param: ImageGenParam) => string | undefined;
  /** The adapter's forwardable set, derived once here so the caller's own
   *  capability gates (e.g. image editing) cannot disagree with this split. */
  supported: Set<ImageGenParam>;
} {
  const { input, worker, supports } = args;
  const adapter = { supports };

  const params = (worker.params ?? {}) as {
    size?: string;
    aspect_ratio?: string;
    style?: string;
    quality?: string;
  };

  // Per-call arg wins, else the worker's saved default. `origin` is kept so
  // the report below can distinguish "the model asked for this and it did
  // not apply" (worth saying out loud) from "an operator default did not
  // apply" (worth a trace line and a settings pointer).
  const requested: Array<{
    param: ImageGenParam;
    key: string;
    value: string;
    fromCall: boolean;
    /** Set when the ADAPTER rejected it for this model, not the caller. */
    reason?: string;
  }> = [];
  const take = (param: ImageGenParam, key: string, callValue?: string, saved?: string) => {
    const fromCall = callValue != null && callValue !== '';
    const value = fromCall ? callValue : (saved ?? '');
    if (value) requested.push({ param, key, value, fromCall });
  };
  take('size', 'size', strOpt(input.size), params.size);
  take('aspectRatio', 'aspect_ratio', strOpt(input.aspect_ratio), params.aspect_ratio);
  take('style', 'style', strOpt(input.style), params.style);
  take('quality', 'quality', strOpt(input.quality), params.quality);
  take('negativePrompt', 'negative_prompt', strOpt(input.negative_prompt));

  // Precedence between the two SIZING options, resolved here because this is
  // the only layer that knows where each value came from.
  //
  // `size` and `aspect_ratio` both describe the shape, and providers treat an
  // explicit pixel size as authoritative (OpenRouter rejects a companion
  // ratio outright). So a worker default of 1024x1024 would quietly outrank
  // "make it a 16:9 banner" — which is what it did on the first real test:
  // the request said 16:9, the trace claimed 16:9 applied, and the file came
  // back square. A per-call argument must beat a saved default, never the
  // other way round.
  const supersede = (winner: ImageGenParam, loser: ImageGenParam) => {
    const w = requested.find((r) => r.param === winner && r.fromCall);
    const l = requested.find((r) => r.param === loser && !r.fromCall);
    if (w && l) l.reason = `superseded by the ${w.key} you asked for (${w.value})`;
  };
  supersede('aspectRatio', 'size');
  supersede('size', 'aspectRatio');

  // The honesty split. An option the adapter does not forward must never
  // look like it applied: an operator once had size/style/quality saved on
  // an OpenRouter worker, all three shown in the UI, none of them sent, and
  // nothing anywhere said so.
  const supported = new Set<ImageGenParam>(adapter.supports);
  // A superseded default is neither sent nor claimed as applied.
  const sent = requested.filter((r) => supported.has(r.param) && !r.reason);
  const ignored = requested.filter((r) => !supported.has(r.param) || r.reason);
  const get = (param: ImageGenParam) => sent.find((a) => a.param === param)?.value;
  return { requested, sent, ignored, get, supported };
}
