/**
 * The rows fold 2's later tranches added to the one domain error table
 * (A10 part 2; docs/request-plumbing.md): each class answers exactly what
 * the route's hand catch answered before it was deleted (status and body,
 * byte for byte), and a tool still says the message. The error sweep forces
 * the database's faults, not these classes, so this is their proof.
 */
import { describe, expect, it } from 'vitest';
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
