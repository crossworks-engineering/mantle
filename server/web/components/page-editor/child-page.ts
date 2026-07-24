import { Node, mergeAttributes } from '@tiptap/core';
import { ReactNodeViewRenderer } from '@tiptap/react';
import { ChildPageView } from './child-page-view';

/**
 * childPage — an inline card that links to a sub-page (Phase 4a sub-pages).
 * The block-level, inline equivalent of a `PageMention`: where a mention is a
 * chip inside a paragraph, a childPage is a full-width clickable card that
 * navigates to `/pages/<pageId>`.
 *
 * It's an atom (no editable content) referencing a backing `page` node by id;
 * the `title` / `icon` attrs are a snapshot for display (the card refreshes the
 * live title on mount so renames show up). The card is created by the `/page`
 * slash command, which makes the child page with `parent_id = current page`
 * (see slash-menu.tsx). Part of the shared schema so PageView renders the card
 * identically; the public renderer (render-page-doc.ts) emits an inert label
 * (sub-pages aren't part of a shared subtree in 4a).
 */
export const ChildPage = Node.create({
  name: 'childPage',
  group: 'block',
  atom: true,
  draggable: true,
  selectable: true,

  addAttributes() {
    return {
      pageId: {
        default: null,
        parseHTML: (el) => el.getAttribute('data-page-id'),
        renderHTML: (attrs) => (attrs.pageId ? { 'data-page-id': attrs.pageId } : {}),
      },
      title: {
        default: 'Untitled page',
        parseHTML: (el) => el.getAttribute('data-title') ?? 'Untitled page',
        renderHTML: (attrs) => ({ 'data-title': attrs.title ?? 'Untitled page' }),
      },
      icon: {
        default: null,
        parseHTML: (el) => el.getAttribute('data-icon'),
        renderHTML: (attrs) => (attrs.icon ? { 'data-icon': attrs.icon } : {}),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-child-page]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-child-page': '' })];
  },

  addNodeView() {
    return ReactNodeViewRenderer(ChildPageView);
  },
});
