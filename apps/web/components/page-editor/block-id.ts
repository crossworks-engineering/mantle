/**
 * BlockId — a TipTap extension that adds a stable `id` attribute to every
 * block-level node in the schema. Companion to `@mantle/content`'s
 * `ensureBlockIds` (which seeds ids server-side on markdownToDoc + read +
 * commit); this extension PRESERVES those ids through the editor's
 * parse → render → serialize round trip so user edits don't strip them.
 *
 * Without this extension, ProseMirror drops unknown attributes when it
 * parses JSON into the doc — the agent's carefully-injected ids would
 * vanish the moment the user typed a character. With it, the ids flow
 * through the editor verbatim (rendered as `data-block-id="..."` on the
 * DOM element so external tooling — and Phase 3a's diff view — can find
 * blocks via querySelector).
 *
 * Coverage: every block-level node the server marks (see BLOCK_NODE_TYPES
 * in @mantle/content/src/block-ids.ts). Pure attribute; no commands,
 * keybindings, or input rules.
 */

import { Extension } from '@tiptap/core';
import { BLOCK_NODE_TYPES } from '@mantle/content';

export const BlockId = Extension.create({
  name: 'blockId',

  addGlobalAttributes() {
    return [
      {
        // Apply to every block node by name. Standard ProseMirror nodes
        // (paragraph / heading / blockquote / …) and Mantle's custom ones
        // (callout / column / columnList) all live in BLOCK_NODE_TYPES.
        types: Array.from(BLOCK_NODE_TYPES),
        attributes: {
          id: {
            default: null as string | null,
            // Parse: HTML attr → JS attr. Accept both `data-block-id` (our
            // canonical) and `id` (in case the doc was rendered through a
            // tool that lowercased / dropped the `data-` prefix).
            parseHTML: (el: HTMLElement) =>
              el.getAttribute('data-block-id') || el.getAttribute('id') || null,
            // Render: JS attr → HTML attr. Use `data-block-id` to avoid
            // conflicting with the native HTML `id` attribute (anchor links,
            // CSS selectors, screen readers).
            renderHTML: (attrs: Record<string, unknown>) => {
              if (!attrs.id || typeof attrs.id !== 'string') return {};
              return { 'data-block-id': attrs.id };
            },
            // Critical: keep the attribute in the JSON serialisation so
            // round-tripping through saveDraft / commit preserves it. Without
            // this, `getAttributes()` would drop `id` on JSON export.
            keepOnSplit: true,
          },
        },
      },
    ];
  },
});
