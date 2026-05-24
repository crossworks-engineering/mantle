import { Node, mergeAttributes } from '@tiptap/core';

/**
 * Block image node. Carries `nodeId` (the backing `file` node) alongside `src`
 * (the `?raw=1` serve route), so a page references an uploaded file by id rather
 * than inlining bytes. Part of the shared schema, so the editor, the read-only
 * PageView, and the assistant's RichText all render images identically.
 *
 * Markdown `![alt](url)` parses straight into this via `img[src]`, so Saskia can
 * embed images by URL too (uploads are an editor affordance — see upload.ts).
 */
export const PageImage = Node.create({
  name: 'image',
  group: 'block',
  atom: true,
  draggable: true,
  selectable: true,

  addAttributes() {
    return {
      src: { default: null },
      alt: { default: null },
      title: { default: null },
      nodeId: {
        default: null,
        parseHTML: (el) => el.getAttribute('data-node-id'),
        renderHTML: (attrs) => (attrs.nodeId ? { 'data-node-id': attrs.nodeId } : {}),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'img[src]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['img', mergeAttributes(HTMLAttributes, { loading: 'lazy' })];
  },
});
