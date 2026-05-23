import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';
import Highlight from '@tiptap/extension-highlight';
import Typography from '@tiptap/extension-typography';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import { TableKit } from '@tiptap/extension-table';
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight';
import { common, createLowlight } from 'lowlight';
import type { Extensions } from '@tiptap/react';
import { Callout } from './callout';
import { Column, ColumnList } from './column';
import { PageMention } from './mention';

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
  TaskList,
  TaskItem.configure({ nested: true }),
  PageMention,
  Callout,
  ColumnList,
  Column,
  TableKit.configure({ table: { resizable: true } }),
  Placeholder.configure({
    // Only the first empty line shows it (showOnlyWhenEditable defaults true,
    // so the read-only PageView never renders a placeholder).
    placeholder: 'Write something, or press “/” for commands…',
  }),
];
