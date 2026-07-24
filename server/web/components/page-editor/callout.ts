import { Node, mergeAttributes } from '@tiptap/core';
import { ReactNodeViewRenderer } from '@tiptap/react';
import { CalloutView } from './callout-view';

export const CALLOUT_VARIANTS = ['info', 'success', 'warning', 'danger'] as const;
export type CalloutVariant = (typeof CALLOUT_VARIANTS)[number];

/**
 * Callout: a highlighted box (icon + colored panel) wrapping block content.
 * Variant lives in the node attrs (carried in the ProseMirror JSON); the
 * React NodeView renders the chrome. Part of the shared schema so the
 * read-only PageView renders it identically.
 */
export const Callout = Node.create({
  name: 'callout',
  group: 'block',
  content: 'block+',
  defining: true,

  addAttributes() {
    return {
      variant: {
        default: 'info' as CalloutVariant,
        parseHTML: (el) => el.getAttribute('data-variant') ?? 'info',
        renderHTML: (attrs) => ({ 'data-variant': attrs.variant }),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-callout]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-callout': '' }), 0];
  },

  addNodeView() {
    return ReactNodeViewRenderer(CalloutView);
  },
});
