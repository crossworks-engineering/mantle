import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';
import Highlight from '@tiptap/extension-highlight';
import Typography from '@tiptap/extension-typography';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import Subscript from '@tiptap/extension-subscript';
import Superscript from '@tiptap/extension-superscript';
import TextAlign from '@tiptap/extension-text-align';
import { Table, TableRow, TableHeader, TableCell } from '@tiptap/extension-table';
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight';
import { Mathematics } from '@tiptap/extension-mathematics';
import { common, createLowlight } from 'lowlight';
import type { Extensions } from '@tiptap/react';
import { Callout } from './callout';
import { Column, ColumnList } from './column';
import { PageMention } from './mention';
import { PageImage } from './image';
import { PageAudio } from './audio';
import { FileEmbed } from './file-embed';
import { cellBgColor } from './table-cell-bg';

// Add a theme-token `backgroundColor` attribute to table cells. Stores the
// token key + an inline `background-color` (so the editor, PageView, and the
// public renderer all shade identically); `data-bg` round-trips the key.
function cellBackgroundAttr() {
  return {
    backgroundColor: {
      default: null as string | null,
      parseHTML: (el: HTMLElement) => el.getAttribute('data-bg'),
      renderHTML: (attrs: Record<string, unknown>) => {
        const color = cellBgColor(attrs.backgroundColor);
        if (!color) return {};
        return { 'data-bg': String(attrs.backgroundColor), style: `background-color: ${color}` };
      },
    },
  };
}

const PageTableCell = TableCell.extend({
  addAttributes() {
    return { ...this.parent?.(), ...cellBackgroundAttr() };
  },
});

const PageTableHeader = TableHeader.extend({
  addAttributes() {
    return { ...this.parent?.(), ...cellBackgroundAttr() };
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
 * shortcuts (StarterKit input rules), the selection bubble menu, and the slash
 * menu. The Placeholder gives the empty-canvas hint.
 *
 * Custom nodes (callout, columns, image/audio/file embeds, mentions) are
 * appended below; editor-only behaviours (slash menu, trailing node, character
 * count) are added in page-editor.tsx, not here, so PageView stays identical.
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
  Highlight,
  Typography,
  Subscript,
  Superscript,
  // Horizontal alignment for paragraphs + headings. Renders as an inline
  // `style="text-align:…"` so both the editor and the public renderer honour it.
  TextAlign.configure({ types: ['heading', 'paragraph'] }),
  TaskList,
  TaskItem.configure({ nested: true }),
  PageMention,
  Callout,
  ColumnList,
  Column,
  PageImage,
  PageAudio,
  FileEmbed,
  // Inline ($…$) + block ($$…$$) math via KaTeX. Input rules convert as you
  // type; nodes are `inlineMath` / `blockMath` with a `latex` attr. KaTeX CSS is
  // imported in app/layout.tsx.
  Mathematics,
  Table.configure({ resizable: true }),
  TableRow,
  PageTableHeader,
  PageTableCell,
  Placeholder.configure({
    // Only the first empty line shows it (showOnlyWhenEditable defaults true,
    // so the read-only PageView never renders a placeholder).
    placeholder: 'Write something, or press “/” for commands…',
  }),
];
