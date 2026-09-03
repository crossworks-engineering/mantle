/**
 * Deriving a page from something else: a file, a note, several notes,
 * or a journal window.
 *
 * Split out of builtins-pages.ts; bodies moved verbatim.
 */

import {
  createPage,
  markdownToDoc,
  nodeUrl,
  getNote,
  getJournal,
  supersedeNode,
} from '@mantle/content';
import { fileById, readFileById } from '@mantle/files';
import { recordIngest } from '@mantle/tracing';
import type { BuiltinToolDef } from '../types';
import { str, strArr } from '../coerce';
import { notFound } from '../errors';
import { errorMessage } from '@mantle/std';
import { FILE_ID_PRE, NOTE_ID_PRE } from './common';

export const page_from_file: BuiltinToolDef = {
  slug: 'page_from_file',
  preconditions: FILE_ID_PRE,
  name: 'Create page from file',
  description:
    "Create a page by importing a markdown/text file's bytes directly — the bytes go server-side from `files` → `markdownToDoc` → `createPage` without round-tripping through your output. **Always prefer this over `file_read` + `page_create` for file → page operations.** It scales to arbitrarily large files (a 100 KB Notion export imports in one tool call instead of choking on your max_tokens cap) and the result is byte-faithful to the source. Returns the new page's id + title; the body is never echoed back to you (use page_get if you need to verify content). Title defaults to the file's basename without extension if you omit it. Only text-like files are accepted (markdown / plain text) — binaries (PDF / docx / xlsx) are rejected with a clear error since their indexed text already lives on the file node and can't be losslessly converted to a page. The source file is marked SUPERSEDED by the new page (a reversible retrieval down-weight — the page is now the living copy; undo with `content_supersede`); pass `supersede_source: false` to keep both at full retrieval weight.",
  inputSchema: {
    type: 'object',
    properties: {
      file_id: { type: 'string', format: 'uuid', description: 'id of the file node to import' },
      title: {
        type: 'string',
        description: 'page title; defaults to the file basename (without extension) if omitted',
      },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: "Labels for organisation and filtering, e.g. ['work'].",
      },
      icon: { type: 'string', description: 'optional emoji icon, e.g. "📄"' },
      supersede_source: {
        type: 'boolean',
        default: true,
        description:
          'mark the source file superseded by the new page (reversible retrieval down-weight); false keeps both at full weight',
      },
    },
    required: ['file_id'],
  },
  handler: async (input, ctx) => {
    const fileId = str(input.file_id).trim();
    if (!fileId) return { ok: false, error: 'file_id is required' };
    const meta = await fileById({ ownerId: ctx.ownerId, fileId });
    if (!meta) return notFound('file', fileId, 'file_list / search_nodes');
    if (!meta.isText) {
      return {
        ok: false,
        error:
          `page_from_file: '${meta.filename}' is a binary file (mime='${meta.mimeType}') ` +
          `and cannot be imported as a page. The extractor already indexes its parsed ` +
          `text on the file node; reference it via file_get instead, or convert the ` +
          `source to markdown first.`,
      };
    }
    const res = await readFileById({ ownerId: ctx.ownerId, fileId });
    if (!res) return { ok: false, error: 'file bytes unavailable' };

    // Title resolution: explicit arg wins; otherwise derive from filename.
    // Assistant + Telegram uploads land as
    //   '<unix-ms-timestamp>-<slug>-<hex-hash>.<ext>'
    // (the server's collision-safe naming scheme). The naive
    // strip-ext + dashes→spaces derivation surfaced that as a useless
    // 'Untitled' substitute — '1779877120189 he is the potter we are
    // the clay 3621047f3c9e80ba96a9e6f6c08'. Try to recover the slug
    // first; fall back to the naive form for hand-named uploads.
    const titleArg = str(input.title).trim();
    const baseName = (meta.filename ?? 'Untitled').replace(/\.[^.]+$/, '');
    const uploadPattern = /^\d{10,}-(.+?)-[a-f0-9]{20,}$/i;
    const uploadMatch = baseName.match(uploadPattern);
    const slugSource = uploadMatch ? uploadMatch[1]! : baseName;
    const derivedTitle =
      slugSource
        .replace(/[-_]+/g, ' ')
        .trim()
        .replace(/^./, (c) => c.toUpperCase()) || 'Untitled';
    const title = (titleArg || derivedTitle).slice(0, 200);

    const tags = strArr(input.tags);
    const icon = str(input.icon).trim();

    try {
      const markdown = res.bytes.toString('utf8');
      const doc = markdownToDoc(markdown);
      const page = await createPage(ctx.ownerId, {
        title,
        doc,
        tags,
        ...(icon ? { icon } : {}),
      });
      // The page is now the living copy — stamp the lineage edge so retrieval
      // demotes the source file and annotates hits with the successor
      // (content-currency layer). Best-effort: a failed stamp must not fail
      // the import; the mark is recoverable via content_supersede.
      const supersedeSource =
        input.supersede_source === undefined ? true : input.supersede_source === true;
      let sourceSuperseded = false;
      if (supersedeSource) {
        try {
          await supersedeNode({
            ownerId: ctx.ownerId,
            id: fileId,
            supersededBy: page.id,
            reason: 'migrated',
          });
          sourceSuperseded = true;
        } catch (err) {
          console.error('[page_from_file] could not mark source superseded:', err);
        }
      }
      ctx.step?.setOutput({
        id: page.id,
        title: page.title,
        source_file_id: fileId,
        source_byte_size: res.bytes.length,
        source_superseded: sourceSuperseded,
      });
      void recordIngest({
        source: 'agent_tool',
        ownerId: ctx.ownerId,
        nodeId: page.id,
        summary: `Page imported from file: ${page.title}`,
        payload: {
          via: 'page_from_file_tool',
          sourceFileId: fileId,
          sourceFilename: meta.filename,
          sourceByteSize: res.bytes.length,
          tags,
          ...(ctx.agent ? { invokingAgent: ctx.agent.slug } : {}),
        },
        // Cap the snippet so we don't bloat trace storage on a 100 KB import —
        // the full source is on the file node, retrievable via file_read.
        snippet: markdown.slice(0, 4000),
      });
      return {
        ok: true,
        output: {
          id: page.id,
          url: nodeUrl(page.id),
          title: page.title,
          tags: page.tags,
          source_file_id: fileId,
          source_byte_size: res.bytes.length,
          source_superseded: sourceSuperseded,
        },
      };
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    }
  },
};

export const page_from_note: BuiltinToolDef = {
  slug: 'page_from_note',
  preconditions: NOTE_ID_PRE,
  name: 'Create page from note',
  description:
    "Promote an EXISTING note into a rich page — the note's body is copied server-side WITHOUT round-tripping through your output, byte-faithful at any size. **Always prefer this over `note_get` + `page_create` when the user wants a note turned into a page** — you pass the note id, NOT its text. Pass `parent_id` to nest the new page UNDER an existing page. Title/tags default to the note's own unless you override. The note is marked SUPERSEDED — a reversible down-weight (`supersede_source: false` to skip). Returns the new page's id + title; the body is never echoed back (verify with `page_get`). **When delegating, hand off the note id + parent id only — never paste the note body into the prompt.**",
  inputSchema: {
    type: 'object',
    properties: {
      note_id: { type: 'string', format: 'uuid', description: 'id of the note to promote' },
      supersede_source: {
        type: 'boolean',
        default: true,
        description:
          'mark the source note superseded by the new page (reversible retrieval down-weight); false keeps both at full weight',
      },
      parent_id: {
        type: 'string',
        format: 'uuid',
        description:
          'optional id of an existing page to nest the new page UNDER (makes it a sub-page); omit for top-level',
      },
      title: {
        type: 'string',
        description: "page title; defaults to the note's title if omitted",
      },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: "page tags; defaults to the note's tags if omitted",
      },
      icon: { type: 'string', description: 'optional emoji icon, e.g. "📄"' },
    },
    required: ['note_id'],
  },
  handler: async (input, ctx) => {
    const noteId = str(input.note_id).trim();
    if (!noteId) return { ok: false, error: 'note_id is required' };

    const note = await getNote(ctx.ownerId, noteId);
    if (!note) {
      return {
        ok: false,
        error: `note ${noteId} not found — pass the id of an existing note (see note_list / search_nodes).`,
      };
    }

    const parentId = str(input.parent_id).trim();
    const titleArg = str(input.title).trim();
    const title = (titleArg || note.title || 'Untitled').slice(0, 200);
    const tagsArg = strArr(input.tags);
    const tags = tagsArg.length ? tagsArg : note.tags;
    const icon = str(input.icon).trim();

    try {
      const doc = markdownToDoc(note.content);
      const page = await createPage(ctx.ownerId, {
        title,
        doc,
        tags,
        ...(icon ? { icon } : {}),
        ...(parentId ? { parentId } : {}),
      });
      // The page is the note's promotion — stamp the lineage edge (reversible
      // retrieval down-weight on the note; content-currency layer). Opt out
      // with supersede_source: false. Best-effort: never fails the promotion.
      const supersedeSource =
        input.supersede_source === undefined ? true : input.supersede_source === true;
      let sourceSuperseded = false;
      if (supersedeSource) {
        try {
          await supersedeNode({
            ownerId: ctx.ownerId,
            id: noteId,
            supersededBy: page.id,
            reason: 'migrated',
          });
          sourceSuperseded = true;
        } catch (err) {
          console.error('[page_from_note] could not mark source superseded:', err);
        }
      }
      ctx.step?.setOutput({
        id: page.id,
        title: page.title,
        source_note_id: noteId,
        source_superseded: sourceSuperseded,
        ...(parentId ? { parent_id: parentId } : {}),
      });
      void recordIngest({
        source: 'agent_tool',
        ownerId: ctx.ownerId,
        nodeId: page.id,
        summary: `Page created from note: ${page.title}`,
        payload: {
          via: 'page_from_note_tool',
          sourceNoteId: noteId,
          ...(parentId ? { parentId } : {}),
          tags,
          ...(ctx.agent ? { invokingAgent: ctx.agent.slug } : {}),
        },
        snippet: note.content.slice(0, 4000),
      });
      return {
        ok: true,
        output: {
          id: page.id,
          url: nodeUrl(page.id),
          title: page.title,
          tags: page.tags,
          source_note_id: noteId,
          source_superseded: sourceSuperseded,
          ...(parentId ? { parent_id: parentId } : {}),
        },
      };
    } catch (err) {
      const msg = errorMessage(err);
      // createPage throws ParentPageNotFoundError when parent_id isn't one of
      // the owner's pages — surface that plainly (mirrors page_create).
      if (parentId && msg.includes('parent page not found')) {
        return {
          ok: false,
          error: `parent_id '${parentId}' is not one of your pages — pass the id of an existing page (see page_list / search_nodes).`,
        };
      }
      return { ok: false, error: msg };
    }
  },
};

export const page_from_notes: BuiltinToolDef = {
  slug: 'page_from_notes',
  name: 'Create page from several notes',
  description:
    "Stitch SEVERAL existing notes into ONE rich page — every note's body is copied server-side and concatenated in the order given, byte-faithful at any size. **Prefer this over `note_get` + re-typing into `page_create`** — you pass the note ids, NOT their text. Each note becomes an `## ` section from its title; `headings: false` concatenates raw. Pass `parent_id` to nest under an existing page. Tags default to the union of the source notes' tags. Originals are marked SUPERSEDED — a reversible down-weight (`supersede_source: false` to skip). Returns the new page's id + title; the body is never echoed back (verify with `page_get`). **When delegating, hand off note ids + title + parent id only — never paste note bodies.**",
  inputSchema: {
    type: 'object',
    properties: {
      note_ids: {
        type: 'array',
        items: { type: 'string', format: 'uuid' },
        minItems: 1,
        description: 'ids of the notes to combine, in the order they should appear in the page',
      },
      title: { type: 'string', description: 'title for the combined page (required)' },
      parent_id: {
        type: 'string',
        format: 'uuid',
        description:
          'optional id of an existing page to nest the new page UNDER (makes it a sub-page); omit for top-level',
      },
      headings: {
        type: 'boolean',
        description:
          "insert each note's title as an `## ` section heading above its body (default true); set false to concatenate bodies raw",
      },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: "page tags; defaults to the union of the source notes' tags if omitted",
      },
      icon: { type: 'string', description: 'optional emoji icon, e.g. "📄"' },
      supersede_source: {
        type: 'boolean',
        default: true,
        description:
          'mark each source note superseded by the compiled page (reversible retrieval down-weight); false keeps them at full weight',
      },
    },
    required: ['note_ids', 'title'],
  },
  handler: async (input, ctx) => {
    const noteIds = strArr(input.note_ids)
      .map((id) => id.trim())
      .filter(Boolean);
    if (noteIds.length === 0) {
      return { ok: false, error: 'note_ids is required — pass at least one note id.' };
    }
    const title = str(input.title).trim().slice(0, 200);
    if (!title) {
      return {
        ok: false,
        error:
          'title is required when combining multiple notes (no single source note to borrow it from).',
      };
    }

    // Fetch all notes up front so a bad id fails the whole call cleanly rather
    // than producing a half-built page. Order is preserved from note_ids.
    const fetched = await Promise.all(noteIds.map((id) => getNote(ctx.ownerId, id)));
    const missing = noteIds.filter((_, i) => !fetched[i]);
    if (missing.length) {
      return {
        ok: false,
        error: `note(s) not found: ${missing.join(', ')} — pass ids of existing notes (see note_list / search_nodes).`,
      };
    }
    const notes = fetched as NonNullable<(typeof fetched)[number]>[];

    const parentId = str(input.parent_id).trim();
    const withHeadings = input.headings === undefined ? true : input.headings === true;
    const tagsArg = strArr(input.tags);
    const tags = tagsArg.length ? tagsArg : [...new Set(notes.flatMap((n) => n.tags))];
    const icon = str(input.icon).trim();

    const markdown = notes
      .map((n) => {
        const body = n.content.trim();
        if (!withHeadings) return body;
        const heading = `## ${(n.title || 'Untitled').trim()}`;
        return body ? `${heading}\n\n${body}` : heading;
      })
      .join('\n\n');

    try {
      const doc = markdownToDoc(markdown);
      const page = await createPage(ctx.ownerId, {
        title,
        doc,
        tags,
        ...(icon ? { icon } : {}),
        ...(parentId ? { parentId } : {}),
      });
      // Each source note is now represented in the compiled page — stamp the
      // lineage edges (reversible retrieval down-weight; content-currency
      // layer). Opt out with supersede_source: false. Best-effort per note.
      const supersedeSource =
        input.supersede_source === undefined ? true : input.supersede_source === true;
      let supersededCount = 0;
      if (supersedeSource) {
        for (const id of noteIds) {
          try {
            await supersedeNode({
              ownerId: ctx.ownerId,
              id,
              supersededBy: page.id,
              reason: 'migrated',
            });
            supersededCount++;
          } catch (err) {
            console.error('[page_from_notes] could not mark source superseded:', err);
          }
        }
      }
      ctx.step?.setOutput({
        id: page.id,
        title: page.title,
        source_note_ids: noteIds,
        note_count: notes.length,
        sources_superseded: supersededCount,
        ...(parentId ? { parent_id: parentId } : {}),
      });
      void recordIngest({
        source: 'agent_tool',
        ownerId: ctx.ownerId,
        nodeId: page.id,
        summary: `Page compiled from ${notes.length} notes: ${page.title}`,
        payload: {
          via: 'page_from_notes_tool',
          sourceNoteIds: noteIds,
          noteCount: notes.length,
          ...(parentId ? { parentId } : {}),
          tags,
          ...(ctx.agent ? { invokingAgent: ctx.agent.slug } : {}),
        },
        snippet: markdown.slice(0, 4000),
      });
      return {
        ok: true,
        output: {
          id: page.id,
          url: nodeUrl(page.id),
          title: page.title,
          tags: page.tags,
          source_note_ids: noteIds,
          note_count: notes.length,
          sources_superseded: supersededCount,
          ...(parentId ? { parent_id: parentId } : {}),
        },
      };
    } catch (err) {
      const msg = errorMessage(err);
      if (parentId && msg.includes('parent page not found')) {
        return {
          ok: false,
          error: `parent_id '${parentId}' is not one of your pages — pass the id of an existing page (see page_list / search_nodes).`,
        };
      }
      return { ok: false, error: msg };
    }
  },
};

export const page_from_journal: BuiltinToolDef = {
  slug: 'page_from_journal',
  name: 'Create page from journal entries',
  description:
    "Compile SEVERAL Journal entries into ONE page — each entry's body is copied server-side and concatenated in the order given, byte-faithful at any size. The journal counterpart of `page_from_notes` — for 'compile this week's entries into a reflection doc'. You pass entry ids (from `journal_list`), NOT their text. Each entry lands under a date(+title) `## ` heading; `headings: false` concatenates raw. Pass `parent_id` to nest under an existing page. Tags default to the union of the source entries'. The originals are LEFT IN PLACE. Returns the new page's id + title; the body is never echoed back (verify with `page_get`). **When delegating, hand off entry ids + title + parent id only — never paste entry bodies.**",
  inputSchema: {
    type: 'object',
    properties: {
      journal_ids: {
        type: 'array',
        items: { type: 'string', format: 'uuid' },
        minItems: 1,
        description:
          'ids of the journal entries to compile, in the order they should appear (see journal_list)',
      },
      title: { type: 'string', description: 'title for the compiled page (required)' },
      parent_id: {
        type: 'string',
        format: 'uuid',
        description:
          'optional id of an existing page to nest the new page UNDER; omit for top-level',
      },
      headings: {
        type: 'boolean',
        description:
          'section each entry under a date(+title) `## ` heading (default true); set false to concatenate bodies raw',
      },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: "page tags; defaults to the union of the source entries' tags if omitted",
      },
      icon: { type: 'string', description: 'optional emoji icon, e.g. "📔"' },
    },
    required: ['journal_ids', 'title'],
  },
  handler: async (input, ctx) => {
    const journalIds = strArr(input.journal_ids)
      .map((id) => id.trim())
      .filter(Boolean);
    if (journalIds.length === 0) {
      return { ok: false, error: 'journal_ids is required — pass at least one journal entry id.' };
    }
    const title = str(input.title).trim().slice(0, 200);
    if (!title) {
      return {
        ok: false,
        error:
          'title is required when compiling journal entries (no single source to borrow it from).',
      };
    }

    // Fetch all entries up front so a bad id fails the whole call cleanly
    // rather than producing a half-built page. Order is preserved from input.
    const fetched = await Promise.all(journalIds.map((id) => getJournal(ctx.ownerId, id)));
    const missing = journalIds.filter((_, i) => !fetched[i]);
    if (missing.length) {
      return {
        ok: false,
        error: `journal entry(ies) not found: ${missing.join(', ')} — pass ids of existing entries (see journal_list / search_nodes).`,
      };
    }
    const entries = fetched as NonNullable<(typeof fetched)[number]>[];

    const parentId = str(input.parent_id).trim();
    const withHeadings = input.headings === undefined ? true : input.headings === true;
    const tagsArg = strArr(input.tags);
    const tags = tagsArg.length ? tagsArg : [...new Set(entries.flatMap((e) => e.tags))];
    const icon = str(input.icon).trim();

    const markdown = entries
      .map((e) => {
        const body = e.body.trim();
        if (!withHeadings) return body;
        // Date-first heading (entries are a chronological log); append the
        // title when it carries more than the auto-derived date would.
        const date = (e.entryDate ?? e.createdAt ?? '').slice(0, 10);
        const t = (e.title || '').trim();
        const heading = `## ${[date, t].filter(Boolean).join(' — ') || 'Entry'}`;
        return body ? `${heading}\n\n${body}` : heading;
      })
      .join('\n\n');

    try {
      const doc = markdownToDoc(markdown);
      const page = await createPage(ctx.ownerId, {
        title,
        doc,
        tags,
        ...(icon ? { icon } : {}),
        ...(parentId ? { parentId } : {}),
      });
      ctx.step?.setOutput({
        id: page.id,
        title: page.title,
        source_journal_ids: journalIds,
        entry_count: entries.length,
        ...(parentId ? { parent_id: parentId } : {}),
      });
      void recordIngest({
        source: 'agent_tool',
        ownerId: ctx.ownerId,
        nodeId: page.id,
        summary: `Page compiled from ${entries.length} journal entries: ${page.title}`,
        payload: {
          via: 'page_from_journal_tool',
          sourceJournalIds: journalIds,
          entryCount: entries.length,
          ...(parentId ? { parentId } : {}),
          tags,
          ...(ctx.agent ? { invokingAgent: ctx.agent.slug } : {}),
        },
        snippet: markdown.slice(0, 4000),
      });
      return {
        ok: true,
        output: {
          id: page.id,
          url: nodeUrl(page.id),
          title: page.title,
          tags: page.tags,
          source_journal_ids: journalIds,
          entry_count: entries.length,
          ...(parentId ? { parent_id: parentId } : {}),
        },
      };
    } catch (err) {
      const msg = errorMessage(err);
      if (parentId && msg.includes('parent page not found')) {
        return {
          ok: false,
          error: `parent_id '${parentId}' is not one of your pages — pass the id of an existing page (see page_list / search_nodes).`,
        };
      }
      return { ok: false, error: msg };
    }
  },
};
