import { Node, mergeAttributes } from '@tiptap/core';
import { ReactNodeViewRenderer } from '@tiptap/react';
import { DiagramView } from './diagram-view';

/**
 * Mermaid diagram block. The Mermaid source text is the single source of
 * truth (attrs.source); the NodeView renders it to SVG client-side with a
 * lazy-loaded mermaid bundle. Authored in the dialect as a ```mermaid fence
 * (see @mantle/content markdownToDoc / docToMarkdown). Atom node — the source
 * is edited through the NodeView's source panel, not as document content.
 * Serialized as `<div data-diagram data-source="…">` so copy/paste HTML
 * round-trips without the NodeView.
 */
export const Diagram = Node.create({
  name: 'diagram',
  group: 'block',
  atom: true,
  draggable: true,
  selectable: true,

  addAttributes() {
    return {
      source: {
        default: '',
        parseHTML: (el) => el.getAttribute('data-source') ?? '',
        renderHTML: (attrs) => ({ 'data-source': String(attrs.source ?? '') }),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-diagram]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-diagram': '' })];
  },

  addNodeView() {
    return ReactNodeViewRenderer(DiagramView);
  },
});
