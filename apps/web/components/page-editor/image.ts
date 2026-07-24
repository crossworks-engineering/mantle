import { Node, mergeAttributes } from '@tiptap/core';
import { assetUrl } from '@mantle/web-ui/asset-url';

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
    // Route the asset src through assetUrl() so a detached/Electron client loads
    // it from the remote origin with the `?at=` token (a browser <img> can't send
    // a bearer header). Same-origin: assetUrl returns the path unchanged → no-op.
    // nodeId-backed images build the canonical serve path (matches renderPageDoc);
    // a bare relative `/api/...` src (markdown paste) is rewritten as-is; external
    // (http/https/data) srcs are left untouched. Only the rendered DOM is affected
    // — saves serialize via getJSON, so the stored doc keeps the raw attrs.
    const nodeId = HTMLAttributes['data-node-id'];
    const rawSrc = typeof HTMLAttributes.src === 'string' ? HTMLAttributes.src : null;
    let src = rawSrc;
    if (typeof nodeId === 'string' && nodeId) {
      src = assetUrl(`/api/files/files/${nodeId}?raw=1`);
    } else if (rawSrc && rawSrc.startsWith('/')) {
      src = assetUrl(rawSrc);
    }
    return ['img', mergeAttributes(HTMLAttributes, { src, loading: 'lazy' })];
  },
});
