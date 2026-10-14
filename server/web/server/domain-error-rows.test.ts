/**
 * The rows fold 2's later tranches added to the one domain error table
 * (A10 part 2; docs/request-plumbing.md): each class answers exactly what
 * the route's hand catch answered before it was deleted (status and body,
 * byte for byte), and a tool still says the message. The error sweep forces
 * the database's faults, not these classes, so this is their proof.
 */
import { describe, expect, it, vi } from 'vitest';
import { domainErrorAnswer, InputError, publicErrorMessage } from '@mantle/std';
import {
  AppDraftConflictError,
  AppRestoreDraftError,
  AppSourceLimitError,
  NoGreenBuildError,
  AppBoundTableError,
  ContactShareRefusedError,
} from '@mantle/content';
import { AppDbMissingError } from '@mantle/content/app-broker';
import { AppSnapshotBudgetError, AppSnapshotRefusedError } from '@mantle/content/app-snapshots';
import { AppTrashRefusedError } from '@mantle/content/app-trash';
import { AppPackageError } from '@mantle/content/app-package';
import { TableRestoreDraftError, TableSnapshotRefusedError } from '@mantle/content/table-snapshots';
import { UploadTooLargeError } from '@mantle/files';
import { TelegramTokenError } from '../lib/agent-telegram';
import { FireRefused } from '../lib/heartbeats';
import { PdfRendererUnavailableError } from '../lib/render-pdf';
import { CloneAgentError } from '../lib/agents';
import { cancelRun, forkRun, RunActionError } from '../lib/runners';
import { FormulaNotFoundError, readFormulaSpec } from '@mantle/content/formulas';
import {
  LinkRefusedError,
  MemberInviteError,
  RecallWriteError,
  ShareInputError,
  TeamLinkRetiredError,
} from '@mantle/content';
import { ChatArchiveBusyError, ChatThreadNotFoundError } from '@mantle/runtime/agent';
import { conflictOnUnique } from '@mantle/db';
import { WsError } from '../lib/workspaces';
import { GrantError } from '../lib/grants';
import { NextResponse } from './http-compat';
import { answerAppError } from './app-error';

// The run engine's client, stood in: each action throws `dbos.error`.
const dbos = vi.hoisted(() => ({ error: null as Error | null }));
vi.mock('../lib/dbos-client', () => ({
  getDbosClient: async () => {
    const fail = async () => {
      throw dbos.error;
    };
    return { cancelWorkflow: fail, resumeWorkflow: fail, forkWorkflow: fail };
  },
}));

const answer = (err: Error) => {
  const a = domainErrorAnswer(err);
  return a && { status: a.status, body: a.body };
};

describe('the later tranches of fold 2: each class answers as its route did', () => {
  it('apps: the draft, publish, history, trash, package and database refusals', () => {
    const limit = new AppSourceLimitError('too many files (max 50)');
    expect(answer(limit)).toEqual({ status: 400, body: { error: limit.message } });
    const conflict = new AppDraftConflictError();
    expect(answer(conflict)).toEqual({
      status: 409,
      body: { error: conflict.message, reason: 'conflict' },
    });
    const green = new NoGreenBuildError();
    expect(answer(green)).toEqual({ status: 409, body: { error: green.message } });
    const draft = new AppRestoreDraftError();
    expect(answer(draft)).toEqual({ status: 409, body: { error: draft.message, reason: 'draft' } });
    const budget = new AppSnapshotBudgetError(12, 10);
    expect(answer(budget)).toEqual({
      status: 409,
      body: { error: budget.message, reason: 'budget' },
    });
    // The restore said `no-data`; the delete said no reason.
    expect(answer(new AppSnapshotRefusedError('v3 holds no data', 'no-data'))).toEqual({
      status: 409,
      body: { error: 'v3 holds no data', reason: 'no-data' },
    });
    expect(answer(new AppSnapshotRefusedError('v2 is a version'))).toEqual({
      status: 409,
      body: { error: 'v2 is a version' },
    });
    expect(answer(new AppTrashRefusedError('app x is not deleted'))).toEqual({
      status: 409,
      body: { error: 'app x is not deleted' },
    });
    expect(answer(new AppPackageError('not a zip'))).toEqual({
      status: 400,
      body: { error: 'not a zip', reason: 'bad-package' },
    });
    const missing = new AppDbMissingError('11111111-1111-4111-8111-111111111111');
    expect(answer(missing)).toEqual({
      status: 409,
      body: { error: missing.message, reason: 'db-missing' },
    });
  });

  it('tables: the history refusals and an app table', () => {
    const draft = new TableRestoreDraftError();
    expect(answer(draft)).toEqual({ status: 409, body: { error: draft.message, reason: 'draft' } });
    expect(answer(new TableSnapshotRefusedError('v4 is gone'))).toEqual({
      status: 409,
      body: { error: 'v4 is gone' },
    });
    const bound = new AppBoundTableError('Shop');
    expect(answer(bound)).toEqual({ status: 409, body: { error: bound.message } });
  });

  it('shares, telegram, heartbeats, export, the assistant clone and uploads', () => {
    expect(answer(new ContactShareRefusedError('not-a-contact', 'Not a contact.'))).toEqual({
      status: 400,
      body: { error: 'Not a contact.', reason: 'not-a-contact' },
    });
    expect(answer(new TelegramTokenError('Paste a bot token.'))).toEqual({
      status: 400,
      body: { error: 'Paste a bot token.' },
    });
    expect(answer(new TelegramTokenError('Chat not found for this bot.', 'not_found'))).toEqual({
      status: 404,
      body: { error: 'Chat not found for this bot.', code: 'not_found' },
    });
    expect(answer(new FireRefused('Only the maker fires it.'))).toEqual({
      status: 403,
      body: { error: 'Only the maker fires it.' },
    });
    const quiet = console.error;
    console.error = () => undefined;
    const pdf = new PdfRendererUnavailableError('BROWSER_WS_ENDPOINT is not set');
    console.error = quiet;
    expect(answer(pdf)).toEqual({ status: 503, body: { error: pdf.message } });
    const clone = new CloneAgentError("agent 'x' is a worker, which can't answer a chat turn");
    expect(clone).toBeInstanceOf(InputError);
    expect(answer(clone)).toEqual({ status: 400, body: { error: clone.message } });
    const big = Object.assign(new UploadTooLargeError(250 * 1024 * 1024), { filename: 'a.mp4' });
    expect(answer(big)).toEqual({
      status: 413,
      body: {
        error: 'file too large (>250 MB). For video, ask the assistant to ingest the link instead.',
        maxUploadBytes: 250 * 1024 * 1024,
      },
    });
    expect(answer(new UploadTooLargeError(1024 * 1024))?.body.error).toBe(
      'file too large (>1 MB).',
    );
  });

  it('a tool still says the message', () => {
    expect(publicErrorMessage(new AppTrashRefusedError('app x is not deleted'), 'test')).toBe(
      'app x is not deleted',
    );
  });
});

describe('fix round 1 (M2): refusals fold 2 had turned into the opaque 500', () => {
  it("the run engine's refusal of an action answers 500 with its text, as the route did", async () => {
    // DBOS's own error (DBOSNonExistentWorkflowError, code 16): the route said
    // `500 { error: message }`, and still does.
    dbos.error = Object.assign(new Error('Workflow w1 does not exist'), { dbosErrorCode: 16 });
    const thrown = await cancelRun('w1').catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(RunActionError);
    expect(answer(thrown as Error)).toEqual({
      status: 500,
      body: { error: 'Workflow w1 does not exist' },
    });
    dbos.error = Object.assign(new Error('Cannot rewind w1 (PENDING): cancel it first'), {
      dbosErrorCode: 1,
    });
    expect(answer((await forkRun('w1', 2).catch((e: unknown) => e)) as Error)).toEqual({
      status: 500,
      body: { error: 'Cannot rewind w1 (PENDING): cancel it first' },
    });
    // A fault of the engine's database is no DBOS error: no row, the opaque 500.
    dbos.error = new Error('connect ECONNREFUSED 10.0.0.1:5432');
    const fault = await cancelRun('w1').catch((e: unknown) => e);
    expect(fault).not.toBeInstanceOf(RunActionError);
    expect(answer(fault as Error)).toBeNull();
  });

  it('a formula id that is not a uuid is not found (404), not a database cast error', async () => {
    const thrown = await readFormulaSpec('11111111-1111-4111-8111-111111111111', 'nope').catch(
      (e: unknown) => e,
    );
    expect(thrown).toBeInstanceOf(FormulaNotFoundError);
    expect(answer(thrown as Error)).toEqual({
      status: 404,
      body: { error: "formula 'nope' not found" },
    });
  });
});

/** The app's whole answer to `err` on an API path (answerAppError). */
function appAnswer(err: Error): Response {
  const c = {
    req: { url: 'http://localhost/api/x', method: 'POST' },
    redirect: () => {
      throw new Error('no redirect here');
    },
    text: (t: string, status: number) => new Response(t, { status }),
  } as unknown as Parameters<typeof answerAppError>[1];
  return answerAppError(err, c);
}

/** Status, content type and body text: what a client reads. */
async function wire(res: Response) {
  return { status: res.status, type: res.headers.get('content-type'), body: await res.text() };
}

describe('fix round 1 (L7): the hand mappers folded into rows answer byte for byte', () => {
  // Each case: the error, and what the deleted hand mapper returned for it
  // (wsRoute, grantsRoute, linkRefusal, inviteErrorResponse,
  // recallWriteFailure, archiveResponse, the routes' isUniqueViolation 409).
  const cases: Array<[string, Error, Record<string, unknown>, number]> = [
    [
      'WsError',
      new WsError(409, 'last_moderator', 'Keep a moderator.'),
      { error: 'Keep a moderator.', code: 'last_moderator' },
      409,
    ],
    [
      'GrantError',
      new GrantError(404, 'not_found', 'Item not found.'),
      { error: 'Item not found.', code: 'not_found' },
      404,
    ],
    [
      'LinkRefusedError',
      new LinkRefusedError(403, 'forbidden', 'You may not link this.'),
      { error: 'You may not link this.', code: 'forbidden' },
      403,
    ],
    [
      'ShareInputError not-found',
      new ShareInputError('not-found', 'node x is gone'),
      { error: 'Item not found.', code: 'not_found' },
      404,
    ],
    [
      'ShareInputError not-shareable',
      new ShareInputError('not-shareable', 'A contact cannot be shared.'),
      { error: 'A contact cannot be shared.', code: 'not_shareable' },
      400,
    ],
    [
      'TeamLinkRetiredError',
      new TeamLinkRetiredError(),
      { error: new TeamLinkRetiredError().message, reason: 'team-links-retired' },
      400,
    ],
    [
      'MemberInviteError conflict',
      new MemberInviteError('email-has-login', 'That email has a login.'),
      { error: 'That email has a login.', reason: 'email-has-login' },
      409,
    ],
    [
      'MemberInviteError other',
      new MemberInviteError('no-email', 'The contact has no email.'),
      { error: 'The contact has no email.', reason: 'no-email' },
      400,
    ],
    [
      'RecallWriteError not found',
      new RecallWriteError('card_not_found', 'No card x.'),
      { error: 'No card x.', code: 'card_not_found' },
      404,
    ],
    [
      'RecallWriteError owner act',
      new RecallWriteError('publish_is_owners', 'Only the owner publishes.'),
      { error: 'Only the owner publishes.', code: 'publish_is_owners' },
      403,
    ],
    [
      'RecallWriteError stale',
      new RecallWriteError('version_stale', 'Reload first.'),
      { error: 'Reload first.', code: 'version_stale' },
      409,
    ],
    [
      'RecallWriteError refused',
      new RecallWriteError('too_long', 'Split it.'),
      { error: 'Split it.', code: 'too_long' },
      400,
    ],
    [
      'ChatArchiveBusyError',
      new ChatArchiveBusyError(),
      { error: new ChatArchiveBusyError().message },
      409,
    ],
    [
      'ChatThreadNotFoundError',
      new ChatThreadNotFoundError(),
      { error: new ChatThreadNotFoundError().message },
      404,
    ],
  ];

  it.each(cases)('%s', async (_name, err, body, status) => {
    expect(await wire(appAnswer(err))).toEqual(await wire(NextResponse.json(body, { status })));
  });

  it("a unique violation through conflictOnUnique: the route's own 409, byte for byte", async () => {
    // As drizzle throws it: the driver's error (23505) is the cause.
    const pg = Object.assign(new Error('duplicate key value violates unique constraint "x"'), {
      code: '23505',
    });
    const drizzle = new Error('Failed query: insert into ...', { cause: pg });
    const message = 'A skill with slug "notes" already exists.';
    const thrown = await conflictOnUnique(message, async () => {
      throw drizzle;
    }).catch((e: unknown) => e as Error);
    expect(await wire(appAnswer(thrown))).toEqual(
      await wire(NextResponse.json({ error: message }, { status: 409 })),
    );
    // Anything else goes through untouched.
    const other = new Error('boom');
    await expect(
      conflictOnUnique(message, async () => {
        throw other;
      }),
    ).rejects.toBe(other);
  });
});
