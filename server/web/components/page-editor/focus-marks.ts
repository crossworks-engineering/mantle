import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { Node as PMNode } from '@tiptap/pm/model';

/**
 * FocusMarks — an editor-only overlay that highlights blocks by their stable
 * `attrs.id` (Phase 2b block ids). Two independent sets, two colours:
 *   - `marked`  — what the user picked in the gutter focus marker (primary).
 *   - `edited`  — what Pages changed in the current draft (green), so after a
 *                 focused run you can see exactly which blocks moved even
 *                 though their text now reads differently. `edited` takes
 *                 visual precedence when a block is in both.
 *
 * It NEVER mutates the document. Both sets are driven by a meta transaction
 * (`setMeta(focusMarksKey, { marked, edited })`); the host React component
 * owns them (marks persist to localStorage; edited comes from the AI diff) and
 * pushes them in. A meta-only transaction doesn't change the doc, so it can't
 * trip autosave (PageEditor's onUpdate guards on `transaction.docChanged`).
 */

export const focusMarksKey = new PluginKey<FocusMarksState>('focusMarks');

export interface FocusMarksMeta {
  marked: string[];
  edited: string[];
}

interface FocusMarksState {
  marked: Set<string>;
  edited: Set<string>;
  deco: DecorationSet;
}

function decorate(doc: PMNode, marked: Set<string>, edited: Set<string>): DecorationSet {
  if (marked.size === 0 && edited.size === 0) return DecorationSet.empty;
  const decos: Decoration[] = [];
  doc.descendants((node, pos) => {
    const id = node.attrs?.id;
    if (typeof id !== 'string') return true;
    // Edited wins over marked when a block is in both — the green "this changed"
    // signal is more useful than the blue "I picked this" one post-run.
    const cls = edited.has(id) ? 'is-edited' : marked.has(id) ? 'is-focus-marked' : null;
    if (cls) decos.push(Decoration.node(pos, pos + node.nodeSize, { class: cls }));
    return true;
  });
  return DecorationSet.create(doc, decos);
}

export const FocusMarks = Extension.create({
  name: 'focusMarks',

  addProseMirrorPlugins() {
    return [
      new Plugin<FocusMarksState>({
        key: focusMarksKey,
        state: {
          init: () => ({
            marked: new Set<string>(),
            edited: new Set<string>(),
            deco: DecorationSet.empty,
          }),
          apply(tr, value, _old, newState) {
            const meta = tr.getMeta(focusMarksKey) as FocusMarksMeta | undefined;
            if (meta) {
              const marked = new Set(meta.marked);
              const edited = new Set(meta.edited);
              return { marked, edited, deco: decorate(newState.doc, marked, edited) };
            }
            // Edits shift positions — recompute against the new doc (ids stable).
            if (tr.docChanged && (value.marked.size > 0 || value.edited.size > 0)) {
              return { ...value, deco: decorate(newState.doc, value.marked, value.edited) };
            }
            return value;
          },
        },
        props: {
          decorations(state) {
            return focusMarksKey.getState(state)?.deco ?? null;
          },
        },
      }),
    ];
  },
});
