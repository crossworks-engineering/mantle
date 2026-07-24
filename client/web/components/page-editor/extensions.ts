import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';
import Highlight from '@tiptap/extension-highlight';
import Typography from '@tiptap/extension-typography';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import { TableKit } from '@tiptap/extension-table';
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight';
import { Mathematics } from '@tiptap/extension-mathematics';
import { common, createLowlight } from 'lowlight';
import type { Extensions } from '@tiptap/react';
import { Callout } from './callout';
import { Aside } from './aside';
import { Column, ColumnList } from './column';
import { PageMention } from './mention';
import { PageImage } from './image';
import { FileEmbed } from './file-embed';
import { ChildPage } from './child-page';
import { TextColor } from './text-color';
import { BlockId } from './block-id';
import { highlightColor } from '@mantle/web-ui/highlight-colors';

// Highlight mark with an optional themed `color` (a token key like `chart-2`,
// never a raw colour). A null colour renders a plain <mark> (default primary
// tint, styled in globals.css); a token renders an inline themed background, so
// the editor, PageView, and public renderer all shade identically.
const PageHighlight = Highlight.extend({
  addAttributes() {
    return {
      color: {
        default: null as string | null,
        parseHTML: (el: HTMLElement) => el.getAttribute('data-color'),
        renderHTML: (attrs: Record<string, unknown>) => {
          const c = highlightColor(attrs.color);
          if (!c) return {};
          return { 'data-color': String(attrs.color), style: `background-color: ${c}` };
        },
      },
    };
  },
});

// Shared highlight.js registry for code blocks (covers ~35 common languages).
// Token spans get themed via `.ProseMirror .hljs-*` rules in globals.css, so
// syntax highlighting tracks the active theme + light/dark instead of shipping
// a fixed hljs colour scheme.
const lowlight = createLowlight(common);

/**
 * Shared editor schema for the pages surface. The live editor (`PageEditor`)
 * and the read-only renderer (`PageView`) MUST use the same extension set, or
 * a doc authored in one renders wrong in the other.
 *
 * The editor itself is "invisible" — no chrome. Formatting comes from markdown
 * shortcuts (StarterKit input rules), the selection bubble menu, and (next
 * slice) the slash menu. The Placeholder gives the empty-canvas hint.
 *
 * Custom nodes — callout, image/file embed, toggle, mentions — land in later
 * slices and get appended here.
 */
export const pageExtensions: Extensions = [
  StarterKit.configure({
    heading: { levels: [1, 2, 3] },
    // Link ships in StarterKit; just tune it. Auto-link typed/pasted URLs,
    // link the selection when a URL is pasted over it, and don't navigate
    // away on click while editing.
    link: { openOnClick: false, autolink: true, linkOnPaste: true },
    // Replaced by CodeBlockLowlight below (syntax highlighting). Same node
    // name ('codeBlock') + JSON shape, so existing docs + docToText are
    // unaffected — only the render gains highlight spans.
    codeBlock: false,
  }),
  CodeBlockLowlight.configure({ lowlight }),
  PageHighlight,
  TextColor,
  Typography,
  TaskList,
  TaskItem.configure({ nested: true }),
  PageMention,
  Callout,
  Aside,
  ColumnList,
  Column,
  PageImage,
  FileEmbed,
  // Inline card linking to a sub-page (Phase 4a). Shared so PageView renders
  // the card too; created by the `/page` slash command.
  ChildPage,
  // Inline ($…$) + block ($$…$$) math via KaTeX. Input rules convert as you
  // type; nodes are `inlineMath` / `blockMath` with a `latex` attr. KaTeX CSS is
  // imported in app/layout.tsx.
  Mathematics,
  TableKit.configure({ table: { resizable: true } }),
  // Stable UNIQUE per-block ids on every block-level node — survives parse/
  // render/serialize so user edits don't strip ids placed by the agent, and
  // a plugin mints/dedupes ids on split & paste so the doc never holds two
  // blocks with one id. Mirrors server-side ensureBlockIds in @mantle/content.
  BlockId,
  Placeholder.configure({
    // Only the first empty line shows it (showOnlyWhenEditable defaults true,
    // so the read-only PageView never renders a placeholder).
    placeholder: 'Write something, or press “/” for commands…',
  }),
];
