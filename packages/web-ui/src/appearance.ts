import { DEFAULT_COLOR_THEME } from './lib/themes';
import {
  DEFAULT_AVATAR_STYLE,
  DEFAULT_AVATAR_TINT,
  resolveAvatarStyle,
  resolveAvatarTint,
} from './avatar';
import { decodeBackgrounds, encodeBackgrounds } from './backgrounds';
import {
  DEFAULT_UI_FONT,
  DEFAULT_UI_FONT_SIZE,
  fontByKey,
  resolveFontVars,
  resolveUiFontSize,
  type ResolvedFontVars,
} from './display-fonts';

/**
 * The brain's system-wide appearance — colour theme, the two display fonts and
 * the avatar style and tint, the UI font and its size — as it travels from the anchor owner's profile row to a
 * rendered document.
 *
 * There is ONE delivery mechanism: the values are rendered into the `<html>`
 * tag as attributes (`data-color-theme`, `data-font-logo`, `data-font-title`,
 * `data-avatar-style`, `data-avatar-tint`)
 * plus the two font CSS vars as inline style, server-side, on every surface —
 * the client app's root layout (fed by the public GET /api/appearance) and the
 * server-rendered share/print pages (read straight from the DB). No before-
 * paint scripts, no localStorage cache, no coordination flags: the HTML is
 * simply correct when it arrives, and the client providers read the attributes
 * back on mount as their initial state.
 *
 * `resolveAppearanceAttrs` is that projection: defaults and unknown keys
 * resolve to NOTHING (attribute absent, var unset) so the CSS fallbacks win —
 * "default" is the absence of the attribute, never a value.
 */
export type BrainAppearance = {
  colorTheme: string | null;
  fontLogo: string | null;
  fontTitle: string | null;
  avatarStyle: string | null;
  avatarTint: string | null;
  fontUi: string | null;
  fontSize: string | null;
  backgrounds: string | null;
};

export type AppearanceAttrs = {
  /** Non-default colour theme id, or undefined (attribute omitted). */
  colorTheme?: string;
  /** Non-default, registry-known font keys — the client providers' initial state. */
  fontLogo?: string;
  fontTitle?: string;
  /** Non-default avatar style id — the client provider's initial state. */
  avatarStyle?: string;
  /** Non-default avatar tint — same contract. */
  avatarTint?: string;
  /** Non-default UI font key — the client provider's initial state. */
  fontUi?: string;
  /** Non-default UI size ('small' | 'large') — drives the root font-size rule
   *  in app.css. 'medium' is the absence of the attribute. */
  fontSize?: string;
  /** Non-default per-area generated backgrounds, as `menu=waves,header=off`.
   *  Areas on their default are omitted, so the attribute is absent entirely on
   *  a brain that has never chosen. */
  backgrounds?: string;
  /** Resolved font-family values for the two CSS vars (inline style on <html>). */
  fontVars: ResolvedFontVars;
};

export function resolveAppearanceAttrs(a: BrainAppearance | null | undefined): AppearanceAttrs {
  const out: AppearanceAttrs = { fontVars: {} };
  if (!a) return out;
  if (a.colorTheme && a.colorTheme !== DEFAULT_COLOR_THEME) out.colorTheme = a.colorTheme;
  out.fontVars = resolveFontVars(a.fontLogo, a.fontTitle, a.fontUi);
  // Only keys that actually resolved travel as attributes — an unknown key
  // must not become provider state a picker would then display.
  if (out.fontVars.wordmark && a.fontLogo && fontByKey(a.fontLogo)) out.fontLogo = a.fontLogo;
  if (out.fontVars.pageTitle && a.fontTitle && fontByKey(a.fontTitle)) out.fontTitle = a.fontTitle;
  // Same contract: only a known, non-default style travels. A legacy
  // boring-avatars id stored before the DiceBear move resolves to a shipped
  // style here, so the attribute is always something the picker can show.
  if (a.avatarStyle) {
    const resolved = resolveAvatarStyle(a.avatarStyle);
    if (resolved !== DEFAULT_AVATAR_STYLE) out.avatarStyle = resolved;
  }
  if (out.fontVars.ui && a.fontUi && fontByKey(a.fontUi) && a.fontUi !== DEFAULT_UI_FONT) {
    out.fontUi = a.fontUi;
  }
  if (a.fontSize) {
    const resolved = resolveUiFontSize(a.fontSize);
    if (resolved !== DEFAULT_UI_FONT_SIZE) out.fontSize = resolved;
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
