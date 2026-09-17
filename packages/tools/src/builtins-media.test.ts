/**
 * Behavioural tests for the MEDIA tools: generate_image, synthesize_speech,
 * video_ingest and show_image.
 *
 * Three of these spend the owner's provider credit and two of them write
 * files into the brain, so what is worth pinning is where each one stops
 * before paying or storing, and who the stored thing belongs to:
 *
 *  - a missing or half-configured worker comes back as a tool error that
 *    points at /settings/ai-workers, without the adapter ever being called;
 *    an adapter throw comes back as a tool error, never a throw.
 *  - generate_image refuses an edit on a model that cannot edit BEFORE
 *    generating (a fresh generation is a different picture, and bills), reads
 *    reference images under ctx.ownerId, stores the result under the caller
 *    in the dated folder, and never lets an option LOOK applied when the
 *    adapter did not send it (a per-call aspect_ratio beats a saved size).
 *  - synthesize_speech refuses with no delivery surface, picks the container
 *    per surface (opus for Telegram, mp3 for the web) and reports saved
 *    settings the adapter ignored.
 *  - video_ingest refuses the team surfaces and a disabled sidecar first, runs
 *    the REAL egress guard on the url so a private address never reaches the
 *    sidecar, resolves the STT worker BEFORE downloading audio, downloads
 *    nothing on the captions path, and saves the clip BEFORE transcribing so a
 *    failed STT still leaves a retryable artifact. Every file and page it
 *    creates carries ctx.ownerId.
 *  - show_image only re-serves bytes the owner already has: metadata gates
 *    (mime, size) run before the bytes are read, and the reply carries
 *    metadata plus an artifact, never the base64 in the model-visible output.
 *
 * The db, file store, telegram, tracing ingest and provider adapters are
 * stubbed; the tools' own branching, the egress guard and the caption
 * pipeline are real.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const selectQueue: unknown[][] = [];
  /** Where clauses handed to the folder-existence selects, in call order. A
   *  `mockReturnThis()` where accepts any clause, so the owner-id term that
   *  keeps one brain's folders out of another's is read out of these. */
  const selectWheres: unknown[] = [];
  const limit = vi.fn(async () => selectQueue.shift() ?? []);
  const selectChain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn(function (this: unknown, clause: unknown) {
      selectWheres.push(clause);
      return this;
    }),
    limit,
  };
  const updateWhere = vi.fn(async () => undefined);
  const updateSet = vi.fn(() => ({ where: updateWhere }));
  return {
    selectQueue,
    selectWheres,
    select: vi.fn(() => selectChain),
    update: vi.fn(() => ({ set: updateSet })),
  };
});

vi.mock('@mantle/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/db')>();
  return {
    ...actual,
    db: { ...actual.db, select: h.select, update: h.update },
    getDefaultWorker: vi.fn(),
    bumpWorkerUsage: vi.fn(),
  };
});
vi.mock('@mantle/api-keys', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/api-keys')>();
  return { ...actual, getApiKeyById: vi.fn() };
});
vi.mock('@mantle/telegram', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/telegram')>();
  return { ...actual, accountForChat: vi.fn(), sendPhoto: vi.fn(), sendVoice: vi.fn() };
});
vi.mock('@mantle/voice', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/voice')>();
  return {
    ...actual,
    getTtsAdapter: vi.fn(),
    getImageGenAdapter: vi.fn(),
    getSttAdapter: vi.fn(),
  };
});
vi.mock('@mantle/files', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/files')>();
  return {
    ...actual,
    createFolder: vi.fn(),
    fileById: vi.fn(),
    readFileById: vi.fn(),
    upsertFile: vi.fn(),
    mediaSidecarEnabled: vi.fn(),
    mediaProbe: vi.fn(),
    mediaCaptions: vi.fn(),
    mediaAudio: vi.fn(),
    mediaExtractAudio: vi.fn(),
    mediaVideo: vi.fn(),
  };
});
vi.mock('@mantle/content', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/content')>();
  return { ...actual, createPage: vi.fn() };
});
vi.mock('@mantle/tracing', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/tracing')>();
  return { ...actual, recordIngest: vi.fn() };
});

import { bumpWorkerUsage, getDefaultWorker } from '@mantle/db';
import { getApiKeyById } from '@mantle/api-keys';
import { accountForChat, sendPhoto, sendVoice } from '@mantle/telegram';
import { getImageGenAdapter, getSttAdapter, getTtsAdapter } from '@mantle/voice';
import {
  createFolder,
  dashToLtree,
  fileById,
  mediaAudio,
  mediaCaptions,
  mediaExtractAudio,
  mediaProbe,
  mediaSidecarEnabled,
  readFileById,
  upsertFile,
} from '@mantle/files';
import { createPage } from '@mantle/content';
import { recordIngest } from '@mantle/tracing';
import { paramsOf } from './test-support';
import { WORKER_DELEGATION_TOOLS } from './builtins-workers';
import { VIDEO_TOOLS } from './builtins-video';
import { IMAGE_TOOLS } from './builtins-images';
import type { BuiltinToolDef, ToolHandlerContext } from './types';

const generateImage = WORKER_DELEGATION_TOOLS.find((t) => t.slug === 'generate_image')!;
const synthesizeSpeech = WORKER_DELEGATION_TOOLS.find((t) => t.slug === 'synthesize_speech')!;
const videoIngest = VIDEO_TOOLS.find((t) => t.slug === 'video_ingest')!;
const showImage = IMAGE_TOOLS.find((t) => t.slug === 'show_image')!;

const ctx: ToolHandlerContext = { ownerId: 'o1' };
const WEB_CTX: ToolHandlerContext = { ownerId: 'o1', surface: { kind: 'web' } };
const TG_CTX: ToolHandlerContext = {
  ownerId: 'o1',
  surface: { kind: 'telegram', telegramChatId: '42', replyToTelegramMessageId: '7' },
};
const TEAM_CTX: ToolHandlerContext = { ownerId: 'o1', surface: { kind: 'team', contactId: 'c1' } };

/** A ctx carrying a step handle, for the tools that surface non-fatal
 *  failures on the trace rather than in the result. */
function withStep() {
  const step = { setMeta: vi.fn(), setOutput: vi.fn() };
  const c: ToolHandlerContext = {
    ...WEB_CTX,
    step: step as unknown as ToolHandlerContext['step'],
  };
  return { step, ctx: c };
}

type Result = Awaited<ReturnType<BuiltinToolDef['handler']>>;

function errorOf(res: Result): string {
  if (res.ok) throw new Error(`expected a failure, got ok with ${JSON.stringify(res.output)}`);
  return res.error;
}

function outputOf(res: Result): Record<string, unknown> {
  if (!res.ok) throw new Error(`expected success, got error: ${res.error}`);
  return res.output as Record<string, unknown>;
}

function artifactsOf(res: Result) {
  if (!res.ok) throw new Error(`expected success, got error: ${res.error}`);
  return res.artifacts ?? [];
}

const IMG_WORKER = {
  id: 'w-img',
  slug: 'imagen',
  provider: 'openai',
  model: 'gpt-image-1',
  apiKeyId: 'k1',
  params: {},
};
const TTS_WORKER = {
  id: 'w-tts',
  slug: 'voice',
  provider: 'openai',
  model: 'gpt-4o-mini-tts',
  apiKeyId: 'k2',
  params: { voice: 'coral', speed: 1.2 },
};
const STT_WORKER = {
  id: 'w-stt',
  slug: 'ears',
  provider: 'openai',
  model: 'whisper-1',
  apiKeyId: 'k3',
  params: {},
};

const PNG = Buffer.from('png-bytes');
const MP3 = Buffer.from('mp3-bytes');

const imageAdapter = {
  providerId: 'openai',
  adapterName: 'openai-images',
  supports: ['size', 'quality'] as string[],
  generate: vi.fn(),
  staticCatalog: () => [],
};
const ttsAdapter = {
  providerId: 'openai',
  adapterName: 'openai-tts',
  supports: ['speed', 'format', 'instructions'] as string[],
  synthesize: vi.fn(),
};
const sttAdapter = {
  providerId: 'openai',
  adapterName: 'openai-stt',
  supports: ['language'] as string[],
  transcribe: vi.fn(),
};

const PUBLIC_VIDEO = 'http://93.184.216.34/watch?v=abc';
const PROBE = {
  title: 'Setting the APN',
  durationSeconds: 120,
  channel: 'Ops',
  uploadDate: null,
  extractor: 'youtube',
  isLive: false,
  captions: { manual: ['en'], auto: [] as string[] },
  filesizeApprox: null,
};
const VTT = `WEBVTT

00:00:01.000 --> 00:00:04.000
First we open the settings menu on the phone.

00:00:04.000 --> 00:00:08.000
Then we set the access point name to internet and save it.

00:00:08.000 --> 00:00:12.000
Finally we restart the device so the new profile loads.
`;

beforeEach(() => {
  vi.clearAllMocks();
  h.selectQueue.length = 0;
  h.selectWheres.length = 0;
  vi.mocked(getDefaultWorker).mockImplementation(
    async (_o, kind) =>
      (kind === 'image_gen'
        ? IMG_WORKER
        : kind === 'tts'
          ? TTS_WORKER
          : kind === 'stt'
            ? STT_WORKER
            : null) as never,
  );
  vi.mocked(getApiKeyById).mockResolvedValue('sk-test');
  vi.mocked(getImageGenAdapter).mockReturnValue(imageAdapter as never);
  vi.mocked(getTtsAdapter).mockReturnValue(ttsAdapter as never);
  vi.mocked(getSttAdapter).mockReturnValue(sttAdapter as never);
  imageAdapter.supports = ['size', 'quality'];
  imageAdapter.generate.mockResolvedValue({
    bytes: PNG,
    mimeType: 'image/png',
    model: 'gpt-image-1',
  });
  ttsAdapter.supports = ['speed', 'format', 'instructions'];
  ttsAdapter.synthesize.mockResolvedValue({
    bytes: MP3,
    mimeType: 'audio/mpeg',
    voice: 'coral',
    model: 'gpt-4o-mini-tts',
  });
  sttAdapter.transcribe.mockResolvedValue({
    text: 'hello from the transcript',
    language: 'en',
    durationSeconds: 100,
    model: 'whisper-1',
  });
  vi.mocked(createFolder).mockResolvedValue({} as never);
  vi.mocked(upsertFile).mockResolvedValue({ id: 'n1' } as never);
  vi.mocked(fileById).mockResolvedValue(null);
  vi.mocked(readFileById).mockResolvedValue(null);
  vi.mocked(accountForChat).mockResolvedValue({ id: 'acc' } as never);
  vi.mocked(sendPhoto).mockResolvedValue(777);
  vi.mocked(sendVoice).mockResolvedValue(99);
  vi.mocked(mediaSidecarEnabled).mockReturnValue(true);
  vi.mocked(mediaProbe).mockResolvedValue({ ok: true, value: PROBE });
  vi.mocked(mediaCaptions).mockResolvedValue({
    ok: true,
    value: { source: 'manual', lang: 'en', content: VTT },
  });
  vi.mocked(mediaAudio).mockResolvedValue({
    ok: true,
    value: { bytes: MP3, durationSeconds: 100, title: null },
  });
  vi.mocked(mediaExtractAudio).mockResolvedValue({
    ok: true,
    value: { bytes: MP3, durationSeconds: 50, title: null },
  });
  vi.mocked(createPage).mockResolvedValue({ id: 'page-1' } as never);
});

/* ───────────────────────────── generate_image ──────────────────────────── */

describe('generate_image', () => {
  it('refuses a blank prompt before resolving a worker', async () => {
    expect(errorOf(await generateImage.handler({ prompt: '  ' }, ctx))).toBe('prompt required');
    expect(getDefaultWorker).not.toHaveBeenCalled();
  });

  it.each([
    ['no default worker', null, /No default image_gen worker/],
    ['a worker with no key attached', { ...IMG_WORKER, apiKeyId: null }, /no api_key attached/],
  ])('reports %s as a settings error without calling the adapter', async (_l, worker, re) => {
    vi.mocked(getDefaultWorker).mockResolvedValue(worker as never);
    const err = errorOf(await generateImage.handler({ prompt: 'A red fox' }, ctx));
    expect(err).toMatch(re);
    expect(err).toMatch(/\/settings\/ai-workers/);
    expect(imageAdapter.generate).not.toHaveBeenCalled();
  });

  it('reports an undecryptable key and an unwired provider by name', async () => {
    vi.mocked(getApiKeyById).mockResolvedValue(null);
    expect(errorOf(await generateImage.handler({ prompt: 'A red fox' }, ctx))).toMatch(
      /could not be decrypted/,
    );
    vi.mocked(getApiKeyById).mockResolvedValue('sk-test');
    vi.mocked(getImageGenAdapter).mockReturnValue(null);
    expect(errorOf(await generateImage.handler({ prompt: 'A red fox' }, ctx))).toMatch(
      /No image-gen adapter wired for 'openai'/,
    );
    expect(imageAdapter.generate).not.toHaveBeenCalled();
  });

  it('reports a provider failure as a tool error and writes no file', async () => {
    imageAdapter.generate.mockRejectedValue(new Error('402 insufficient credits'));
    expect(errorOf(await generateImage.handler({ prompt: 'A red fox' }, ctx))).toBe(
      '402 insufficient credits',
    );
    expect(upsertFile).not.toHaveBeenCalled();
  });

  it('refuses an edit on an adapter that cannot take reference images BEFORE generating', async () => {
    const res = await generateImage.handler(
      { prompt: 'make the sky orange', input_image_ids: ['f1'] },
      ctx,
    );
    expect(errorOf(res)).toMatch(/cannot edit an existing image, so nothing was generated/);
    expect(fileById).not.toHaveBeenCalled();
    expect(imageAdapter.generate).not.toHaveBeenCalled();
  });

  it('reads reference images under the caller and refuses a missing or non-image file', async () => {
    imageAdapter.supports = ['size', 'inputImages'];
    expect(
      errorOf(await generateImage.handler({ prompt: 'p', input_image_ids: ['f1'] }, ctx)),
    ).toMatch(/file f1 not found/);
    expect(fileById).toHaveBeenCalledWith({ ownerId: 'o1', fileId: 'f1' });

    vi.mocked(fileById).mockResolvedValue({
      mimeType: 'application/pdf',
      filename: 'x.pdf',
    } as never);
    expect(
      errorOf(await generateImage.handler({ prompt: 'p', input_image_ids: ['f1'] }, ctx)),
    ).toMatch(/is application\/pdf, not an image/);
    expect(readFileById).not.toHaveBeenCalled();
    expect(imageAdapter.generate).not.toHaveBeenCalled();
  });

  it('hands reference bytes to the adapter', async () => {
    imageAdapter.supports = ['size', 'inputImages'];
    vi.mocked(fileById).mockResolvedValue({ mimeType: 'image/png', filename: 'a.png' } as never);
    vi.mocked(readFileById).mockResolvedValue({ bytes: PNG } as never);
    await generateImage.handler({ prompt: 'p', input_image_ids: ['f1'] }, ctx);
    expect(readFileById).toHaveBeenCalledWith({ ownerId: 'o1', fileId: 'f1' });
    expect(imageAdapter.generate).toHaveBeenCalledWith(
      expect.objectContaining({
        inputImages: [{ bytes: PNG, mimeType: 'image/png', filename: 'a.png' }],
      }),
    );
  });

  it('scopes the folder-existence lookups to the caller', async () => {
    // ensureBranch decides whether to create the folder. Drop
    // `eq(nodes.ownerId, ...)` and another owner's identically-pathed folder
    // satisfies the check, so the create is skipped and the image is written
    // against a path this brain does not own.
    h.selectQueue.push([], []);
    await generateImage.handler({ prompt: 'A red fox' }, WEB_CTX);
    expect(h.selectWheres.length).toBeGreaterThan(0);
    for (const clause of h.selectWheres) expect(paramsOf(clause)).toContain('o1');
  });

  it('stores the image under the caller in the dated folder and hands back the inline ref', async () => {
    h.selectQueue.push([], []); // neither the top folder nor today's exists yet
    const res = await generateImage.handler({ prompt: 'A red fox' }, WEB_CTX);

    expect(imageAdapter.generate).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: 'sk-test', prompt: 'A red fox', model: 'gpt-image-1' }),
    );
    const today = new Date().toISOString().slice(0, 10);
    expect(createFolder).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ ownerId: 'o1', parentPath: 'files', slug: 'generated-images' }),
    );
    expect(createFolder).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ ownerId: 'o1', slug: today }),
    );
    const parentPath = `files.generated_images.${dashToLtree(today)}`;
    expect(upsertFile).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerId: 'o1',
        parentPath,
        filename: expect.stringMatching(/^\d+-a-red-fox\.png$/),
        bytes: PNG,
        overwrite: false,
        title: 'A red fox',
        data: expect.objectContaining({ generated_by: 'generate_image', prompt: 'A red fox' }),
      }),
    );
    expect(outputOf(res)).toMatchObject({
      nodeId: 'n1',
      storagePath: expect.stringMatching(new RegExp(`^${parentPath}/\\d+-a-red-fox\\.png$`)),
      inlineRef: '![A red fox](media:n1)',
      model: 'gpt-image-1',
      adapter: 'openai-images',
      mimeType: 'image/png',
      bytes: PNG.length,
      deliveredVia: 'web',
    });
    expect(artifactsOf(res)).toEqual([
      expect.objectContaining({
        kind: 'image',
        nodeId: 'n1',
        mimeType: 'image/png',
        base64: PNG.toString('base64'),
        producedBy: 'generate_image',
      }),
    ]);
  });

  it('a per-call aspect_ratio beats the saved size default, which is reported as ignored', async () => {
    // The first real test of this tool: the request said 16:9, the trace
    // claimed 16:9 applied, and the file came back square because the
    // worker's saved 1024x1024 outranked it.
    imageAdapter.supports = ['size', 'aspectRatio'];
    vi.mocked(getDefaultWorker).mockResolvedValue({
      ...IMG_WORKER,
      params: { size: '1024x1024' },
    } as never);
    const out = outputOf(await generateImage.handler({ prompt: 'p', aspect_ratio: '16:9' }, ctx));
    expect(imageAdapter.generate).toHaveBeenCalledWith(
      expect.objectContaining({ aspectRatio: '16:9', size: undefined }),
    );
    expect(out.appliedParams).toEqual({ aspect_ratio: '16:9' });
    expect((out.ignoredParams as Record<string, string>).size).toMatch(
      /1024x1024 \(superseded by the aspect_ratio you asked for/,
    );
  });

  it('never lets an option the adapter did not send look applied', async () => {
    imageAdapter.supports = ['size', 'quality'];
    imageAdapter.generate.mockResolvedValue({
      bytes: PNG,
      mimeType: 'image/png',
      model: 'gpt-image-1',
      warnings: [{ param: 'quality', reason: 'gpt-image-1 has no quality knob' }],
    });
    const out = outputOf(
      await generateImage.handler({ prompt: 'p', style: 'vivid', quality: 'hd' }, ctx),
    );
    // style: not in supports, never sent. quality: sent, then disowned by
    // the adapter for this model. Neither may appear as applied.
    expect(imageAdapter.generate).toHaveBeenCalledWith(
      expect.objectContaining({ style: undefined, quality: 'hd' }),
    );
    expect(out).not.toHaveProperty('appliedParams');
    expect(out.ignoredParams).toEqual({
      style: 'vivid',
      quality: 'hd (gpt-image-1 has no quality knob)',
    });
    expect(out.ignoredParamsNote).toMatch(/does not accept style, quality/);
  });

  it('keeps the image when the file save fails, and says so on the trace', async () => {
    vi.mocked(upsertFile).mockRejectedValue(new Error('disk full'));
    const { step, ctx: c } = withStep();
    const out = outputOf(await generateImage.handler({ prompt: 'p' }, c));
    expect(out).toMatchObject({ nodeId: null, storagePath: null });
    expect(out).not.toHaveProperty('inlineRef');
    expect(step.setMeta).toHaveBeenCalledWith({ file_save_error: 'disk full' });
  });

  it('delivers on Telegram via sendPhoto and reports the message id', async () => {
    const out = outputOf(await generateImage.handler({ prompt: 'A red fox' }, TG_CTX));
    expect(accountForChat).toHaveBeenCalledWith('42');
    expect(sendPhoto).toHaveBeenCalledWith({ id: 'acc' }, '42', PNG, {
      replyTo: '7',
      caption: '🎨 A red fox',
    });
    expect(out).toMatchObject({ telegramMessageId: 777, deliveredVia: 'telegram' });
    expect(out.note).toBeUndefined();
  });
});

/* ──────────────────────────── synthesize_speech ────────────────────────── */

describe('synthesize_speech', () => {
  it('refuses blank text, then a missing surface, before resolving a worker', async () => {
    expect(errorOf(await synthesizeSpeech.handler({ text: ' ' }, WEB_CTX))).toBe('text required');
    expect(errorOf(await synthesizeSpeech.handler({ text: 'hi' }, ctx))).toMatch(
      /needs a delivery surface/,
    );
    expect(getDefaultWorker).not.toHaveBeenCalled();
  });

  it('reports a missing worker or unwired provider without synthesising', async () => {
    vi.mocked(getDefaultWorker).mockResolvedValue(null);
    expect(errorOf(await synthesizeSpeech.handler({ text: 'hi' }, WEB_CTX))).toMatch(
      /No default tts worker/,
    );
    vi.mocked(getDefaultWorker).mockResolvedValue(TTS_WORKER as never);
    vi.mocked(getTtsAdapter).mockReturnValue(null);
    expect(errorOf(await synthesizeSpeech.handler({ text: 'hi' }, WEB_CTX))).toMatch(
      /No TTS adapter wired for provider 'openai'/,
    );
    expect(ttsAdapter.synthesize).not.toHaveBeenCalled();
  });

  it('reports a provider failure as a tool error, not a throw', async () => {
    ttsAdapter.synthesize.mockRejectedValue(new Error('401 bad key'));
    expect(errorOf(await synthesizeSpeech.handler({ text: 'hi' }, WEB_CTX))).toBe('401 bad key');
    expect(sendVoice).not.toHaveBeenCalled();
  });

  it('on the web: mp3, the worker voice, and the audio as an artifact', async () => {
    const res = await synthesizeSpeech.handler({ text: 'Read this aloud' }, WEB_CTX);
    expect(ttsAdapter.synthesize).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: 'sk-test',
        text: 'Read this aloud',
        voice: 'coral',
        model: 'gpt-4o-mini-tts',
        speed: 1.2,
        format: 'mp3',
      }),
    );
    expect(outputOf(res)).toEqual({
      sent: true,
      deliveredVia: 'web',
      voice: 'coral',
      model: 'gpt-4o-mini-tts',
      bytes: MP3.length,
    });
    expect(artifactsOf(res)).toEqual([
      {
        kind: 'audio',
        mimeType: 'audio/mpeg',
        base64: MP3.toString('base64'),
        caption: 'Read this aloud',
        producedBy: 'synthesize_speech',
      },
    ]);
    expect(sendVoice).not.toHaveBeenCalled();
  });

  it('voice precedence: the call, then the worker, then nova', async () => {
    await synthesizeSpeech.handler({ text: 'hi', voice: 'ash' }, WEB_CTX);
    expect(ttsAdapter.synthesize).toHaveBeenLastCalledWith(
      expect.objectContaining({ voice: 'ash' }),
    );
    vi.mocked(getDefaultWorker).mockResolvedValue({ ...TTS_WORKER, params: null } as never);
    const out = outputOf(await synthesizeSpeech.handler({ text: 'hi' }, WEB_CTX));
    expect(out.voice).toBe('nova');
  });

  it('on Telegram: opus, sendVoice threaded under the inbound message, no artifact', async () => {
    const res = await synthesizeSpeech.handler({ text: 'hi' }, TG_CTX);
    expect(ttsAdapter.synthesize).toHaveBeenCalledWith(expect.objectContaining({ format: 'opus' }));
    expect(accountForChat).toHaveBeenCalledWith('42');
    expect(sendVoice).toHaveBeenCalledWith({ id: 'acc' }, '42', MP3, { replyTo: '7' });
    expect(outputOf(res)).toMatchObject({
      sent: true,
      deliveredVia: 'telegram',
      telegramMessageId: 99,
    });
    expect(artifactsOf(res)).toEqual([]);
  });

  it('on Telegram: a missing account or a failed send is a tool error', async () => {
    vi.mocked(accountForChat).mockResolvedValue(null);
    expect(errorOf(await synthesizeSpeech.handler({ text: 'hi' }, TG_CTX))).toMatch(
      /No Telegram account configured for chat 42/,
    );
    vi.mocked(accountForChat).mockResolvedValue({ id: 'acc' } as never);
    vi.mocked(sendVoice).mockRejectedValue(new Error('403 bot blocked'));
    expect(errorOf(await synthesizeSpeech.handler({ text: 'hi' }, TG_CTX))).toBe('403 bot blocked');
  });

  it('reports saved settings the adapter does not forward, so silence is never misread', async () => {
    ttsAdapter.supports = ['format'];
    ttsAdapter.synthesize.mockResolvedValue({
      bytes: MP3,
      mimeType: 'audio/mpeg',
      voice: 'coral',
      model: 'gpt-4o-mini-tts',
      warnings: [{ param: 'format', reason: 'always mp3 on this model' }],
    });
    const out = outputOf(await synthesizeSpeech.handler({ text: 'hi' }, WEB_CTX));
    expect(out.ignoredParams).toEqual({
      speed: '1.2',
      format: 'mp3 (always mp3 on this model)',
    });
    expect(out.ignoredParamsNote).toMatch(/did not apply speed, format/);
  });
});

/* ────────────────────────────── video_ingest ───────────────────────────── */

describe('video_ingest', () => {
  it('refuses the team surface before even checking the sidecar', async () => {
    expect(errorOf(await videoIngest.handler({ url: PUBLIC_VIDEO }, TEAM_CTX))).toMatch(
      /owner-side tool/,
    );
    expect(mediaSidecarEnabled).not.toHaveBeenCalled();
  });

  it('reports a disabled sidecar and a bad url/file_node_id combination as tool errors', async () => {
    vi.mocked(mediaSidecarEnabled).mockReturnValue(false);
    expect(errorOf(await videoIngest.handler({ url: PUBLIC_VIDEO }, WEB_CTX))).toMatch(
      /Media ingestion is not enabled/,
    );
    vi.mocked(mediaSidecarEnabled).mockReturnValue(true);
    expect(
      errorOf(await videoIngest.handler({ url: PUBLIC_VIDEO, file_node_id: 'f1' }, WEB_CTX)),
    ).toMatch(/EITHER url OR file_node_id/);
    expect(errorOf(await videoIngest.handler({}, WEB_CTX))).toMatch(/pass one of `url`/);
    expect(mediaProbe).not.toHaveBeenCalled();
    expect(fileById).not.toHaveBeenCalled();
  });

  it.each([
    ['the cloud-metadata address', 'http://169.254.169.254/latest/', /private\/internal address/],
    ['loopback', 'http://127.0.0.1:8080/v.mp4', /private\/internal address/],
    ['a non-http scheme', 'file:///etc/passwd', /only http\(s\) URLs/],
  ])('never sends %s to the sidecar', async (_l, url, re) => {
    expect(errorOf(await videoIngest.handler({ url }, WEB_CTX))).toMatch(re);
    expect(mediaProbe).not.toHaveBeenCalled();
  });

  it('reports a probe failure and a live stream without fetching anything', async () => {
    vi.mocked(mediaProbe).mockResolvedValue({
      ok: false,
      code: 'unreachable',
      message: 'no route',
    });
    expect(errorOf(await videoIngest.handler({ url: PUBLIC_VIDEO }, WEB_CTX))).toBe(
      'unreachable: no route',
    );
    vi.mocked(mediaProbe).mockResolvedValue({ ok: true, value: { ...PROBE, isLive: true } });
    expect(errorOf(await videoIngest.handler({ url: PUBLIC_VIDEO }, WEB_CTX))).toMatch(
      /LIVE stream/,
    );
    expect(mediaCaptions).not.toHaveBeenCalled();
    expect(mediaAudio).not.toHaveBeenCalled();
  });

  it('refuses an over-cap video with no captions before any download', async () => {
    vi.mocked(mediaProbe).mockResolvedValue({
      ok: true,
      value: { ...PROBE, durationSeconds: 99_999, captions: { manual: [], auto: [] } },
    });
    expect(errorOf(await videoIngest.handler({ url: PUBLIC_VIDEO }, WEB_CTX))).toMatch(
      /over the \d+s STT cap/,
    );
    expect(mediaAudio).not.toHaveBeenCalled();
    expect(getDefaultWorker).not.toHaveBeenCalled();
  });

  it('captions path: builds the page under the caller and downloads no audio', async () => {
    const res = await videoIngest.handler({ url: PUBLIC_VIDEO, language: 'en' }, WEB_CTX);
    expect(mediaCaptions).toHaveBeenCalledWith(PUBLIC_VIDEO, { lang: 'en', prefer: 'any' });
    expect(mediaAudio).not.toHaveBeenCalled();
    expect(upsertFile).not.toHaveBeenCalled();
    expect(getDefaultWorker).not.toHaveBeenCalled();
    expect(createPage).toHaveBeenCalledWith(
      'o1',
      expect.objectContaining({
        title: expect.stringMatching(/^Transcript — Setting the APN$/),
        tags: ['transcript', 'video'],
        data: {
          source: 'video_ingest',
          transcriptSource: 'captions:manual',
          sourceUrl: PUBLIC_VIDEO,
        },
      }),
    );
    expect(recordIngest).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'agent_tool', ownerId: 'o1', nodeId: 'page-1' }),
    );
    const out = outputOf(res);
    expect(out).toMatchObject({
      ok: true,
      video: { title: 'Setting the APN', durationSeconds: 120, channel: 'Ops', url: PUBLIC_VIDEO },
      transcriptPageId: 'page-1',
      transcriptSource: 'captions:manual',
    });
    expect(out.wordCount as number).toBeGreaterThan(10);
    expect(out).not.toHaveProperty('audioFileId');
    expect(out).not.toHaveProperty('notes');
  });

  it('STT path: resolves the worker BEFORE fetching audio', async () => {
    vi.mocked(mediaProbe).mockResolvedValue({
      ok: true,
      value: { ...PROBE, captions: { manual: [], auto: [] } },
    });
    vi.mocked(getDefaultWorker).mockResolvedValue(null);
    expect(errorOf(await videoIngest.handler({ url: PUBLIC_VIDEO }, WEB_CTX))).toMatch(
      /no usable captions and No default stt worker/,
    );
    expect(mediaAudio).not.toHaveBeenCalled();
  });

  it('STT path: saves the clip under the caller BEFORE transcribing, and keeps it when STT fails', async () => {
    vi.mocked(mediaProbe).mockResolvedValue({
      ok: true,
      value: { ...PROBE, captions: { manual: [], auto: [] } },
    });
    vi.mocked(upsertFile).mockResolvedValue({ id: 'audio-1' } as never);
    sttAdapter.transcribe.mockRejectedValue(new Error('quota exceeded'));

    const out = outputOf(await videoIngest.handler({ url: PUBLIC_VIDEO }, WEB_CTX));

    expect(upsertFile).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerId: 'o1',
        filename: expect.stringMatching(/^\d+-setting-the-apn\.mp3$/),
        bytes: MP3,
        overwrite: false,
        tags: ['audio', 'video-ingest'],
        data: expect.objectContaining({
          source: 'video_ingest',
          sourceUrl: PUBLIC_VIDEO,
          indexing: 'metadata',
        }),
      }),
    );
    expect(sttAdapter.transcribe).toHaveBeenCalledWith(
      MP3,
      expect.objectContaining({ apiKey: 'sk-test', mimeType: 'audio/mpeg', model: 'whisper-1' }),
    );
    expect(out).toMatchObject({
      ok: true,
      partial: true,
      audioFileId: 'audio-1',
      transcriptPageId: null,
    });
    expect(out.error).toMatch(/transcription failed: quota exceeded/);
    expect(createPage).not.toHaveBeenCalled();
  });

  it('STT path: a good transcription lands as a page that names its source', async () => {
    vi.mocked(mediaProbe).mockResolvedValue({
      ok: true,
      value: { ...PROBE, captions: { manual: [], auto: [] } },
    });
    vi.mocked(upsertFile).mockResolvedValue({ id: 'audio-1' } as never);
    const out = outputOf(await videoIngest.handler({ url: PUBLIC_VIDEO }, WEB_CTX));
    expect(bumpWorkerUsage).toHaveBeenCalledWith('w-stt');
    expect(out).toMatchObject({
      transcriptPageId: 'page-1',
      transcriptSource: 'stt:openai',
      audioFileId: 'audio-1',
      preview: 'hello from the transcript',
    });
    expect(out.notes).toEqual([expect.stringMatching(/machine-transcribed/)]);
  });

  it('keeps the transcript in the turn when the page cannot be created', async () => {
    vi.mocked(createPage).mockRejectedValue(new Error('pages root missing'));
    const out = outputOf(await videoIngest.handler({ url: PUBLIC_VIDEO }, WEB_CTX));
    expect(out).toMatchObject({ ok: true, partial: true, transcriptPageId: null });
    expect(out.error).toMatch(/page could not be created: pages root missing/);
    expect(out.preview).toMatch(/First we open the settings menu/);
    expect(recordIngest).not.toHaveBeenCalled();
  });

  it('file path: gates on owner, mime and size BEFORE reading the bytes', async () => {
    expect(errorOf(await videoIngest.handler({ file_node_id: 'f1' }, WEB_CTX))).toMatch(
      /file f1 not found/,
    );
    expect(fileById).toHaveBeenCalledWith({ ownerId: 'o1', fileId: 'f1' });

    vi.mocked(fileById).mockResolvedValue({
      mimeType: 'application/pdf',
      filename: 'x.pdf',
      sizeBytes: 10,
    } as never);
    expect(errorOf(await videoIngest.handler({ file_node_id: 'f1' }, WEB_CTX))).toMatch(
      /wants a video\/\* or audio\/\* file/,
    );

    vi.mocked(fileById).mockResolvedValue({
      mimeType: 'video/mp4',
      filename: 'big.mp4',
      sizeBytes: 2 * 1024 ** 3,
    } as never);
    expect(errorOf(await videoIngest.handler({ file_node_id: 'f1' }, WEB_CTX))).toMatch(
      /over the \d+-byte cap/,
    );
    expect(readFileById).not.toHaveBeenCalled();
  });

  it('file path: extracts audio beside the source, linked to it, and transcribes', async () => {
    vi.mocked(fileById).mockResolvedValue({
      mimeType: 'video/mp4',
      filename: 'talk.mp4',
      sizeBytes: 1000,
      title: 'Talk',
    } as never);
    vi.mocked(readFileById).mockResolvedValue({
      bytes: Buffer.from('mp4'),
      row: { parentPath: 'files.videos', filename: 'talk.mp4' },
    } as never);
    vi.mocked(upsertFile).mockResolvedValue({ id: 'audio-2' } as never);

    const out = outputOf(await videoIngest.handler({ file_node_id: 'f1' }, WEB_CTX));

    expect(readFileById).toHaveBeenCalledWith({ ownerId: 'o1', fileId: 'f1' });
    expect(mediaExtractAudio).toHaveBeenCalledWith(Buffer.from('mp4'), expect.any(Object));
    expect(upsertFile).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerId: 'o1',
        parentPath: 'files.videos',
        filename: 'talk-audio.mp3',
        overwrite: false,
        data: expect.objectContaining({ source: 'video_ingest', sourceFileId: 'f1' }),
      }),
    );
    expect(createPage).toHaveBeenCalledWith(
      'o1',
      expect.objectContaining({
        data: expect.objectContaining({ transcriptSource: 'stt:openai', sourceFileId: 'f1' }),
      }),
    );
    expect(out).toMatchObject({
      transcriptPageId: 'page-1',
      audioFileId: 'audio-2',
      videoFileId: 'f1',
      video: { title: 'Talk', url: null },
    });
  });
});

/* ─────────────────────────────── show_image ────────────────────────────── */

describe('show_image', () => {
  const META = { id: 'f1', title: 'Wiring', mimeType: 'image/png', filename: 'wiring.png' };

  it('refuses a blank id, then a missing file, under the caller', async () => {
    expect(errorOf(await showImage.handler({ file_id: '' }, WEB_CTX))).toBe('file_id required');
    expect(fileById).not.toHaveBeenCalled();
    const err = errorOf(await showImage.handler({ file_id: 'f1' }, WEB_CTX));
    expect(err).toMatch(/file f1 not found/);
    expect(err).toMatch(/search_nodes/);
    expect(fileById).toHaveBeenCalledWith({ ownerId: 'o1', fileId: 'f1' });
  });

  it('refuses a non-image by mime BEFORE reading the bytes', async () => {
    vi.mocked(fileById).mockResolvedValue({ ...META, mimeType: 'application/pdf' } as never);
    const err = errorOf(await showImage.handler({ file_id: 'f1' }, WEB_CTX));
    expect(err).toMatch(/is application\/pdf, not an image/);
    expect(err).toMatch(/file_read/);
    expect(readFileById).not.toHaveBeenCalled();
  });

  it('reports missing bytes and an oversized image as tool errors', async () => {
    vi.mocked(fileById).mockResolvedValue(META as never);
    expect(errorOf(await showImage.handler({ file_id: 'f1' }, WEB_CTX))).toMatch(
      /no readable bytes in storage/,
    );
    expect(readFileById).toHaveBeenCalledWith({ ownerId: 'o1', fileId: 'f1' });

    vi.mocked(readFileById).mockResolvedValue({ bytes: Buffer.alloc(6_000_001) } as never);
    const err = errorOf(await showImage.handler({ file_id: 'f1' }, WEB_CTX));
    expect(err).toMatch(/6 MB, too large to show inline/);
    expect(err).toContain('f1');
    expect(sendPhoto).not.toHaveBeenCalled();
  });

  it('on the web: metadata in the output, the picture as an artifact', async () => {
    vi.mocked(fileById).mockResolvedValue(META as never);
    vi.mocked(readFileById).mockResolvedValue({ bytes: PNG } as never);
    const res = await showImage.handler({ file_id: 'f1' }, WEB_CTX);
    const out = outputOf(res);
    expect(out).toMatchObject({
      shown: true,
      fileId: 'f1',
      title: 'Wiring',
      mimeType: 'image/png',
      bytes: PNG.length,
      deliveredVia: 'web',
    });
    expect(out.url).toContain('f1');
    expect(JSON.stringify(out)).not.toContain(PNG.toString('base64'));
    expect(artifactsOf(res)).toEqual([
      {
        kind: 'image',
        mimeType: 'image/png',
        base64: PNG.toString('base64'),
        nodeId: 'f1',
        caption: 'Wiring',
        producedBy: 'show_image',
      },
    ]);
    expect(sendPhoto).not.toHaveBeenCalled();
  });

  it('on Telegram: sendPhoto with the caption override, threaded under the inbound message', async () => {
    vi.mocked(fileById).mockResolvedValue(META as never);
    vi.mocked(readFileById).mockResolvedValue({ bytes: PNG } as never);
    const res = await showImage.handler({ file_id: 'f1', caption: 'The APN screen' }, TG_CTX);
    expect(accountForChat).toHaveBeenCalledWith('42');
    expect(sendPhoto).toHaveBeenCalledWith({ id: 'acc' }, '42', PNG, {
      replyTo: '7',
      caption: 'The APN screen',
    });
    expect(outputOf(res)).toMatchObject({ telegramMessageId: 777, deliveredVia: 'telegram' });
    expect(artifactsOf(res)[0]).toMatchObject({ caption: 'The APN screen' });
  });

  it('on Telegram: a failed send does not void the call, and lands on the trace', async () => {
    vi.mocked(fileById).mockResolvedValue(META as never);
    vi.mocked(readFileById).mockResolvedValue({ bytes: PNG } as never);
    vi.mocked(sendPhoto).mockRejectedValue(new Error('403 bot blocked'));
    const step = { setMeta: vi.fn(), setOutput: vi.fn() };
    const res = await showImage.handler(
      { file_id: 'f1' },
      { ...TG_CTX, step: step as unknown as ToolHandlerContext['step'] },
    );
    expect(outputOf(res)).toMatchObject({ shown: true, fileId: 'f1' });
    expect(artifactsOf(res)).toHaveLength(1);
    expect(step.setMeta).toHaveBeenCalledWith({ telegram_send_error: '403 bot blocked' });
  });
});
