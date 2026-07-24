import { Mark, mergeAttributes } from '@tiptap/core';
import { textColor } from './text-colors';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    textColor: {
      /** Colour the selection with a theme token (e.g. `chart-2`). */
      setTextColor: (color: string) => ReturnType;
      /** Remove text colour from the selection. */
      unsetTextColor: () => ReturnType;
    };
  }
}

/**
 * Themed text-colour mark — a `<span>` carrying a token key (`data-text-color`)
 * rendered as an inline `color: var(--token)`. Its own mark (like Highlight)
 * rather than the textStyle+Color combo, so there are no empty-span cleanup
 * concerns and no extra dependency. Part of the shared schema, so the editor,
 * PageView, and the public renderer all colour identically. A null/unknown
 * token renders a bare <span> (inherits the foreground).
 */
export const TextColor = Mark.create({
  name: 'textColor',

  addAttributes() {
    return {
      color: {
        default: null as string | null,
        parseHTML: (el) => el.getAttribute('data-text-color'),
        renderHTML: (attrs) => {
          const c = textColor(attrs.color);
          if (!c) return {};
          return { 'data-text-color': String(attrs.color), style: `color: ${c}` };
        },
      },
    };
  },

  parseHTML() {
    return [{ tag: 'span[data-text-color]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['span', mergeAttributes(HTMLAttributes), 0];
  },

  addCommands() {
    return {
      setTextColor:
        (color) =>
        ({ commands }) =>
          commands.setMark(this.name, { color }),
      unsetTextColor:
        () =>
        ({ commands }) =>
          commands.unsetMark(this.name),
    };
  },
});
