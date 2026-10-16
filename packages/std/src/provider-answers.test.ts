/**
 * What a member, the model and an MCP client hear for a failure, error by
 * error (A10 lows, provider errors; docs/provider-http.md "Behaviour
 * changes"). Record, move, compare: every cell was recorded on main
 * (provider-answers.main.json) before the step; each cell the step changed
 * is named in provider-answers.changes.json with its new answer and the
 * reason. A cell that differs from main and is not named there fails, and
 * so does a named change that no longer happens. No changed cell may carry
 * more of the error's own text than main's did (a looser answer).
 *
 * The readers:
 *  - `provider`: publicProviderErrorMessage (a provider tool, the model);
 *  - `member`: personProviderErrorMessage (a member's thread and stream for
 *    a failed team turn; fix round 1, L1). Not recorded on main, where a
 *    team turn said the `provider` reader's answer: main's `provider` cell
 *    is its baseline;
 *  - `thrown`: a builtin that throws (the dispatcher: toolThrowText, else
 *    errorMessage);
 *  - `domain`: the domain row's tool text (an HTTP answer's text), or null;
 *  - `reply`: a tool that catches and replies errorMessage(err), as the one
 *    masking (watchDatabaseErrors + publicToolError) hands it on.
 *
 *   pnpm vitest run packages/std/src/provider-answers.test.ts
 *   PROVIDER_ANSWERS_RECORD=main …   writes provider-answers.main.json (main only)
 *   PROVIDER_ANSWERS_RECORD=now …    writes provider-answers.now.json (to name changes)
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { watchDatabaseErrors } from './db-watch';
import { domainErrorAnswer } from './domain-errors';
import {
  InputError,
  TimeoutError,
  errorMessage,
  personProviderErrorMessage,
  publicProviderErrorMessage,
  publicToolError,
  toolThrowText,
} from './index';
import { ProviderHttpError } from './provider-error';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MAIN_FILE = path.join(HERE, 'provider-answers.main.json');
const CHANGES_FILE = path.join(HERE, 'provider-answers.changes.json');
const RECORD = process.env.PROVIDER_ANSWERS_RECORD;

/** Stands for an account id, an organisation name or part of a key. */
const SECRET = 'sk-or-v1-0123456789abcdef org=acme-private';

const anthropicWorkspace = JSON.stringify({
  type: 'error',
  error: {
    type: 'invalid_request_error',
    message:
      'This API key is not scoped to a workspace, so this request must include the anthropic-workspace-id header.',
  },
});

/** OpenRouter's SDK error as the chat adapter wraps it (openrouter-chat.ts). */
function sdkWrapped(status: number, upstream: string): Error {
  const inner = Object.assign(new Error('Provider returned error'), {
    statusCode: status,
    body: JSON.stringify({ error: { message: upstream, metadata: { raw: SECRET } } }),
  });
  return new Error(`openrouter-chat ${status} on some/model: ${upstream} metadata=${SECRET}`, {
    cause: inner,
  });
}

function parseError(text: string): unknown {
  try {
    JSON.parse(text);
  } catch (e) {
    return e;
  }
  return null;
}

const phe = (status: number, body: string, provider = 'openai') =>
  new ProviderHttpError({ provider, status, body, what: 'chat' });

/** Each case builds a fresh error (an error is never shared between readers). */
const CASES: Record<string, () => unknown> = {
  'phe 401 key': () => phe(401, SECRET, 'deepgram'),
  'phe 429 rate': () => phe(429, SECRET, 'anthropic'),
  'phe 500 server': () => phe(500, SECRET),
  'phe 404 model': () => phe(404, SECRET),
  'phe 400 bad args': () => phe(400, `{"error":"tools.0.name: invalid ${SECRET}"}`),
  'phe 400 max_tokens': () => phe(400, `max_tokens: 100000 > 64000, the maximum ${SECRET}`),
  'phe 400 prompt too long': () =>
    phe(400, `prompt is too long: 210000 tokens > 200000 maximum ${SECRET}`, 'anthropic'),
  'phe 400 context length': () =>
    phe(400, `This model's maximum context length is 128000 tokens ${SECRET}`),
  'phe 400 gemini token count': () =>
    phe(
      400,
      `The input token count (1200000) exceeds the maximum number of tokens allowed ${SECRET}`,
      'google',
    ),
  'phe 413 too large': () => phe(413, `Request entity too large ${SECRET}`),
  'phe 422 unprocessable': () => phe(422, `unprocessable ${SECRET}`),
  'phe 403 moderation': () => phe(403, `Your input was flagged by moderation ${SECRET}`),
  'phe 403 forbidden': () => phe(403, SECRET),
  'phe 400 anthropic workspace': () => phe(400, anthropicWorkspace, 'anthropic'),
  'phe 200 transcript error': () =>
    new ProviderHttpError({
      provider: 'assemblyai',
      status: 200,
      body: `Audio could not be decoded ${SECRET}`,
      message: `assemblyai transcript error: Audio could not be decoded ${SECRET}`,
    }),
  'phe 418 unnamed': () => phe(418, SECRET),
  'wrapped phe 400 too long': () =>
    new Error('turn failed', {
      cause: phe(400, `prompt is too long: 210000 tokens ${SECRET}`, 'anthropic'),
    }),
  'sdk 400 too long': () => sdkWrapped(400, 'prompt is too long for this route'),
  'sdk 400 bad args': () => sdkWrapped(400, 'tools.0.function.parameters is invalid'),
  'sdk 403 moderation': () => sdkWrapped(403, 'Your input was flagged by moderation'),
  'sdk 413 too large': () => sdkWrapped(413, 'Request entity too large'),
  'sdk 429 rate': () => sdkWrapped(429, 'Rate limit exceeded'),
  'sdk unwrapped 413': () =>
    Object.assign(new Error(`API error occurred: ${SECRET}`), { statusCode: 413, body: SECRET }),
  'sdk 200 validation': () =>
    Object.assign(new Error(`Response validation failed: ${SECRET}`), {
      name: 'ResponseValidationError',
      statusCode: 200,
      body: SECRET,
    }),
  'prose openrouter-chat 403': () =>
    new Error(`openrouter-chat 403 on some/model: Forbidden metadata=${SECRET}`),
  'prose anthropic chat 500': () => new Error(`anthropic chat 500: ${SECRET}`),
  'prose embeddings failed 502': () =>
    new Error(`OpenAI embeddings failed: 502 Bad Gateway \u2014 ${SECRET}`),
  'prose stream error 429': () =>
    new Error(`openrouter-chat stream error 429: Rate limited ${SECRET}`),
  'prose fetch failed 404': () => new Error('fetch failed: 404 Not Found'),
  'prose download failed http 500': () => new Error('download failed: HTTP 500'),
  'own status 401 no body': () =>
    Object.assign(new Error('no valid access token'), { status: 401 }),
  'own status 404 no body': () => Object.assign(new Error('page not found: abc'), { status: 404 }),
  'typeerror fetch failed': () =>
    new TypeError('fetch failed', {
      cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1234'), {
        code: 'ECONNREFUSED',
      }),
    }),
  'typeerror connect timeout': () =>
    new TypeError('fetch failed', {
      cause: Object.assign(new Error('Connect Timeout Error'), {
        code: 'UND_ERR_CONNECT_TIMEOUT',
      }),
    }),
  'typeerror terminated': () => new TypeError('terminated'),
  'typeerror own bug': () => new TypeError("Cannot read properties of undefined (reading 'x')"),
  'typeerror header value': () =>
    new TypeError(`Headers.append: "Bearer ${SECRET}\n" is an invalid header value.`),
  'timeout error': () => new TimeoutError('openai chat timed out after 180 s'),
  'abort error': () =>
    Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }),
  'sdk connection error': () =>
    Object.assign(new Error('Unable to make request: TypeError: fetch failed'), {
      name: 'ConnectionError',
    }),
  'sdk request timeout': () =>
    Object.assign(new Error('Request timed out: TimeoutError: signal timed out'), {
      name: 'RequestTimeoutError',
    }),
  'syntax error html body': () => parseError(`<html>${SECRET}</html>`),
  'syntax error empty body': () => parseError(''),
  'openrouter empty response': () =>
    Object.assign(
      new Error(
        'openrouter-chat: empty or truncated response from m after 34.0s, likely an upstream timeout or dropped connection',
        { cause: parseError('') },
      ),
      { name: 'OpenRouterEmptyResponseError' },
    ),
  'no key': () => new Error("no api key for provider 'openai'"),
  'own error': () => new Error('team turn: no api_key_id on agent x'),
  'input error': () => new InputError('entry_date must be a valid date'),
  'database error': () =>
    Object.assign(new Error('relation "x" does not exist'), { code: '42P01', severity: 'ERROR' }),
};

type Row = {
  provider: string;
  member: string;
  thrown: string;
  domain: string | null;
  reply: string;
};
type Changes = Record<string, { reader: keyof Row; now: string | null; why: string }[]>;

async function answer(make: () => unknown): Promise<Row> {
  const provider = publicProviderErrorMessage(make(), 't');
  const member = personProviderErrorMessage(make(), 't');
  const t = make();
  const thrown = toolThrowText(t, 't') ?? errorMessage(t);
  const domain = domainErrorAnswer(make())?.toolText ?? null;
  const r = make();
  const watched = await watchDatabaseErrors(async () => errorMessage(r));
  const reply = publicToolError(watched.value, watched.texts, 't', watched.errors);
  return { provider, member, thrown, domain, reply };
}

function readJson<T>(file: string, fallback: T): T {
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as T) : fallback;
}

describe('provider answers: record, move, compare (A10 lows)', () => {
  beforeAll(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterAll(() => vi.restoreAllMocks());

  if (RECORD === 'main' || RECORD === 'now') {
    it(`records ${RECORD}`, async () => {
      const out: Record<string, Row> = {};
      for (const [name, make] of Object.entries(CASES)) out[name] = await answer(make);
      const file = RECORD === 'main' ? MAIN_FILE : MAIN_FILE.replace('.main.', '.now.');
      writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`);
    });
    return;
  }

  // Main's record, with the member reader's baseline: on main a team turn
  // said publicProviderErrorMessage, the provider reader's answer.
  const main = Object.fromEntries(
    Object.entries(readJson<Record<string, Omit<Row, 'member'>>>(MAIN_FILE, {})).map(
      ([name, row]) => [name, { ...row, member: row.provider }],
    ),
  ) as Record<string, Row>;
  const changes = readJson<Changes>(CHANGES_FILE, {});

  it('reads every recorded case, and only those', () => {
    expect(Object.keys(CASES).sort()).toEqual(Object.keys(main).sort());
    for (const name of Object.keys(changes)) expect(main[name], name).toBeDefined();
  });

  for (const [name, make] of Object.entries(CASES)) {
    it(name, async () => {
      const now = await answer(make);
      const expected: Row = { ...main[name]! };
      for (const c of changes[name] ?? []) {
        // A named change must still happen.
        expect(c.now, `${name} ${c.reader}: named change is no change`).not.toBe(
          main[name]![c.reader],
        );
        (expected as Record<string, string | null>)[c.reader] = c.now;
      }
      expect(now).toEqual(expected);
      // Never looser: a changed cell carries none of the error's own text
      // that main's cell did not.
      for (const c of changes[name] ?? []) {
        if (c.now === null) continue;
        const before = main[name]![c.reader] ?? '';
        if (c.now.includes(SECRET)) expect(before, `${name} ${c.reader}`).toContain(SECRET);
        const e = make() as { message?: unknown } | null;
        const msg = typeof e?.message === 'string' ? e.message : '';
        if (msg && c.now.includes(msg)) expect(before, `${name} ${c.reader}`).toContain(msg);
      }
    });
  }
});
