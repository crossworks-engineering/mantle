import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';
import type { Extensions } from '@tiptap/react';

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
  }),
  Placeholder.configure({
    // Only the first empty line shows it (showOnlyWhenEditable defaults true,
    // so the read-only PageView never renders a placeholder).
    placeholder: 'Write something, or press “/” for commands…',
  }),
];
