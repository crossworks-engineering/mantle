/**
 * The look a brain wears until someone chooses otherwise: the Jackdaw colour
 * theme, Lorelei avatars, and the Neat background switched on.
 *
 * ONE source for every reader, and it lives HERE (zero dependencies) because
 * both sides import it: the brain (content-core's DEFAULT_PREFERENCES and its
 * read projections) and the clients (@mantle/share-ui's DEFAULT_AVATAR_STYLE,
 * FRESH_COLOR_THEME and resolveAppearanceAttrs). Clients pin client-types and
 * share-ui together, so a client can never hold one half of this without the
 * other. A stored choice always wins; nothing writes this over a row that has
 * one. It is for FRESH installs: migration keep_existing_look wrote the old
 * look (clean-slate, thumbs, Neat off) into every profile row that existed
 * before this release, so an existing brain looks exactly as it did.
 *
 * `neatBackground` is a Neat-era v1 spec `{v:1, seed, tone:'auto', speed:2}`.
 * It stays v1 on purpose: the Drift codec (@mantle/content-core/drift-spec)
 * decodes v1 as the silk style, the closest look to what fresh brains showed,
 * and keeping the string means no stored row or test fixture changes.
 */
export const FRESH_APPEARANCE = {
  colorTheme: 'jackdaw',
  avatarStyle: 'lorelei',
  neatBackground: '{"v":1,"seed":55361,"tone":"auto","speed":2}',
} as const;
