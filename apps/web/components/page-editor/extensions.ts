import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';
import Highlight from '@tiptap/extension-highlight';
import Typography from '@tiptap/extension-typography';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import Subscript from '@tiptap/extension-subscript';
import Superscript from '@tiptap/extension-superscript';
import TextAlign from '@tiptap/extension-text-align';
import { TableKit } from '@tiptap/extension-table';
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight';
import { Mathematics } from '@tiptap/extension-mathematics';
import Youtube from '@tiptap/extension-youtube';
import { Details, DetailsContent, DetailsSummary } from '@tiptap/extension-details';
import { common, createLowlight } from 'lowlight';
import type { Extensions } from '@tiptap/react';
import { Callout } from './callout';
import { Column, ColumnList } from './column';
import { PageMention } from './mention';
import { PageEmoji } from './emoji';
import { PageImage } from './image';
import { PageAudio } from './audio';
import { FileEmbed } from './file-embed';

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
  PageEmoji,
  // Collapsible toggle (details/summary). persist:true stores the open state in
  // the doc so the public render honours a collapsed toggle.
  Details.configure({ persist: true, HTMLAttributes: { class: 'details' } }),
  DetailsSummary,
  DetailsContent,
  Callout,
  ColumnList,
  Column,
  PageImage,
  PageAudio,
  FileEmbed,
  // YouTube embeds. Privacy-friendly (youtube-nocookie) + a tidy player. The
  // iframe is made responsive 16:9 via CSS; the public renderer re-derives a
  // sanitized embed URL itself rather than trusting stored markup.
  Youtube.configure({ nocookie: true, modestBranding: true, HTMLAttributes: { class: 'youtube-iframe' } }),
  // Inline ($…$) + block ($$…$$) math via KaTeX. Input rules convert as you
  // type; nodes are `inlineMath` / `blockMath` with a `latex` attr. KaTeX CSS is
  // imported in app/layout.tsx.
  Mathematics,
  TableKit.configure({ table: { resizable: true } }),
  Placeholder.configure({
    // Only the first empty line shows it (showOnlyWhenEditable defaults true,
    // so the read-only PageView never renders a placeholder).
    placeholder: 'Write something, or press “/” for commands…',
  }),
];
