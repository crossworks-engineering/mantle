import Mention from '@tiptap/extension-mention';
import { ReactRenderer } from '@tiptap/react';
import {
  MentionList,
  type MentionItem,
  type MentionListHandle,
  type MentionListProps,
} from './mention-list';

/**
 * @-mention / link. One picker resolves the owner's existing references
 * (read-only via /api/mentions/search):
 *   - a page/note → chip with `ref:'node'` → the extractor makes a
 *     `node --references--> node` edge (backlinks)
 *   - a person/project/place → chip with `ref:'entity'` → `mentioned_in` edge
 *
 * Chips carry { id, label, ref, kind }; the name lands in `doc_text` for the
 * brain. Targets that don't match an existing page/note/entity aren't
 * mentionable — type them as plain text.
 */
export const PageMention = Mention.extend({
  addAttributes() {
    return {
      ...(this.parent?.() ?? {}),
      ref: {
        default: 'entity',
        parseHTML: (el) => el.getAttribute('data-ref') ?? 'entity',
        renderHTML: (attrs) => (attrs.ref ? { 'data-ref': attrs.ref } : {}),
      },
      kind: {
        default: null,
        parseHTML: (el) => el.getAttribute('data-kind'),
        renderHTML: (attrs) => (attrs.kind ? { 'data-kind': attrs.kind } : {}),
      },
    };
  },
}).configure({
  HTMLAttributes: { class: 'mention' },
  suggestion: {
    char: '@',

    // No data fetch here on purpose. The suggestion plugin shares one `props`
    // object across its async `update()` calls, so awaiting a fetch in `items`
    // races under fast typing and a stale-empty result can land last. We return
    // nothing and let `MentionList` fetch from `props.query` with a sequence
    // guard, so the latest query always wins. See mention-list.tsx.
    items: () => [],

    command: ({ editor, range, props }) => {
      const item = props as unknown as MentionItem;
      const after = editor.view.state.selection.$to.nodeAfter;
      if (after?.text?.startsWith(' ')) range.to += 1;
      editor
        .chain()
        .focus()
        .insertContentAt(range, [
          {
            type: 'mention',
            attrs: { id: item.id, label: item.label, ref: item.ref, kind: item.kind },
          },
          { type: 'text', text: ' ' },
        ])
        .run();
    },

    render: () => {
      let component: ReactRenderer<MentionListHandle, MentionListProps> | null = null;
      let popup: HTMLDivElement | null = null;
      let rectFn: (() => DOMRect | null) | null | undefined = null;
      let ro: ResizeObserver | null = null;

      const reposition = () => {
        if (!popup || !rectFn) return;
        const rect = rectFn();
        if (!rect) return;
        const margin = 6;
        const w = popup.offsetWidth;
        const h = popup.offsetHeight;
        const flipUp = rect.bottom + margin + h > window.innerHeight && rect.top - margin - h > 0;
        let top = flipUp ? rect.top - margin - h : rect.bottom + margin;
        let left = rect.left;
        // Clamp fully on-screen so the list never overflows the viewport (which
        // is what let arrow-key scrollIntoView yank the page on first open).
        left = Math.max(margin, Math.min(left, window.innerWidth - w - margin));
        top = Math.max(margin, Math.min(top, window.innerHeight - h - margin));
        popup.style.left = `${Math.round(left)}px`;
        popup.style.top = `${Math.round(top)}px`;
      };

      const close = () => {
        ro?.disconnect();
        ro = null;
        popup?.remove();
        popup = null;
        component?.destroy();
        component = null;
      };

      return {
        onStart: (props) => {
          rectFn = props.clientRect;
          component = new ReactRenderer(MentionList, { props, editor: props.editor });
          popup = document.createElement('div');
          popup.style.position = 'fixed';
          popup.style.zIndex = '50';
          popup.appendChild(component.element);
          document.body.appendChild(popup);
          reposition();
          // ReactRenderer commits asynchronously; reposition once the popup has a
          // real size (and when the filtered list height changes).
          ro = new ResizeObserver(() => reposition());
          ro.observe(popup);
        },
        onUpdate: (props) => {
          rectFn = props.clientRect;
          component?.updateProps(props);
          reposition();
        },
        onKeyDown: (props) => {
          if (props.event.key === 'Escape') {
            close();
            return true;
          }
          return component?.ref?.onKeyDown(props) ?? false;
        },
        onExit: () => close(),
      };
    },
  },
});
