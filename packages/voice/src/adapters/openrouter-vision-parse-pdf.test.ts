/**
 * `parsePdf` on OpenRouter (the Scan reader's read): a one-page PDF through
 * the `file-parser` plugin with the worker's engine, a chat model with a
 * 16-token cap, and the page's text from the file annotation, not from the
 * model's answer; the billed cost from `usage.cost`. A made-up provider.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fileAnnotationText,
  MISTRAL_OCR_PAGE_USD,
  openrouterVisionAdapter,
} from './openrouter-vision';
import { recordingVision } from './spend';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const REPLY = {
  model: 'made/text-model',
  choices: [
    {
      finish_reason: 'length',
      message: {
        content: 'OK',
        annotations: [
          {
            type: 'file',
            file: {
              hash: 'h1',
              name: 'page.pdf',
              content: [
                { type: 'text', text: '<file name="page.pdf">\nPAGE 7\n| A | B |' },
                { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
                { type: 'text', text: '</file>' },
              ],
            },
          },
        ],
      },
    },
  ],
  usage: { prompt_tokens: 1327, completion_tokens: 3, cost: 0.00202666 },
};

function answer(reply: unknown, sent: Array<Record<string, unknown>>) {
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    sent.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify(reply), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
}

const pdf = Buffer.from('%PDF-1.4 made-up');

describe('openrouter vision: parsePdf', () => {
  it('sends the PDF with the engine and a tiny answer cap, and reads the annotation', async () => {
    const sent: Array<Record<string, unknown>> = [];
    answer(REPLY, sent);
    const r = await openrouterVisionAdapter.parsePdf!(pdf, {
      apiKey: 'made-up-key',
      engine: 'mistral-ocr',
      model: 'made/text-model',
    });
    const body = sent[0]!;
    expect(body.model).toBe('made/text-model');
    expect(body.max_tokens).toBe(16);
    expect(body.plugins).toEqual([{ id: 'file-parser', pdf: { engine: 'mistral-ocr' } }]);
    expect(body.usage).toEqual({ include: true });
    const content = (body.messages as Array<{ content: Array<Record<string, unknown>> }>)[0]!
      .content;
    expect(content[1]).toEqual({
      type: 'file',
      file: {
        filename: 'page.pdf',
        file_data: `data:application/pdf;base64,${pdf.toString('base64')}`,
      },
    });
    // The parser's text, not the model's "OK"; the picture part is left out.
    expect(r.text).toBe('<file name="page.pdf">\nPAGE 7\n| A | B |\n</file>');
    expect(r).toMatchObject({ tokensIn: 1327, tokensOut: 3, reportedCostUsd: 0.00202666 });
  });

  it('no annotation: no text (the model answer is never the page)', async () => {
    answer({ choices: [{ message: { content: 'OK' } }] }, []);
    const r = await openrouterVisionAdapter.parsePdf!(pdf, {
      apiKey: 'k',
      engine: 'mistral-ocr',
      model: 'm',
    });
    expect(r.text).toBe('');
    expect(r.reportedCostUsd).toBeUndefined();
  });

  it('a model that refuses after the parse: the parsed text from the error is the read', async () => {
    const reply = (body: unknown) => {
      globalThis.fetch = (async () =>
        new Response(JSON.stringify(body), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        })) as typeof fetch;
    };
    reply({
      error: {
        message: 'This model does not take this image.',
        code: 400,
        metadata: {
          file_annotations: [
            { type: 'file', file: { content: [{ type: 'text', text: ' PAGE 9 ' }] } },
          ],
        },
      },
    });
    const opts = { apiKey: 'k', engine: 'mistral-ocr', model: 'm', filename: 'secret-name.pdf' };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // The parser's list fee is the cost: the error reports none.
    expect(await openrouterVisionAdapter.parsePdf!(pdf, opts)).toEqual({
      text: 'PAGE 9',
      model: 'm',
      finishReason: 'error',
      reportedCostUsd: MISTRAL_OCR_PAGE_USD,
    });
    // One warn line: the status and the error code, never the page or its name.
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0]![0]);
    expect(line).toMatch(/status 400, code 400/);
    expect(line).not.toMatch(/PAGE 9|secret-name/);
    warn.mockRestore();
    // No parsed text in the error: the error stands (the read fails).
    reply({ error: { message: 'Bad request.', code: 400 } });
    await expect(openrouterVisionAdapter.parsePdf!(pdf, opts)).rejects.toThrow(/400/);
  });

  it('refuses with no key, no PDF or no engine before any call', async () => {
    const sent: Array<Record<string, unknown>> = [];
    answer(REPLY, sent);
    const call = (b: Buffer, o: { apiKey: string; engine: string }) =>
      openrouterVisionAdapter.parsePdf!(b, { ...o, model: 'm' });
    await expect(call(pdf, { apiKey: '', engine: 'mistral-ocr' })).rejects.toThrow();
    await expect(call(Buffer.alloc(0), { apiKey: 'k', engine: 'mistral-ocr' })).rejects.toThrow();
    await expect(call(pdf, { apiKey: 'k', engine: '' })).rejects.toThrow();
    expect(sent).toEqual([]);
  });

  it('the recording wrapper keeps parsePdf and its result', async () => {
    answer(REPLY, []);
    const wrapped = recordingVision(openrouterVisionAdapter);
    expect(typeof wrapped.parsePdf).toBe('function');
    const r = await wrapped.parsePdf!(pdf, { apiKey: 'k', engine: 'mistral-ocr', model: 'm' });
    expect(r.reportedCostUsd).toBe(0.00202666);
  });
});

describe('fileAnnotationText', () => {
  it('joins the text parts of every file annotation, in order', () => {
    expect(
      fileAnnotationText([
        { type: 'url_citation', url: 'x' },
        { type: 'file', file: { content: [{ type: 'text', text: 'one' }] } },
        { type: 'file', file: { content: [{ type: 'text', text: 'two' }, { type: 'text' }] } },
      ]),
    ).toBe('one\ntwo');
  });

  it('is empty for anything else', () => {
    expect(fileAnnotationText(undefined)).toBe('');
    expect(fileAnnotationText({})).toBe('');
    expect(fileAnnotationText([{ type: 'file' }])).toBe('');
  });
});
