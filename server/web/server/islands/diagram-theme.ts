/**
 * Browser entry for the shared Mermaid theme map (built to
 * public/share-runtime/diagram-theme.js by scripts/build-share-runtime.ts).
 *
 * The /print surface upgrades diagram blocks to SVG with a static inline
 * script — it can't import, so the one map in @mantle/web-ui/mermaid-theme is
 * bundled and hung off globalThis for it to call. Same self-hosted shape as
 * mermaid.min.js next to it; no CDN, nothing interpolated from user data.
 */
import { mermaidThemeVariablesFromDocument } from '@mantle/client-types/mermaid-theme';

declare global {
  var mantleMermaidTheme: typeof mermaidThemeVariablesFromDocument | undefined;
}

globalThis.mantleMermaidTheme = mermaidThemeVariablesFromDocument;
