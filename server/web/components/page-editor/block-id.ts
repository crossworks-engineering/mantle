/**
 * BlockId — a TipTap extension that adds a stable `id` attribute to every
 * block-level node in the schema. Companion to `@mantle/content`'s
 * `ensureBlockIds` (which seeds ids server-side on markdownToDoc + read +
 * commit); this extension PRESERVES those ids through the editor's
 * parse → render → serialize round trip so user edits don't strip them,
 * and GUARANTEES they stay unique inside the editor.
 *
 * Without the attribute, ProseMirror drops unknown attributes when it
 * parses JSON into the doc — the agent's carefully-injected ids would
 * vanish the moment the user typed a character. With it, the ids flow
 * through the editor verbatim (rendered as `data-block-id="..."` on the
 * DOM element so external tooling — and Phase 3a's diff view — can find
 * blocks via querySelector).
 *
 * Uniqueness matters as much as stability: a duplicated id makes every
 * later occurrence unaddressable by the agent block tools (findBlock
 * resolves to the first match — a refinery SOP draft ended up with four
 * step paragraphs sharing one id, 2026-07-06). Two
 * editor behaviours used to mint duplicates:
 *
 *   - SPLIT: `keepOnSplit` defaulted to true, so pressing Enter inside a
 *     paragraph copied the id onto the second half. Now false — the new
 *     half starts id-less and the plugin below mints for it.
 *   - PASTE: `parseHTML` reads `data-block-id`, so copy-pasting a block
 *     within the page re-imported the same id. The plugin re-mints the
 *     later duplicate (a cut-paste move keeps its id — no duplicate).
 *
 * The appendTransaction plugin walks the doc after any content change and
 * assigns a fresh UUID to every block whose id is missing or already used
 * earlier in the doc (first occurrence keeps it, matching the server-side
 * ensureBlockIds dedupe). Minting client-side keeps ids stable across
 * autosaves — an id-less block saved to the server would otherwise get a
 * different server-minted id on every save.
 *
 * Coverage: every block-level node the server marks (see BLOCK_NODE_TYPES
 * in @mantle/content/src/block-ids.ts).
 */

import { Extension } from '@tiptap/core';
import { Plugin, PluginKey, type Transaction } from '@tiptap/pm/state';
// IMPORTANT: import from the leaf-module sub-export, not from
// '@mantle/content' root. The root index re-exports profile-preferences →
// db/client → postgres, which is Node-only and breaks Turbopack's client
// bundle ("Module not found: Can't resolve 'fs'"). Mirrors the same
// browser-safe pattern as @mantle/content/contacts-format.
import { BLOCK_NODE_TYPES } from '@mantle/content/block-ids';

const blockIdKey = new PluginKey('blockIdUnique');

function mintId(): string {
  // crypto.randomUUID is available in every browser we support; the
  // Math.random fallback only guards non-secure-context dev edge cases
  // (see secure-context-fallbacks for the app-wide pattern).
  try {
    return globalThis.crypto?.randomUUID?.() ?? fallbackId();
  } catch {
    return fallbackId();
  }
}

function fallbackId(): string {
  const r = () =>
    Math.floor(Math.random() * 0xffffffff)
      .toString(16)
      .padStart(8, '0');
  return `${r()}-${r().slice(0, 4)}-4${r().slice(1, 4)}-${r().slice(0, 4)}-${r()}${r().slice(0, 4)}`;
}

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
            // Do NOT copy the id onto the new node created by a split —
            // that's the duplicate-id mint (Enter inside a paragraph gave
            // both halves the same id). The new half starts null and the
            // plugin below mints a fresh id in the same transaction batch.
            keepOnSplit: false,
          },
        },
      },
    ];
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: blockIdKey,
        appendTransaction: (transactions, _oldState, newState) => {
          if (!transactions.some((tr) => tr.docChanged)) return null;
          const seen = new Set<string>();
          let tr: Transaction | null = null;
          newState.doc.descendants((node, pos) => {
            if (!BLOCK_NODE_TYPES.has(node.type.name)) return true;
            // Only touch nodes whose schema actually declares the attr
            // (global attributes cover them all, but stay defensive).
            if (!('id' in node.attrs)) return true;
            const id = typeof node.attrs.id === 'string' && node.attrs.id ? node.attrs.id : null;
            if (id && !seen.has(id)) {
              seen.add(id);
              return true;
            }
            const fresh = mintId();
            seen.add(fresh);
            tr = (tr ?? newState.tr).setNodeAttribute(pos, 'id', fresh);
            return true;
          });
          return tr;
        },
      }),
    ];
  },
});
