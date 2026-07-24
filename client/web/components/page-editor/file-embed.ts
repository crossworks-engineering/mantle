import { Node, mergeAttributes } from '@tiptap/core';
import { ReactNodeViewRenderer } from '@tiptap/react';
import { FileEmbedView } from './file-embed-view';

/**
 * Non-image file attachment, rendered as a download chip (icon + name + size).
 * Like images, it references a backing `file` node by id and links to the
 * `?raw=1` serve route. Atom node + React NodeView for the chip chrome;
 * serialized as `<div data-file-embed>` with `data-*` attrs so the read-only
 * renderer round-trips it.
 */
export const FileEmbed = Node.create({
  name: 'fileEmbed',
  group: 'block',
  atom: true,
  draggable: true,
  selectable: true,

  addAttributes() {
    return {
      nodeId: {
        default: null,
        parseHTML: (el) => el.getAttribute('data-node-id'),
        renderHTML: (attrs) => (attrs.nodeId ? { 'data-node-id': attrs.nodeId } : {}),
      },
      href: {
        default: null,
        parseHTML: (el) => el.getAttribute('data-href'),
        renderHTML: (attrs) => (attrs.href ? { 'data-href': attrs.href } : {}),
      },
      filename: {
        default: 'file',
        parseHTML: (el) => el.getAttribute('data-filename') ?? 'file',
        renderHTML: (attrs) => ({ 'data-filename': attrs.filename }),
      },
      mime: {
        default: null,
        parseHTML: (el) => el.getAttribute('data-mime'),
        renderHTML: (attrs) => (attrs.mime ? { 'data-mime': attrs.mime } : {}),
      },
      size: {
        default: null,
        parseHTML: (el) => {
          const v = el.getAttribute('data-size');
          return v ? Number(v) : null;
        },
        renderHTML: (attrs) => (attrs.size != null ? { 'data-size': String(attrs.size) } : {}),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-file-embed]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-file-embed': '' })];
  },

  addNodeView() {
    return ReactNodeViewRenderer(FileEmbedView);
  },
});
