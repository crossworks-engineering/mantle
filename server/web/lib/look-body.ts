/**
 * A look as body fields (folders, and workspaces since task 5edc9149): the
 * ONE pair of validators for an icon and a colour, so a folder and a
 * workspace take exactly the same values. The palette is APP_TINTS and the
 * icon vocabulary the app-nav one (@mantle/client-types/app-nav).
 */
import { z } from 'zod';
import { APP_ICON_MAX, APP_TINTS } from '@mantle/client-types/app-nav';
import { projectAppIcon } from '@mantle/content-core/app-nav';

/** An icon as a body field, for a create and a restyle alike: an emoji (up
 *  to APP_ICON_EMOJI_MAX UTF-16 units) or `lucide:<name>`, the app-nav icon
 *  vocabulary; null, or an empty string (older callers), is none. Anything
 *  else is a 400, never stored. */
export const LookIconBody = z.preprocess(
  (v) => (typeof v === 'string' && v.trim() === '' ? null : v),
  z
    .string()
    .trim()
    .max(APP_ICON_MAX)
    .refine((v) => projectAppIcon(v) !== undefined, 'icon must be an emoji or lucide:<name>')
    .nullable(),
);

/** A tint: one of APP_TINTS. */
export const LookColorBody = z.enum(APP_TINTS);
