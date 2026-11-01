/**
 * A file's bytes for a mini app. An app has no network and no session of its
 * own, so the only way a picture reaches it is through host.tools.call. The
 * bytes come back as base64 in the tool's output, which the app turns into a
 * data: or blob: URL (the frame's img-src allows both).
 *
 * Only an app's own call gets them: base64 in a model's tool result buys it
 * nothing and costs the whole turn, so an agent or an MCP client is told what
 * to use instead. This grants no new read: the call has already passed the
 * app's verdict, and the file is read in the run's scope like any other.
 */
import { currentToolCaller } from './gate-callers';
import type { ToolHandlerContext } from './types';

/** The most one call hands an app, before base64. A drawing's picture or a
 *  photo is well under it; a larger file belongs in a download link. */
export const APP_BYTES_MAX = 16 * 1024 * 1024;

/** Why this call may not have the bytes, or null when it may. */
export function appBytesRefusal(ctx: ToolHandlerContext): string | null {
  if ((ctx.caller ?? currentToolCaller())?.entry === 'app') return null;
  return 'bytes is for a mini app, which cannot see a picture any other way. Leave it out: show_image shows a file in chat, and extract_from_image reads one.';
}

/** The refusal for a file past the cap, in the app author's words. */
export function appBytesTooLarge(filename: string, sizeBytes: number): string {
  const mb = (n: number) => (n / (1024 * 1024)).toFixed(1);
  return `${filename} is ${mb(sizeBytes)} MB, past the ${mb(APP_BYTES_MAX)} MB a mini app can read in one call. Show a smaller copy of it.`;
}
