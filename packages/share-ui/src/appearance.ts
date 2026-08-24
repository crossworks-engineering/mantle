import { DEFAULT_COLOR_THEME } from './lib/themes';
import {
  DEFAULT_AVATAR_STYLE,
  DEFAULT_AVATAR_TINT,
  resolveAvatarStyle,
  resolveAvatarTint,
} from './avatar';
import { decodeBackgrounds, encodeBackgrounds } from './backgrounds';
import {
  DEFAULT_FONT_SIZE,
  DEFAULT_LOGO_FONT,
  DEFAULT_PROSE_FONT,
  DEFAULT_TITLE_FONT,
  DEFAULT_UI_FONT,
  fontByKey,
  resolveFontSize,
  resolveFontVars,
  type ResolvedFontVars,
} from '@mantle/client-types/display-fonts';

/**
 * The brain's system-wide appearance — colour theme, the four fonts and their
 * four sizes, the avatar style and tint, the generated backgrounds — as it
 * travels from the anchor owner's profile row to a rendered document.
 *
 * There is ONE delivery mechanism: the values are rendered into the `<html>`
 * tag as attributes (`data-color-theme`, `data-font-logo`, `data-font-title`,
 * `data-font-ui`, `data-font-prose`, the four size attributes,
 * `data-avatar-style`, `data-avatar-tint`) plus the font-family CSS vars as
 * inline style, server-side, on every surface — the client app's root layout
 * (fed by the public GET /api/appearance) and the server-rendered share/print
 * pages (read straight from the DB). No before-paint scripts, no localStorage
 * cache, no coordination flags: the HTML is simply correct when it arrives, and
 * the client providers read the attributes back on mount as their initial
 * state.
 *
 * SIZES travel as attributes only, never as resolved numbers, because app.css
 * owns the multipliers — one place holds the scale, so a TS copy cannot drift
 * from the CSS that actually paints.
 *
 * `resolveAppearanceAttrs` is that projection: defaults and unknown keys
 * resolve to NOTHING (attribute absent, var unset) so the CSS fallbacks win —
 * "default" is the absence of the attribute, never a value.
 */
export type BrainAppearance = {
  colorTheme: string | null;
  fontLogo: string | null;
  fontTitle: string | null;
  fontUi: string | null;
  fontProse: string | null;
  fontSize: string | null;
  fontLogoSize: string | null;
  fontTitleSize: string | null;
  fontProseSize: string | null;
  avatarStyle: string | null;
  avatarTint: string | null;
  backgrounds: string | null;
  /** The generated whole-surface Neat gradient's spec, compact JSON
   *  `{v,seed,tone,speed}` — colours derive from the live theme client-side.
   *  NOT stamped onto `<html>`: it feeds a WebGL component, not the CSS.
   *  Optional for the published-contract reason below: readers treat absence
   *  as "not set" and paint the plain themed fill. */
  neatBackground?: string | null;
  /**
   * WHO this brain is — its own name, the name of the box, and whether an
   * uploaded logo exists. Unlike everything above these are NOT stamped onto
   * `<html>`: `resolveAppearanceAttrs` ignores them, because they are content a
   * surface renders rather than a variable the CSS reads.
   *
   * They ride on this payload because the sign-in screen needs them and has no
   * session to fetch /api/shell with — a brain must be able to say what it is
   * before it asks who you are. On a fleet of many brains behind many domains
   * that is the difference between an identifiable login and five identical
   * ones. Nothing here is more private than the branding a share link already
   * renders publicly.
   *
   * OPTIONAL on purpose: a client pinned to an older published contract may be
   * talking to a newer brain or the reverse, so every reader must treat absence
   * as "not set" and fall back — never assume the field arrived.
   *
   * The logo BYTES have always been public at `GET /api/appearance/logo`
   * (`?variant=dark`); these are only the sha-addressed cache-busting versions,
   * and their PRESENCE is how a caller learns an upload exists at all. Either
   * variant may exist alone — renderers fall back dark → base → wordmark.
   */
  siteName?: string | null;
  peerName?: string | null;
  logoVersion?: string | null;
  logoDarkVersion?: string | null;
};

export type AppearanceAttrs = {
  /** Non-default colour theme id, or undefined (attribute omitted). */
  colorTheme?: string;
  /** Non-default, registry-known font keys — the client provider's initial
   *  state, one per slot. */
  fontLogo?: string;
  fontTitle?: string;
  fontUi?: string;
  fontProse?: string;
  /** Non-default sizes. 'medium' is the absence of the attribute; app.css turns
   *  the interface one into a root font-size and the other three into local
   *  multipliers. */
  fontSize?: string;
  fontLogoSize?: string;
  fontTitleSize?: string;
  fontProseSize?: string;
  /** Non-default avatar style id — the client provider's initial state. */
  avatarStyle?: string;
  /** Non-default avatar tint — same contract. */
  avatarTint?: string;
  /** Non-default per-area generated backgrounds, as `menu=waves,header=off`.
   *  Areas on their default are omitted, so the attribute is absent entirely on
   *  a brain that has never chosen. */
  backgrounds?: string;
  /** Resolved font-family values for the four CSS vars (inline style on <html>). */
  fontVars: ResolvedFontVars;
};

/** Attribute name ↔ default key, for the four selectable faces. Only keys that
 *  actually RESOLVED travel: an unknown key must not become provider state a
 *  modal would then display as the current choice. */
const FONT_SLOTS = [
  ['fontLogo', 'wordmark', DEFAULT_LOGO_FONT],
  ['fontTitle', 'pageTitle', DEFAULT_TITLE_FONT],
  ['fontUi', 'ui', DEFAULT_UI_FONT],
  ['fontProse', 'prose', DEFAULT_PROSE_FONT],
] as const;

const SIZE_FIELDS = ['fontSize', 'fontLogoSize', 'fontTitleSize', 'fontProseSize'] as const;

/**
 * The `<html>` data-attribute name for every font field, and the CSS var name
 * for every resolved font-family — THE canonical tables. Two renderers stamp an
 * appearance onto a document (the client root layout and the server htmlPage),
 * and the original bug this feature fixed was exactly those two drifting: the
 * server copy missed `--font-sans` for months and every share rendered in
 * Inter. Both renderers now consume these projections, so an attribute can no
 * longer exist in one document and not the other; display-fonts.test.ts holds
 * the tables complete against AppearanceAttrs itself.
 */
const FONT_ATTR_NAMES = [
  ['data-font-logo', 'fontLogo'],
  ['data-font-title', 'fontTitle'],
  ['data-font-ui', 'fontUi'],
  ['data-font-prose', 'fontProse'],
  ['data-font-size', 'fontSize'],
  ['data-logo-size', 'fontLogoSize'],
  ['data-title-size', 'fontTitleSize'],
  ['data-prose-size', 'fontProseSize'],
] as const;

const FONT_VAR_NAMES = [
  ['--font-wordmark', 'wordmark'],
  ['--font-page-title', 'pageTitle'],
  ['--font-sans', 'ui'],
  ['--font-prose', 'prose'],
] as const;

/** The font data-* attributes of a resolved appearance, ready to spread onto
 *  `<html>` (client) or serialize into the tag (server). Defaults are already
 *  absent from AppearanceAttrs, so absence needs no handling here. */
export function appearanceFontAttrs(a: AppearanceAttrs): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [attr, field] of FONT_ATTR_NAMES) {
    const value = a[field];
    if (value) out[attr] = value;
  }
  return out;
}

/** The font-family CSS vars of a resolved appearance, for the `<html>` inline
 *  style. Same single-source contract as appearanceFontAttrs. */
export function appearanceFontVars(a: AppearanceAttrs): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, key] of FONT_VAR_NAMES) {
    const value = a.fontVars[key];
    if (value) out[name] = value;
  }
  return out;
}

export function resolveAppearanceAttrs(a: BrainAppearance | null | undefined): AppearanceAttrs {
  const out: AppearanceAttrs = { fontVars: {} };
  if (!a) return out;
  if (a.colorTheme && a.colorTheme !== DEFAULT_COLOR_THEME) out.colorTheme = a.colorTheme;

  out.fontVars = resolveFontVars(a.fontLogo, a.fontTitle, a.fontUi, a.fontProse);
  for (const [field, varName, defaultKey] of FONT_SLOTS) {
    const stored = a[field];
    if (!out.fontVars[varName] || !stored) continue;
    // Resolve through the registry so a legacy alias travels as the key the
    // modal can actually show, and a dropped key travels as nothing at all.
    const face = fontByKey(stored);
    if (face && face.key !== defaultKey) out[field] = face.key;
  }

  for (const field of SIZE_FIELDS) {
    const stored = a[field];
    if (!stored) continue;
    const resolved = resolveFontSize(stored);
    if (resolved !== DEFAULT_FONT_SIZE) out[field] = resolved;
  }

  // Same contract: only a known, non-default style travels. A legacy
  // boring-avatars id stored before the DiceBear move resolves to a shipped
  // style here, so the attribute is always something the picker can show.
  if (a.avatarStyle) {
    const resolved = resolveAvatarStyle(a.avatarStyle);
    if (resolved !== DEFAULT_AVATAR_STYLE) out.avatarStyle = resolved;
  }
  if (a.avatarTint) {
    const resolved = resolveAvatarTint(a.avatarTint);
    if (resolved !== DEFAULT_AVATAR_TINT) out.avatarTint = resolved;
  }
  // Round-tripped through decode/encode rather than passed along: that drops
  // unknown areas and unknown styles, and re-omits anything sitting on its
  // default. What reaches the document is always something the picker can show.
  if (a.backgrounds) {
    const encoded = encodeBackgrounds(decodeBackgrounds(a.backgrounds));
    if (encoded) out.backgrounds = encoded;
  }
  return out;
}
