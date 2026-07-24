import { Node, mergeAttributes } from '@tiptap/core';

/**
 * Simple multi-column layout: a `columnList` holds 2+ `column` nodes, each with
 * its own block content. Pure layout — no NodeView, just schema + flexbox CSS
 * (see globals.css `.column-list`). Inserted at a fixed count (2/3/4) from the
 * slash menu; no drag-to-create or resize, by design.
 */
export const Column = Node.create({
  name: 'column',
  content: 'block+',
  isolating: true, // edits/selection stay within a column

  parseHTML() {
    return [{ tag: 'div[data-column]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-column': '', class: 'column' }), 0];
  },
});

export const ColumnList = Node.create({
  name: 'columnList',
  group: 'block',
  content: 'column{2,}',

  parseHTML() {
    return [{ tag: 'div[data-column-list]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'div',
      mergeAttributes(HTMLAttributes, { 'data-column-list': '', class: 'column-list' }),
      0,
    ];
  },
});

/** Build the doc fragment for an N-column block (each column starts empty). */
export function columnsContent(n: number) {
  return {
    type: 'columnList',
    content: Array.from({ length: n }, () => ({
      type: 'column',
      content: [{ type: 'paragraph' }],
    })),
  };
}
