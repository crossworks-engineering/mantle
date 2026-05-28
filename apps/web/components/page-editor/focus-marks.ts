import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { Node as PMNode } from '@tiptap/pm/model';

/**
 * FocusMarks — an editor-only overlay that highlights a SET of blocks by their
 * stable `attrs.id` (Phase 2b block ids). It's the rendering half of the
 * gutter "focus marker": the user drags down the left gutter to mark sections
 * (see focus-gutter.tsx), and those block ids get a left accent bar + tint via
 * ProseMirror node decorations — the same primitive Phase 3a Pass 2 anticipated.
 *
 * Crucially this NEVER mutates the document. Marks live as plugin state driven
 * by a meta transaction (`setMeta(focusMarksKey, string[])`); the host React
 * component owns the authoritative set (and persists it to localStorage) and
 * pushes it in. A meta-only transaction doesn't change the doc, so it doesn't
 * trip autosave (PageEditor's onUpdate guards on `transaction.docChanged`).
 */

export const focusMarksKey = new PluginKey<FocusMarksState>('focusMarks');

interface FocusMarksState {
  ids: Set<string>;
  deco: DecorationSet;
}

function decorate(doc: PMNode, ids: Set<string>): DecorationSet {
  if (ids.size === 0) return DecorationSet.empty;
  const decos: Decoration[] = [];
  doc.descendants((node, pos) => {
    const id = node.attrs?.id;
    if (typeof id === 'string' && ids.has(id)) {
      decos.push(Decoration.node(pos, pos + node.nodeSize, { class: 'is-focus-marked' }));
    }
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
          init: () => ({ ids: new Set<string>(), deco: DecorationSet.empty }),
          apply(tr, value, _old, newState) {
            const meta = tr.getMeta(focusMarksKey) as string[] | undefined;
            if (meta) {
              const ids = new Set(meta);
              return { ids, deco: decorate(newState.doc, ids) };
            }
            // Edits shift positions — recompute the decoration set against the
            // new doc (ids are stable, so the same blocks stay marked).
            if (tr.docChanged && value.ids.size > 0) {
              return { ids: value.ids, deco: decorate(newState.doc, value.ids) };
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
