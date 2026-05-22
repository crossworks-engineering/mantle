import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import Avatar from 'boring-avatars';
import { AVATAR_STYLE_IDS, DEFAULT_AVATAR_STYLE, type AvatarStyleId } from '@/lib/avatar';

/**
 * Server-only avatar SVG generation with boring-avatars. Renders the React
 * component to a static SVG string (via createElement, so it's independent of
 * the JSX runtime) so the generator stays server-side — only GET /api/avatar
 * imports this. Client code builds URLs via lib/avatar.
 */

const VARIANTS = new Set<string>(AVATAR_STYLE_IDS);

/** Avatar colour palette. Leads with the brand indigo, then a balanced spread
 *  so the geometric variants stay vivid but cohesive. */
const PALETTE = ['#6366f1', '#22d3ee', '#f59e0b', '#ec4899', '#10b981'];

/** Raw SVG markup for an avatar. Unknown style → default variant; empty seed →
 *  a stable fallback. */
export function avatarSvg(style: string, seed: string): string {
  const variant = (VARIANTS.has(style) ? style : DEFAULT_AVATAR_STYLE) as AvatarStyleId;
  return renderToStaticMarkup(
    createElement(Avatar, { name: seed || 'mantle', variant, size: 80, colors: PALETTE }),
  );
}
