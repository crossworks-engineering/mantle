/**
 * `translate`: the Translator worker's tool. Text, or an item (a page, a
 * note, a file, an email, any node with text), into a language; with
 * `save`, a new copy beside the original ("Spec (German)").
 *
 * Owner's decisions (2026-11-19):
 *  - one tool, called by someone: no trigger, timer or sweep starts it, so
 *    a paid call happens only when a person or an agent asks;
 *  - everything is translated: a long text is cut into parts sized by the
 *    model's own limits (translate-parts.ts), each part is translated, and
 *    a part that fails stops the call with an error; a shortened text is
 *    never returned;
 *  - the worker is `translator`; a brain without one uses its summarizer
 *    worker's route, with the translation rules (never the summarizer's
 *    own prompt).
 *
 * Rights: the item is read with `db` in the caller's scope (its own row
 * level rights: an item the caller does not read answers as a random id),
 * and the copy is written through the content library, whose writes the
 * database checks for the caller. An email is read only by an Admin user
 * with the Connectors area, as the mail tools are.
 */
import { and, eq, sql } from 'drizzle-orm';
import {
  aiWorkers,
  db,
  emails,
  getDefaultWorker,
  nodes,
  onNarrowSpots,
  callerHasArea,
  type AiWorker,
  type TranslatorParams,
} from '@mantle/db';
import { modelPolicyRefusal } from '@mantle/config';
import { resolveDefaultWorker } from '@mantle/api-keys';
import {
  createNote,
  createPage,
  docToMarkdown,
  getPage,
  markdownToDoc,
  nodeUrl,
  NOTES_ROOT_LABEL,
  PageFolderNotFoundError,
  ParentPageNotFoundError,
} from '@mantle/content';
import { moveTreeItems, notifyTreeChanged } from '@mantle/content/tree';
import { fileById, isDefaultFileText, parserText, readFileById } from '@mantle/files';
import {
  cutMakesPartial,
  hasPartialReadCut,
  hasReadCut,
  readCutReason,
  readCutViews,
  type ReadCuts,
} from '@mantle/files/read-cut';
import { withReadCutSink } from '@mantle/files/read-cut-sink';
import { filePagesOf, pagesText } from '@mantle/content/page-passages';
import {
  log,
  catalogHasModel,
  catalogModalities,
  contextLimitForRoute,
  outputLimitForRoute,
  refreshModelCatalog,
} from '@mantle/tracing';
import { getChatAdapter, type ProviderCredential } from '@mantle/voice';
import { errorMessage, isScopeWriteRefusal, publicProviderErrorMessage } from '@mantle/std';
import type { BuiltinToolDef, ToolHandlerContext, ToolHandlerResult } from './types';
import { boolOpt, strOpt } from './coerce';
import { defaultWorkerOrError } from './builtins-workers';
import { CS } from './client-sourced-rule';
import { isOwnerSurface, loginTurnSurfaceId } from './surface';
import { surfaceHiddenNodeTypes } from './team-visibility';
import { visibilityRefusal } from './visibility-refusal';
import { workspaceTokensLeft } from './builtins-delegation';
import {
  estimateTokens,
  partBudgetFor,
  TRANSLATE_EXPANSION,
  TRANSLATE_PROMPT_TOKENS,
  translateInParts,
  TranslatePartError,
  type ModelRoute,
  type PartCall,
} from './translate-parts';

const logger = log('translate');

/** The answer for an item the caller does not read, a hidden kind and a
 *  random id alike: it never says the item exists. */
export const TRANSLATE_NOT_FOUND = (id: string) =>
  `Item ${id} not found: it may have been deleted or the id mistyped. Find it with search_nodes or tree_list, then try again.`;

/** The providers that run a model on a server of the owner's own, which may
 *  trim a prompt longer than its window by itself. */
const SELF_HOSTED_PROVIDERS: ReadonlySet<string> = new Set(['local', 'custom']);

/** The extractor's ceiling on a file's stored text (server/api
 *  extract/text.ts TEXT_STORE_MAX_CHARS): a text this long may be cut. */
export const STORED_TEXT_MAX_CHARS = 1_000_000;

/** A language as a caller names it: letters (any script), spaces, hyphens
 *  and brackets only ("German", "pt-BR", "Chinese (Simplified)"), so no
 *  instruction rides in the prompt beside it. */
const LANGUAGE_RE = /^[\p{L}\p{M}0-9 ()-]+$/u;
/** At most four words ("Chinese (Simplified)", "Brazilian Portuguese",
 *  "es-419"): a language, never a sentence. */
const LANGUAGE_WORDS_MAX = 4;

/** The longest `to` / `from` (a language's name or code). */
const LANGUAGE_MAX = 64;

/** A language as a person reads it: a code (`de`, `pt-BR`) by its English
 *  name, anything else as given. */
export function languageLabel(lang: string): string {
  const t = lang.trim();
  if (/^[a-z]{2,3}(-[a-z0-9]{2,8})*$/i.test(t)) {
    try {
      const name = new Intl.DisplayNames(['en'], { type: 'language' }).of(t);
      if (name && name.toLowerCase() !== t.toLowerCase()) return name;
    } catch {
      // Not a code Intl knows: as given.
    }
  }
  return t;
}

/** The copy's title: "<original> (<language>)". */
export function translatedTitle(original: string, to: string): string {
  return `${original.trim() || 'Untitled'} (${languageLabel(to)})`.slice(0, 200);
}

/** What a translation is read from. */
type Source = {
  /** `text` (pasted), the item's kind (`note`, `page`, `file`, `email`), or
   *  `other`. */
  kind: string;
  id: string | null;
  title: string;
  text: string;
  path: string | null;
  tags: string[];
};

/** Why a file's stored text is not all of it, from the reader's own
 *  record (`data.read_cut`, `data.ocr`), or null. The cut of the stored
 *  copy itself (`text_store`) is no reason: the whole text is read again
 *  (wholeFileText). A detail-only cut (a small picture left out) is none. */
function textCutOf(data: Readonly<Record<string, unknown>>): string | null {
  const cuts = data.read_cut;
  if (hasPartialReadCut(cuts)) {
    const views = readCutViews(cuts as ReadCuts).filter(
      (v) => cutMakesPartial(v.key) && readCutReason(v.key) !== 'text_store',
    );
    if (views.length) return views.map((v) => v.hint).join(' ');
  }
  const ocr = data.ocr as { pages_read?: unknown; pages_total?: unknown } | undefined;
  if (
    ocr &&
    typeof ocr.pages_read === 'number' &&
    typeof ocr.pages_total === 'number' &&
    ocr.pages_read < ocr.pages_total
  ) {
    return `Only ${ocr.pages_read} of ${ocr.pages_total} pages were read.`;
  }
  return null;
}

/**
 * A file's whole text, or the refusal: never a part translated as if it
 * were all (the standing rule, 2026-11-19). A file the reader took only in
 * part (its own record says so) is refused. A stored copy cut at the
 * extractor's ceiling is read whole: the file's pages from its database
 * (a PDF book, as file_read does), else the parser service once more, with
 * the cuts it reports collected; any cut, or no longer text, refuses.
 */
async function wholeFileText(
  id: string,
  filename: string,
  data: Readonly<Record<string, unknown>>,
  stored: string,
  ownerId: string,
): Promise<{ text: string } | { error: string }> {
  const partly = (why: string) => ({
    error: `File ${id} was read only in part, so a translation would leave text out: nothing was translated. ${why} Re-read the file once its reader takes all of it, or translate the parts you have.`,
  });
  const cut = textCutOf(data);
  if (cut) return partly(cut);
  const cuts = data.read_cut as Record<string, unknown> | undefined;
  const storeCut = !!cuts && Object.keys(cuts).some((k) => readCutReason(k) === 'text_store');
  // An older file carries no record: its length says the stored copy may
  // be cut.
  const mayBeCut = storeCut || (!hasReadCut(cuts) && stored.length >= STORED_TEXT_MAX_CHARS);
  if (!mayBeCut) return { text: stored };
  const pages = await filePagesOf({ id, ownerId, sha256: data.sha256 });
  if (pages && pages.pages.length > 0) {
    const joined = pagesText(pages.pages);
    if (joined.length > stored.length) return { text: joined };
  }
  const res = await readFileById({ ownerId, fileId: id });
  const ext = (filename.match(/\.([^.]+)$/)?.[1] ?? '').toLowerCase();
  if (res) {
    // The parser service reads the bytes again (an untrusted file is read
    // only there); what it says it left out is collected.
    const again = await withReadCutSink(() => parserText(res.bytes, ext)).catch(() => null);
    if (again && !hasPartialReadCut(again.cuts) && again.value.length > stored.length) {
      return { text: again.value };
    }
  }
  return partly(
    `Its stored text stops at ${STORED_TEXT_MAX_CHARS.toLocaleString('en-US')} characters and it could not be read again in full here.`,
  );
}

/** The text of the item `id` as the caller reads it, or the refusal. */
async function readSource(
  id: string,
  ctx: ToolHandlerContext,
): Promise<Source | { error: string }> {
  const [row] = await db
    .select({
      id: nodes.id,
      type: nodes.type,
      title: nodes.title,
      path: sql<string>`${nodes.path}::text`,
      tags: nodes.tags,
      data: nodes.data,
    })
    .from(nodes)
    .where(and(eq(nodes.id, id), eq(nodes.ownerId, ctx.ownerId)))
    .limit(1);
  if (!row || surfaceHiddenNodeTypes(ctx.surface)?.includes(row.type)) {
    return { error: TRANSLATE_NOT_FOUND(id) };
  }
  const data = (row.data ?? {}) as Record<string, unknown>;
  const base = {
    id: row.id,
    title: row.title ?? '',
    path: row.path ?? null,
    tags: row.tags ?? [],
  };
  const empty = { error: `Item ${id} has no text to translate.` };
  switch (row.type) {
    case 'page': {
      const page = await getPage(ctx.ownerId, id);
      if (!page) return { error: TRANSLATE_NOT_FOUND(id) };
      const text = docToMarkdown(page.doc);
      return text.trim() ? { ...base, kind: 'page', text } : empty;
    }
    case 'note': {
      const text = typeof data.content === 'string' ? data.content : '';
      return text.trim() ? { ...base, kind: 'note', text } : empty;
    }
    case 'file': {
      const meta = await fileById({ ownerId: ctx.ownerId, fileId: id });
      if (!meta) return { error: TRANSLATE_NOT_FOUND(id) };
      let text = '';
      if (meta.isText) {
        const res = await readFileById({ ownerId: ctx.ownerId, fileId: id });
        text = res ? res.bytes.toString('utf8') : '';
      } else if (typeof data.text === 'string' && !isDefaultFileText(data.text)) {
        // The text the reader took out of a PDF, Word or Excel file. The
        // stand-in of a file no reader reads names the file only: no text.
        text = data.text;
        const full = await wholeFileText(id, meta.filename, data, text, ctx.ownerId);
        if ('error' in full) return full;
        text = full.text;
      } else {
        // A file whose reader gave its text by page only (a PDF book).
        const cut = textCutOf(data);
        if (cut) {
          return {
            error: `File ${id} was read only in part, so a translation would leave text out: nothing was translated. ${cut}`,
          };
        }
        const pages = await filePagesOf({ id, ownerId: ctx.ownerId, sha256: data.sha256 });
        if (pages && pages.pages.length > 0) text = pagesText(pages.pages);
      }
      if (!text.trim()) {
        return {
          error: `File ${id} has no readable text yet (a scan not read, or a file still being read). Try again once it has been read.`,
        };
      }
      return {
        ...base,
        title: meta.filename.replace(/\.[^.]+$/, '') || base.title,
        kind: 'file',
        text,
      };
    }
    case 'email': {
      // Mail is the owner's private corpus: an Admin user with Connectors,
      // as the mail tools ask.
      if (!(await callerHasArea('connectors'))) {
        return {
          error:
            'Reading mail needs the Connectors area of the Admin workspace. Ask an Admin user to translate it.',
        };
      }
      const [mail] = await db
        .select({ subject: emails.subject, bodyText: emails.bodyText, bodyHtml: emails.bodyHtml })
        .from(emails)
        .where(eq(emails.nodeId, id))
        .limit(1);
      if (!mail) return { error: TRANSLATE_NOT_FOUND(id) };
      let body = mail.bodyText?.trim() ?? '';
      if (!body && mail.bodyHtml) {
        body = (
          await parserText(Buffer.from(mail.bodyHtml, 'utf8'), 'html').catch(() => '')
        ).trim();
      }
      const subject = mail.subject?.trim() ?? '';
      const text = [subject && `# ${subject}`, body].filter(Boolean).join('\n\n');
      return text.trim() ? { ...base, title: subject || base.title, kind: 'email', text } : empty;
    }
    default: {
      const text = ['content', 'text', 'body']
        .map((k) => data[k])
        .find((v): v is string => typeof v === 'string' && v.trim() !== '');
      return text ? { ...base, kind: 'other', text } : empty;
    }
  }
}

/** The worker a translation runs on: the brain's translator, else its
 *  summarizer's route (the narrator's rule), or the sentence to hand back. */
export async function translatorWorker(
  ownerId: string,
): Promise<
  | { ok: true; worker: AiWorker; credential: ProviderCredential; fallback: boolean }
  | { ok: false; error: string }
> {
  const r = await resolveDefaultWorker(ownerId, 'translator');
  if (r.ok) return { ok: true, worker: r.worker, credential: r.credential, fallback: false };
  if (r.why !== 'none') {
    const why = await defaultWorkerOrError(ownerId, 'translator');
    return why.ok
      ? { ok: true, worker: why.worker, credential: why.credential, fallback: false }
      : why;
  }
  const s = await defaultWorkerOrError(ownerId, 'summarizer');
  if (!s.ok) {
    return {
      ok: false,
      error:
        'No translator worker, and no summarizer worker to fall back to. Add a Translator at /settings/ai-workers.',
    };
  }
  return { ok: true, worker: s.worker, credential: s.credential, fallback: true };
}

/** Where the copy went and how to open it. */
type Saved = { id: string; kind: 'page' | 'note'; title: string; url: string; placed: string };

/** Write the copy: a note stays a note, a page a page, anything else a
 *  page. Beside the original on the owner's own surface; elsewhere at the
 *  top level (filing in a folder is the owner's, placementRefusal). */
async function saveCopy(
  source: Source,
  translation: string,
  title: string,
  meta: { to: string; from: string | null },
  ctx: ToolHandlerContext,
): Promise<Saved> {
  const owner = isOwnerSurface(ctx.surface);
  const translationOf = {
    ...(source.id ? { id: source.id } : {}),
    to: meta.to,
    ...(meta.from ? { from: meta.from } : {}),
  };
  if (source.kind === 'note') {
    const note = await createNote(ctx.ownerId, {
      title,
      content: translation,
      tags: source.tags,
      data: { translationOf },
    });
    let placed = 'the top level of Notes';
    if (owner && source.path && source.path !== NOTES_ROOT_LABEL) {
      try {
        const [folder] = (await db.execute(sql`
          select id from nodes
           where type = 'branch' and path = ${source.path}::ltree
             and owner_id in (${ctx.ownerId}, public.mantle_brain_id())
           limit 1`)) as unknown as Array<{ id: string }>;
        if (folder) {
          // A new copy takes its folder's sharing, as a new page does.
          const moved = await moveTreeItems(ctx.ownerId, 'notes', [note.id], folder.id, {
            confirm: true,
          });
          if (moved.moved) {
            await notifyTreeChanged(ctx.ownerId, 'notes');
            placed = "the original's folder";
          }
        }
      } catch (err) {
        logger.warn(`could not file the note beside its original: ${errorMessage(err)}`);
      }
    }
    return { id: note.id, kind: 'note', title: note.title, url: nodeUrl(note.id), placed };
  }
  const doc = markdownToDoc(translation);
  const input = {
    title,
    doc,
    tags: source.kind === 'page' ? source.tags : [],
    data: { translationOf },
  };
  if (source.kind === 'page' && owner && source.id) {
    try {
      const page = await createPage(ctx.ownerId, { ...input, siblingOf: source.id });
      return {
        id: page.id,
        kind: 'page',
        title: page.title,
        url: nodeUrl(page.id),
        placed: "the original's folder",
      };
    } catch (err) {
      // The original's folder is not one the copy can go in (gone, or the
      // caller may not write there): the top level, where the database
      // checks the create again. Any other error (a busy folder, the
      // database) is the save's own: it is reported, never hidden.
      const placement =
        err instanceof ParentPageNotFoundError ||
        err instanceof PageFolderNotFoundError ||
        isScopeWriteRefusal(err) ||
        visibilityRefusal(err) !== null;
      if (!placement) throw err;
      logger.warn(`the copy cannot go beside its original: ${errorMessage(err)}`);
    }
  }
  const page = await createPage(ctx.ownerId, input);
  return {
    id: page.id,
    kind: 'page',
    title: page.title,
    url: nodeUrl(page.id),
    placed: 'the top level of Pages',
  };
}

export const translateTool: BuiltinToolDef = {
  slug: 'translate',
  policy: {
    // Reads the item; with `save` writes a new copy of it.
    // Any kind with text: a page, a note, a file, a mail, any item.
    matrix: { action: 'read', param: 'node_id' },
    itemArgs: [{ param: 'node_id', least: 'read' }],
    effect: 'write',
    spends: 'ownerKey',
    startsModelWork: true,
    scope: 'any',
    creates: 'page',
    peerRisky: true,
    // The translation is other people's words (a mail, an upload): read as
    // data, never as instructions.
    outside: { untrusted: true },
    memberApp: 'refused',
    clientSourced: CS.creates(),
  },
  name: 'Translate text or an item',
  description:
    'Translate text, or an item by id (page, note, file, email, any item with text), into another language and return the translation. ' +
    'Every word is translated: a long text goes in parts sized to the model; a part that fails fails the call, never a shortened text. ' +
    'Markdown, tables, code, numbers, units, names and links stay as they are. ' +
    '`save: true` also makes a new copy beside the original, e.g. "Spec (German)": a note stays a note, a page a page, anything else becomes a page; the original is never changed. ' +
    'Paid model work (the Translator worker): translate only what the user asked for.',
  preconditions: [{ kind: 'node_exists', param: 'node_id', lookup: 'search_nodes / tree_list' }],
  inputSchema: {
    type: 'object',
    properties: {
      text: {
        type: 'string',
        description: 'The text to translate. Provide this OR `node_id`, not both.',
      },
      node_id: {
        type: 'string',
        format: 'uuid',
        description:
          'The id of the item to translate (a page, note, file, email or any item with text), from search_nodes or tree_list. Provide this OR `text`, not both.',
      },
      to: {
        type: 'string',
        description: 'The language to translate into, by name or code: "German", "de", "pt-BR".',
      },
      from: {
        type: 'string',
        description: 'The language of the source, when known. Omit it and the model detects it.',
      },
      save: {
        type: 'boolean',
        default: false,
        description:
          'Also save the translation as a new item beside the original (the original is never changed).',
      },
      title: {
        type: 'string',
        description:
          'The title of the saved copy. Default: the original’s title with the language, e.g. "Spec (German)".',
      },
      quality: {
        type: 'string',
        enum: ['standard', 'high'],
        default: 'standard',
        description:
          "'high' runs the translation on the Translator's stronger, dearer model (about six times the price): only when the user asks for careful terminology or style.",
      },
    },
    required: ['to'],
  },
  handler: async (input, ctx): Promise<ToolHandlerResult> => {
    const inline = strOpt(input.text);
    const nodeId = strOpt(input.node_id)?.trim();
    if (!inline && !nodeId) return { ok: false, error: 'Provide either text or node_id.' };
    if (inline && nodeId) {
      return { ok: false, error: 'Provide only one of text / node_id, not both.' };
    }
    const to = strOpt(input.to)?.trim() ?? '';
    const from = strOpt(input.from)?.trim() || null;
    for (const [name, v] of [
      ['to', to],
      ['from', from ?? ''],
    ] as const) {
      if (
        v &&
        (v.length > LANGUAGE_MAX ||
          !LANGUAGE_RE.test(v) ||
          v.split(/[\s()-]+/).filter(Boolean).length > LANGUAGE_WORDS_MAX ||
          !/\p{L}/u.test(v))
      ) {
        return {
          ok: false,
          error: `\`${name}\` is a language name or code: letters, spaces and hyphens, e.g. "German" or "pt-BR".`,
        };
      }
    }
    if (!to) return { ok: false, error: 'Say which language to translate into (`to`).' };
    const save = boolOpt(input.save) === true;
    // Save wherever the caller may write (owner's decision 2026-11-19): off
    // the owner's surfaces the copy is the turn's login's own create, with
    // that login's rights (the write gateway refuses what it may not
    // write). A workspace turn that names no login (a heartbeat, the Team
    // responder with no member on the other end) has nobody to write as:
    // no copy.
    if (save && !isOwnerSurface(ctx.surface) && !loginTurnSurfaceId(ctx.surface)) {
      return {
        ok: false,
        error:
          'This turn acts for no signed-in person, so no copy can be saved: translate again without save.',
      };
    }

    // The source first, with the caller's own rights, before any spend.
    let source: Source;
    if (nodeId) {
      const read = await readSource(nodeId, ctx);
      if ('error' in read) return { ok: false, error: read.error };
      source = read;
    } else {
      if (!inline!.trim()) return { ok: false, error: 'The text is empty.' };
      source = {
        kind: 'text',
        id: null,
        title: 'Translation',
        text: inline!,
        path: null,
        tags: [],
      };
    }

    const quality = strOpt(input.quality)?.trim() || 'standard';
    if (quality !== 'standard' && quality !== 'high') {
      return { ok: false, error: "`quality` is 'standard' or 'high'." };
    }

    const resolved = await translatorWorker(ctx.ownerId);
    if (!resolved.ok) return { ok: false, error: resolved.error };
    const { worker, credential, fallback: onSummarizer } = resolved;
    const adapter = getChatAdapter(worker.provider);
    if (!adapter) {
      return {
        ok: false,
        error: `The ${worker.kind} worker uses provider '${worker.provider}', which cannot run a chat call. Pick another provider at /settings/ai-workers.`,
      };
    }
    // The summarizer's own params are for summaries: none of them here.
    const params = (onSummarizer ? {} : (worker.params ?? {})) as TranslatorParams;
    const highModel = params.high_model?.trim();
    if (quality === 'high' && !highModel) {
      return {
        ok: false,
        error: onSummarizer
          ? "quality 'high' needs a Translator worker; this brain has none (Settings, AI workers)."
          : "quality 'high' needs the Translator's high_model (translator_settings, or Settings, AI workers).",
      };
    }
    const primaryModel = quality === 'high' ? highModel! : worker.model;
    const fallbackModel = params.fallback_model?.trim() || null;

    // The part size is the primary model's own: its context window and
    // output limit from the live catalog (a careful default when it gives
    // none). Each model is asked for its own output limit.
    await refreshModelCatalog();
    // A self-hosted route's model is not the catalog's, whatever its id
    // looks like: the careful window, never a hosted one.
    const selfHosted = SELF_HOSTED_PROVIDERS.has(worker.provider);
    const limitsOf = (model: string) => {
      const catalogOutput = selfHosted ? null : outputLimitForRoute(worker.provider, model);
      return {
        context: selfHosted ? null : contextLimitForRoute(worker.provider, model),
        output:
          params.max_tokens && params.max_tokens > 0
            ? Math.min(params.max_tokens, catalogOutput ?? params.max_tokens)
            : catalogOutput,
      };
    };
    const extra = onSummarizer ? null : worker.systemPrompt;
    const budget = partBudgetFor(
      limitsOf(primaryModel),
      params.part_tokens,
      extra ? estimateTokens(extra) : 0,
    );

    // A workspace user's daily tokens (the member budget). The whole cost is
    // estimated on the high side (every part's text, its answer at the
    // expansion, and the prompt each part is sent with); a translation that
    // cannot fit what is left is refused before any spend. While a budget
    // applies, parts go one at a time, and a run that would pass it stops
    // before the next part (the stop fails the call: no part is kept).
    const left = workspaceTokensLeft(ctx.surface);
    const promptTokens = TRANSLATE_PROMPT_TOKENS + (extra ? estimateTokens(extra) : 0);
    const sourceTokens = estimateTokens(source.text);
    const partsEstimate = Math.max(1, Math.ceil(sourceTokens / budget.partTokens));
    const costEstimate = sourceTokens * (1 + TRANSLATE_EXPANSION) + partsEstimate * promptTokens;
    const perPart = Math.min(
      costEstimate,
      budget.partTokens * (1 + TRANSLATE_EXPANSION) + promptTokens,
    );
    if (left !== null && left < costEstimate) {
      return {
        ok: false,
        error:
          'This translation needs more of your daily tokens than are left today. Try a shorter text, or ask an Admin user.',
      };
    }
    const primary: ModelRoute = { model: primaryModel, maxOutputTokens: budget.maxOutputTokens };
    const fallbackRoute: ModelRoute | null =
      fallbackModel && fallbackModel !== primaryModel
        ? {
            model: fallbackModel,
            maxOutputTokens: partBudgetFor(limitsOf(fallbackModel)).maxOutputTokens,
          }
        : null;

    const call: PartCall = async (route, system, user) => {
      const opts = {
        ...credential,
        model: route.model,
        messages: [
          { role: 'system' as const, content: system },
          { role: 'user' as const, content: user },
        ],
        temperature: params.temperature ?? 0.2,
        maxTokens: route.maxOutputTokens,
      };
      try {
        // A stream when the provider has one: a long part's answer takes
        // longer than a one-shot call's deadline, a stream is held open
        // while words arrive.
        const result = adapter.chatStream
          ? await adapter.chatStream(opts, () => {})
          : await adapter.chat(opts);
        return {
          text: result.text,
          finishReason: result.finishReason,
          // A self-hosted server may trim a long prompt by itself: what it
          // says it read is checked. A hosted route refuses instead.
          ...(selfHosted && result.tokensIn !== undefined ? { tokensIn: result.tokensIn } : {}),
        };
      } catch (err) {
        throw new Error(publicProviderErrorMessage(err, 'translate', ctx.step), { cause: err });
      }
    };

    let done: { text: string; parts: number; fallbackParts: number };
    try {
      done = await translateInParts({
        text: source.text,
        to,
        from,
        extra,
        partTokens: budget.partTokens,
        primary,
        fallback: fallbackRoute,
        call,
        ...(left !== null
          ? {
              concurrency: 1,
              stopReason: () => {
                const now = workspaceTokensLeft(ctx.surface);
                return now !== null && now < perPart
                  ? 'your daily tokens would run out before the next part'
                  : null;
              },
            }
          : {}),
      });
    } catch (err) {
      if (err instanceof TranslatePartError) {
        ctx.step?.setMeta({
          worker_slug: worker.slug,
          parts: err.parts,
          parts_done: err.done,
          ...(err.wait ? { provider_wait: err.wait.reason } : {}),
        });
        return { ok: false, error: err.message };
      }
      return { ok: false, error: publicProviderErrorMessage(err, 'translate', ctx.step) };
    }

    ctx.step?.setMeta({
      adapter: adapter.adapterName,
      worker_slug: worker.slug,
      worker_fallback: onSummarizer,
      model: primaryModel,
      quality,
      parts: done.parts,
      fallback_parts: done.fallbackParts,
      part_tokens: budget.partTokens,
      source_length: source.text.length,
      translation_length: done.text.length,
    });

    let saved: Saved | null = null;
    let saveError: string | null = null;
    if (save) {
      const title = strOpt(input.title)?.trim().slice(0, 200) || translatedTitle(source.title, to);
      try {
        saved = await saveCopy(source, done.text, title, { to, from }, ctx);
      } catch (err) {
        // The translation is paid for: it is returned, with why it was not
        // saved (a fixed sentence; the database's own text goes to the log).
        logger.warn(`the copy could not be saved: ${errorMessage(err)}`);
        saveError =
          visibilityRefusal(err) ??
          'The copy could not be saved where you may write. The translation is below; save it by hand or ask the owner.';
      }
    }

    return {
      ok: true,
      output: {
        translation: done.text,
        to: languageLabel(to),
        ...(from ? { from: languageLabel(from) } : {}),
        parts: done.parts,
        parts_done: done.parts,
        ...(source.id ? { source_id: source.id, source_kind: source.kind } : {}),
        worker: onSummarizer ? `${worker.slug} (summarizer, no translator worker)` : worker.slug,
        model: primaryModel,
        quality,
        ...(done.fallbackParts
          ? { fallback_model: fallbackModel, fallback_parts: done.fallbackParts }
          : {}),
        ...(saveError ? { save_error: saveError } : {}),
        ...(saved
          ? {
              saved: {
                id: saved.id,
                kind: saved.kind,
                title: saved.title,
                url: saved.url,
                placed: saved.placed,
              },
            }
          : {}),
      },
    };
  },
};

/** Why `model` cannot be a Translator model on `provider`, or null: the
 *  box policy's model rule, and on OpenRouter the live catalog (a model it
 *  does not list, or one that answers with no text). A catalog that has not
 *  loaded lets it through, as the AI workers screen does. */
export async function translatorModelIssue(
  provider: string,
  model: string,
  baseUrl: string | null,
): Promise<string | null> {
  const refused = modelPolicyRefusal(provider, model, baseUrl);
  if (refused) return refused.message;
  if (provider !== 'openrouter') return null;
  await refreshModelCatalog();
  if (catalogHasModel(model) === false) {
    return `Model '${model}' is not in OpenRouter's catalog.`;
  }
  const mods = catalogModalities(model);
  if (mods && mods.output.length && !mods.output.includes('text')) {
    return `Model '${model}' does not answer in text.`;
  }
  return null;
}

/** What translator_settings changes in the worker's params: the keys it
 *  sets (`patch`) and the keys it clears, of its own keys only. Pure. */
export function translatorParamsChange(
  was: Readonly<Record<string, unknown>>,
  next: Readonly<Record<string, unknown>>,
): { patch: Record<string, unknown>; cleared: string[] } {
  const patch: Record<string, unknown> = {};
  const cleared: string[] = [];
  for (const k of ['fallback_model', 'high_model', 'part_tokens']) {
    const v = next[k];
    if (v === undefined && k in was) cleared.push(k);
    else if (v !== undefined && v !== was[k]) patch[k] = v;
  }
  return { patch, cleared };
}

/** The Translator's model fields an Admin user sets over MCP. */
const MODEL_FIELDS = ['model', 'fallback_model', 'high_model'] as const;

/**
 * The Translator's models over MCP (the AI workers screen's fields; the
 * standing rule: every admin setting works over MCP too). With no argument
 * it reads them; each one given is checked, then set on the worker the box
 * runs for the kind. `''` clears the fallback or the high model.
 */
export const translator_settings: BuiltinToolDef = {
  slug: 'translator_settings',
  mcpOnly: true,
  policy: {
    matrix: { none: 'an AI worker is not an item' },
    effect: 'write',
    spends: 'none',
    scope: { area: 'settings', systemWhole: true },
    peerRisky: true,
    idempotent: true,
    recipe: { step: 'forbidden' },
    clientSourced: CS.always('changes which models the Translator runs'),
  },
  name: 'Read or set the Translator models',
  description:
    "Read or set the Translator worker's models (Settings, AI workers): `model` runs every translation, `fallback_model` takes a part only when `model` fails it, `high_model` runs a call that asks `quality: 'high'`. With no argument it only reads them. Each model is checked against the box policy and the provider's catalog before it is set; `''` clears the fallback or the high model. `part_tokens` asks for smaller parts (0 clears it).",
  inputSchema: {
    type: 'object',
    properties: {
      model: { type: 'string', description: "The worker's own model id." },
      fallback_model: {
        type: 'string',
        description: "The model a failed part goes to; '' for none.",
      },
      high_model: {
        type: 'string',
        description: "The model for quality 'high'; '' for none.",
      },
      part_tokens: {
        type: 'integer',
        minimum: 0,
        description:
          'Source tokens per part, below what the model holds; 0 for the model\u2019s own.',
      },
    },
  },
  handler: async (input, ctx): Promise<ToolHandlerResult> => {
    const row = await getDefaultWorker(ctx.ownerId, 'translator');
    if (!row) {
      return {
        ok: false,
        error:
          'No default translator worker on this brain (it is made on upgrade when an OpenRouter key is set): add one at Settings, AI workers.',
      };
    }
    const params = { ...((row.params ?? {}) as TranslatorParams) };
    let model = row.model;
    let changed = false;
    for (const field of MODEL_FIELDS) {
      if (input[field] === undefined) continue;
      if (typeof input[field] !== 'string') {
        return { ok: false, error: `\`${field}\` is a model id (a string).` };
      }
      const value = (input[field] as string).trim();
      if (!value) {
        if (field === 'model') return { ok: false, error: '`model` cannot be empty.' };
        delete params[field];
        changed = true;
        continue;
      }
      if (value.length > 200 || /\s/.test(value)) {
        return { ok: false, error: `\`${field}\` is one model id, with no spaces.` };
      }
      const issue = await translatorModelIssue(row.provider, value, row.baseUrl ?? null);
      if (issue) return { ok: false, error: `${field}: ${issue}` };
      if (field === 'model') model = value;
      else params[field] = value;
      changed = true;
    }
    if (input.part_tokens !== undefined) {
      const n = Number(input.part_tokens);
      if (!Number.isInteger(n) || n < 0) {
        return { ok: false, error: '`part_tokens` is a whole number, 0 or more.' };
      }
      if (n === 0) delete params.part_tokens;
      else params.part_tokens = n;
      changed = true;
    }
    if (changed) {
      // Only the keys this call names: a screen edit of another param that
      // lands meanwhile is kept (one jsonb merge, its clears removed).
      const { patch, cleared } = translatorParamsChange(
        (row.params ?? {}) as Record<string, unknown>,
        params as Record<string, unknown>,
      );
      const merged = cleared.reduce(
        (acc, k) => sql`(${acc}) - ${k}::text`,
        sql`coalesce(${aiWorkers.params}, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb`,
      );
      // The model only when this call names it: a screen change of it that
      // lands meanwhile is kept.
      const modelSet = input.model !== undefined ? { model } : {};
      const set = { ...modelSet, params: merged, updatedAt: new Date() };
      await onNarrowSpots(
        aiWorkers,
        'update',
        { ...modelSet, params, updatedAt: set.updatedAt },
        () =>
          db
            .update(aiWorkers)
            .set(set)
            .where(and(eq(aiWorkers.id, row.id), eq(aiWorkers.ownerId, ctx.ownerId))),
      );
    }
    return {
      ok: true,
      output: {
        worker: row.slug,
        provider: row.provider,
        model,
        fallback_model: params.fallback_model ?? null,
        high_model: params.high_model ?? null,
        part_tokens: params.part_tokens ?? null,
        changed,
      },
    };
  },
};

export const TRANSLATE_TOOLS: readonly BuiltinToolDef[] = [translateTool];

/** MCP only (build-server.ts): no agent is granted it. */
export const TRANSLATOR_SETTINGS_TOOLS: readonly BuiltinToolDef[] = [translator_settings];
