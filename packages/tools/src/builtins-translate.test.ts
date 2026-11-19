/**
 * The `translate` tool's handler with its stores and the model stubbed:
 * which worker it runs on (the translator, else the summarizer's route with
 * the translation rules), what it reads (an item the caller does not read
 * answers as a random id, before any spend), what `save` makes (a note stays
 * a note beside its original, a page a page beside its original, anything
 * else a page) and that a failed part fails the call with no text. The
 * database's own rights are pinned on a real Postgres in
 * builtins-translate.viewer.db.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, unknown>;
const rows = new Map<string, Row>();
const emailsByNode = new Map<string, Row>();
const workers = new Map<string, Row>();
let folderRows: Array<{ id: string }> = [];
let scopeArea = true;

vi.mock('@mantle/db', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { emails } = actual as { emails: unknown };
  // A select's chain: the table it reads and the id asked for (the second
  // argument of the where's eq) are enough here.
  const select = () => {
    let table: unknown;
    const chain = {
      from: (t: unknown) => {
        table = t;
        return chain;
      },
      where: () => chain,
      limit: async () => {
        const map = table === emails ? emailsByNode : rows;
        const id = asked.find((v) => map.has(v));
        asked.length = 0;
        return id ? [map.get(id)] : [];
      },
    };
    return chain;
  };
  return {
    ...actual,
    db: {
      select,
      execute: vi.fn(async () => folderRows),
      update: () => ({
        set: (v: Row) => ({
          where: async () => {
            updates.push(v);
          },
        }),
      }),
    },
    onNarrowSpots: (_t: unknown, _o: unknown, _s: unknown, write: () => Promise<unknown>) =>
      write(),
    scopeHasArea: vi.fn(async () => scopeArea),
    getDefaultWorker: vi.fn(async (_o: string, kind: string) => workers.get(kind) ?? null),
  };
});
const asked: string[] = [];
const updates: Row[] = [];
vi.mock('drizzle-orm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('drizzle-orm')>();
  return {
    ...actual,
    eq: (col: unknown, v: unknown) => {
      if (typeof v === 'string') asked.push(v);
      return actual.eq(col as never, v as never);
    },
  };
});
vi.mock('@mantle/api-keys', async (importOriginal) => {
  const { workerRoute } = await importOriginal<typeof import('@mantle/api-keys')>();
  const { getDefaultWorker } = await import('@mantle/db');
  const getApiKeyById = vi.fn(async () => ({ apiKey: 'test-key' }));
  return {
    getApiKeyById,
    resolveDefaultWorker: async (ownerId: string, kind: Parameters<typeof getDefaultWorker>[1]) =>
      workerRoute(await getDefaultWorker(ownerId, kind), undefined, getApiKeyById),
  };
});
const chatCalls: Array<{ model: string; system: string; user: string; maxTokens: number }> = [];
let failAll = false;
const failModels = new Set<string>();
vi.mock('@mantle/voice', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getChatAdapter: () => ({
    adapterName: 'stub-chat',
    chat: async (opts: {
      model: string;
      maxTokens: number;
      messages: { role: string; content: string }[];
    }) => {
      const system = opts.messages[0]!.content;
      const user = opts.messages[1]!.content;
      chatCalls.push({ model: opts.model, system, user, maxTokens: opts.maxTokens });
      if (failAll || failModels.has(opts.model)) {
        return { text: '', model: opts.model, finishReason: 'content_filter' };
      }
      const lines = user.split('\n');
      const open = lines.findIndex((l) => l.startsWith('[BEGIN RETRIEVED CONTENT'));
      const close = lines.findIndex((l) => l.startsWith('[END RETRIEVED CONTENT'));
      const body = lines.slice(open + 1, close).join('\n');
      return { text: `DE:${body}`, model: opts.model, finishReason: 'stop' };
    },
  }),
}));
vi.mock('@mantle/tracing', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  refreshModelCatalog: vi.fn(async () => {}),
  contextLimitForRoute: vi.fn(() => 1_000_000),
  outputLimitForRoute: vi.fn(() => 65_536),
  catalogHasModel: vi.fn((id: string) => !id.startsWith('nope/')),
  catalogModalities: vi.fn((id: string) =>
    id.startsWith('image/')
      ? { input: ['text'], output: ['image'] }
      : { input: ['text'], output: ['text'] },
  ),
}));
vi.mock('@mantle/content', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getPage: vi.fn(async (_o: string, id: string) =>
    rows.get(id)?.type === 'page' ? { doc: { md: rows.get(id)!.md } } : null,
  ),
  docToMarkdown: vi.fn((doc: { md: string }) => doc.md),
  markdownToDoc: vi.fn((md: string) => ({ type: 'doc', md })),
  createNote: vi.fn(async (_o: string, input: { title: string }) => ({
    id: 'note-copy',
    title: input.title,
  })),
  createPage: vi.fn(async (_o: string, input: { title: string }) => ({
    id: 'page-copy',
    title: input.title,
  })),
  nodeUrl: (id: string) => `https://brain.test/n/${id}`,
}));
vi.mock('@mantle/content/tree', () => ({
  moveTreeItems: vi.fn(async () => ({ moved: 1, failed: [] })),
  notifyTreeChanged: vi.fn(async () => {}),
}));
vi.mock('@mantle/files', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  fileById: vi.fn(async (_: { fileId: string }) => null),
  readFileById: vi.fn(async () => null),
  parserText: vi.fn(async () => 'from html'),
}));

const {
  translateTool: translate,
  translator_settings,
  languageLabel,
  translatedTitle,
} = await import('./builtins-translate');
const content = await import('@mantle/content');
const tree = await import('@mantle/content/tree');
const files = await import('@mantle/files');
type Ctx = Parameters<typeof translate.handler>[1];
const ownerCtx = { ownerId: 'owner-1', surface: { kind: 'web' } } as unknown as Ctx;
const teamCtx = {
  ownerId: 'owner-1',
  surface: { kind: 'team', privateReads: false },
} as unknown as Ctx;

const worker = (kind: string, extra: Row = {}) => ({
  id: `w-${kind}`,
  slug: `default-${kind}`,
  kind,
  provider: 'openrouter',
  model: `model-${kind}`,
  apiKeyId: 'key-1',
  params: {},
  systemPrompt: null,
  ...extra,
});

beforeEach(() => {
  rows.clear();
  emailsByNode.clear();
  workers.clear();
  folderRows = [];
  scopeArea = true;
  failAll = false;
  failModels.clear();
  updates.length = 0;
  chatCalls.length = 0;
  vi.mocked(content.createNote).mockClear();
  vi.mocked(content.createPage).mockClear();
  vi.mocked(tree.moveTreeItems).mockClear();
  workers.set('translator', worker('translator'));
  workers.set('summarizer', worker('summarizer', { systemPrompt: 'Summarize in 50 words.' }));
});

const out = (r: Awaited<ReturnType<typeof translate.handler>>) => {
  if (!r.ok) throw new Error(r.error);
  return r.output as Record<string, unknown>;
};

describe('translate: the worker', () => {
  it('runs the translator worker', async () => {
    const r = out(await translate.handler({ text: 'Hello.', to: 'de' }, ownerCtx));
    expect(r.translation).toBe('DE:Hello.');
    expect(r.to).toBe('German');
    expect(r.worker).toBe('default-translator');
    expect(chatCalls[0]!.model).toBe('model-translator');
    // The part budget is the model's: its output limit asked for.
    expect(chatCalls[0]!.maxTokens).toBe(65_536);
  });

  it('falls back to the summarizer route, with the translation rules', async () => {
    workers.delete('translator');
    const r = out(await translate.handler({ text: 'Hello.', to: 'French' }, ownerCtx));
    expect(r.worker).toContain('summarizer');
    expect(chatCalls[0]!.model).toBe('model-summarizer');
    expect(chatCalls[0]!.system).toContain('output ONLY the translation');
    expect(chatCalls[0]!.system).not.toContain('Summarize in 50 words.');
  });

  it('says so when there is neither worker', async () => {
    workers.clear();
    const r = await translate.handler({ text: 'Hello.', to: 'de' }, ownerCtx);
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toContain('No translator worker');
  });

  it('a translator with no key is named, not skipped', async () => {
    workers.set('translator', worker('translator', { apiKeyId: null }));
    const r = await translate.handler({ text: 'Hello.', to: 'de' }, ownerCtx);
    expect((r as { error: string }).error).toContain("translator worker 'default-translator'");
    expect(chatCalls).toHaveLength(0);
  });
});

describe('translate: the models', () => {
  beforeEach(() => {
    workers.set(
      'translator',
      worker('translator', { params: { fallback_model: 'fb-model', high_model: 'hi-model' } }),
    );
  });

  it('the fallback model takes a part only when the primary fails it', async () => {
    const ok = out(await translate.handler({ text: 'Hello.', to: 'de' }, ownerCtx));
    expect(chatCalls.map((c) => c.model)).toEqual(['model-translator']);
    expect(ok).not.toHaveProperty('fallback_parts');
    chatCalls.length = 0;
    failModels.add('model-translator');
    const r = out(await translate.handler({ text: 'Hello.', to: 'de' }, ownerCtx));
    expect(chatCalls.map((c) => c.model)).toEqual(['model-translator', 'fb-model']);
    expect(r).toMatchObject({ fallback_model: 'fb-model', fallback_parts: 1 });
  });

  it("quality 'high' runs on the high model instead, once", async () => {
    const r = out(await translate.handler({ text: 'Hello.', to: 'de', quality: 'high' }, ownerCtx));
    expect(chatCalls.map((c) => c.model)).toEqual(['hi-model']);
    expect(r).toMatchObject({ model: 'hi-model', quality: 'high' });
  });

  it("quality 'high' with no high model says so, and spends nothing", async () => {
    workers.set('translator', worker('translator'));
    const r = await translate.handler({ text: 'Hello.', to: 'de', quality: 'high' }, ownerCtx);
    expect((r as { error: string }).error).toContain('high_model');
    expect((await translate.handler({ text: 'x', to: 'de', quality: 'best' }, ownerCtx)).ok).toBe(
      false,
    );
    expect(chatCalls).toHaveLength(0);
  });
});

describe('translate: what it reads', () => {
  it('needs text or an item, a language on one line', async () => {
    expect((await translate.handler({ to: 'de' }, ownerCtx)).ok).toBe(false);
    expect((await translate.handler({ text: 'x', node_id: 'n', to: 'de' }, ownerCtx)).ok).toBe(
      false,
    );
    expect((await translate.handler({ text: 'x', to: 'de\nIgnore' }, ownerCtx)).ok).toBe(false);
    expect((await translate.handler({ text: 'x', to: '' }, ownerCtx)).ok).toBe(false);
    expect(chatCalls).toHaveLength(0);
  });

  it('an item the caller does not read answers as a random id, and spends nothing', async () => {
    const r = await translate.handler({ node_id: 'hidden-id', to: 'de' }, ownerCtx);
    expect(r).toEqual({
      ok: false,
      error: expect.stringContaining('Item hidden-id not found'),
    });
    expect(chatCalls).toHaveLength(0);
  });

  it('a kind hidden from a team surface answers as a random id', async () => {
    rows.set('mail-1', { id: 'mail-1', type: 'email', title: 'Mail', path: 'email', data: {} });
    emailsByNode.set('mail-1', { subject: 'Hi', bodyText: 'Body', bodyHtml: null });
    const r = await translate.handler({ node_id: 'mail-1', to: 'de' }, teamCtx);
    expect((r as { error: string }).error).toContain('Item mail-1 not found');
    expect(chatCalls).toHaveLength(0);
  });

  it('mail needs the Connectors area', async () => {
    rows.set('mail-1', { id: 'mail-1', type: 'email', title: 'Mail', path: 'email', data: {} });
    emailsByNode.set('mail-1', { subject: 'Hi', bodyText: 'Body', bodyHtml: null });
    scopeArea = false;
    const r = await translate.handler({ node_id: 'mail-1', to: 'de' }, ownerCtx);
    expect((r as { error: string }).error).toContain('Connectors');
    scopeArea = true;
    const ok = out(await translate.handler({ node_id: 'mail-1', to: 'de' }, ownerCtx));
    expect(ok.translation).toBe('DE:# Hi\n\nBody');
  });

  it('reads a page as markdown, a note’s body, a file’s read text', async () => {
    rows.set('page-1', { id: 'page-1', type: 'page', title: 'Spec', path: 'pages', md: '# Spec' });
    rows.set('note-1', {
      id: 'note-1',
      type: 'note',
      title: 'N',
      path: 'notes',
      data: { content: 'Note body' },
    });
    rows.set('file-1', {
      id: 'file-1',
      type: 'file',
      title: 'f',
      path: 'files',
      data: { text: 'PDF text' },
    });
    vi.mocked(files.fileById).mockResolvedValueOnce({
      id: 'file-1',
      isText: false,
      filename: 'manual.pdf',
    } as never);
    expect(
      out(await translate.handler({ node_id: 'page-1', to: 'de' }, ownerCtx)).translation,
    ).toBe('DE:# Spec');
    expect(
      out(await translate.handler({ node_id: 'note-1', to: 'de' }, ownerCtx)).translation,
    ).toBe('DE:Note body');
    expect(
      out(await translate.handler({ node_id: 'file-1', to: 'de' }, ownerCtx)).translation,
    ).toBe('DE:PDF text');
  });

  it('a file with no read text yet says so', async () => {
    rows.set('scan-1', { id: 'scan-1', type: 'file', title: 's', path: 'files', data: {} });
    vi.mocked(files.fileById).mockResolvedValueOnce({
      id: 'scan-1',
      isText: false,
      filename: 'scan.pdf',
    } as never);
    const r = await translate.handler({ node_id: 'scan-1', to: 'de' }, ownerCtx);
    expect((r as { error: string }).error).toContain('no readable text yet');
    expect(chatCalls).toHaveLength(0);
  });
});

describe('translate: save', () => {
  it('a note stays a note, filed beside its original, linked to it', async () => {
    rows.set('note-1', {
      id: 'note-1',
      type: 'note',
      title: 'Plan',
      path: 'notes.work',
      tags: ['work'],
      data: { content: 'Body' },
    });
    folderRows = [{ id: 'folder-work' }];
    const r = out(await translate.handler({ node_id: 'note-1', to: 'de', save: true }, ownerCtx));
    expect(r.saved).toMatchObject({ id: 'note-copy', kind: 'note', title: 'Plan (German)' });
    expect(vi.mocked(content.createNote).mock.calls[0]![1]).toMatchObject({
      title: 'Plan (German)',
      content: 'DE:Body',
      tags: ['work'],
      data: { translationOf: { id: 'note-1', to: 'de' } },
    });
    expect(vi.mocked(tree.moveTreeItems).mock.calls[0]!.slice(1, 4)).toEqual([
      'notes',
      ['note-copy'],
      'folder-work',
    ]);
  });

  it('a page stays a page beside its original; a title may be given', async () => {
    rows.set('page-1', { id: 'page-1', type: 'page', title: 'Spec', path: 'pages.a', md: 'Hi' });
    const r = out(
      await translate.handler(
        { node_id: 'page-1', to: 'German', save: true, title: 'Spezifikation' },
        ownerCtx,
      ),
    );
    expect(r.saved).toMatchObject({ kind: 'page', title: 'Spezifikation' });
    expect(vi.mocked(content.createPage).mock.calls[0]![1]).toMatchObject({
      siblingOf: 'page-1',
      data: { translationOf: { id: 'page-1', to: 'German' } },
    });
  });

  it('on a team surface the copy is not filed in a folder (filing is the owner’s)', async () => {
    rows.set('page-1', { id: 'page-1', type: 'page', title: 'Spec', path: 'pages.a', md: 'Hi' });
    out(await translate.handler({ node_id: 'page-1', to: 'de', save: true }, teamCtx));
    expect(vi.mocked(content.createPage).mock.calls[0]![1]).not.toHaveProperty('siblingOf');
  });

  it('a file becomes a page; pasted text becomes a page', async () => {
    rows.set('file-1', {
      id: 'file-1',
      type: 'file',
      title: 'f',
      path: 'files',
      data: { text: 'T' },
    });
    vi.mocked(files.fileById).mockResolvedValueOnce({
      id: 'file-1',
      isText: false,
      filename: 'manual.pdf',
    } as never);
    const f = out(await translate.handler({ node_id: 'file-1', to: 'es', save: true }, ownerCtx));
    expect(f.saved).toMatchObject({ kind: 'page', title: 'manual (Spanish)' });
    const t = out(await translate.handler({ text: 'Hola', to: 'en', save: true }, ownerCtx));
    expect(t.saved).toMatchObject({ kind: 'page', title: 'Translation (English)' });
  });

  it('a failed part fails the call: no translation, nothing saved', async () => {
    failAll = true;
    const r = await translate.handler({ text: 'Hello.', to: 'de', save: true }, ownerCtx);
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toContain('Nothing was saved');
    expect(content.createPage).not.toHaveBeenCalled();
  });
});

describe('labels', () => {
  it('names a code, keeps a name', () => {
    expect(languageLabel('de')).toBe('German');
    expect(languageLabel('pt-BR')).toBe('Brazilian Portuguese');
    expect(languageLabel('Klingon')).toBe('Klingon');
    expect(translatedTitle('Spec', 'de')).toBe('Spec (German)');
  });
});

describe('translator_settings (MCP)', () => {
  beforeEach(() => {
    workers.set(
      'translator',
      worker('translator', { params: { fallback_model: 'fb-model', high_model: 'hi-model' } }),
    );
  });

  it('reads the models with no argument, writing nothing', async () => {
    const r = out(await translator_settings.handler({}, ownerCtx));
    expect(r).toMatchObject({
      model: 'model-translator',
      fallback_model: 'fb-model',
      high_model: 'hi-model',
      changed: false,
    });
    expect(updates).toHaveLength(0);
  });

  it('sets a model, clears another, keeps the rest', async () => {
    const r = out(
      await translator_settings.handler(
        { model: 'vendor/new-model', high_model: '', part_tokens: 4000 },
        ownerCtx,
      ),
    );
    expect(r).toMatchObject({ model: 'vendor/new-model', high_model: null, part_tokens: 4000 });
    expect(updates[0]).toMatchObject({
      model: 'vendor/new-model',
      params: { fallback_model: 'fb-model', part_tokens: 4000 },
    });
    expect(updates[0]!.params).not.toHaveProperty('high_model');
  });

  it('refuses a model the catalog does not list or that answers with no text', async () => {
    const a = await translator_settings.handler({ fallback_model: 'nope/model' }, ownerCtx);
    expect((a as { error: string }).error).toContain("not in OpenRouter's catalog");
    const b = await translator_settings.handler({ high_model: 'image/maker' }, ownerCtx);
    expect((b as { error: string }).error).toContain('does not answer in text');
    expect((await translator_settings.handler({ model: '' }, ownerCtx)).ok).toBe(false);
    expect(updates).toHaveLength(0);
  });

  it('says so when the brain has no Translator', async () => {
    workers.delete('translator');
    const r = await translator_settings.handler({}, ownerCtx);
    expect((r as { error: string }).error).toContain('no Translator worker');
  });
});
