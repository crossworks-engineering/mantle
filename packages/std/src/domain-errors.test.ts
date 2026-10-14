import { describe, expect, it, vi } from 'vitest';
import {
  ConflictError,
  DOMAIN_ERRORS,
  InputError,
  defineDomainError,
  domainErrorAnswer,
  itemErrorText,
} from './domain-errors';
import { publicErrorMessage } from './index';

/**
 * The one table of domain errors (A10 part 2, fold 2): what the HTTP
 * answer and a tool say for an error the table names; nothing for the rest.
 */
describe('the domain error table', () => {
  it('answers an InputError 400 and a ConflictError 409, with their text', () => {
    expect(domainErrorAnswer(new InputError('invalid starts_at'))).toEqual({
      status: 400,
      body: { error: 'invalid starts_at' },
      toolText: 'invalid starts_at',
    });
    expect(domainErrorAnswer(new ConflictError("'a.md' already exists"))?.status).toBe(409);
  });

  it('names nothing else: a plain error, a database error, a string', () => {
    expect(domainErrorAnswer(new Error('plain'))).toBeNull();
    expect(
      domainErrorAnswer(Object.assign(new Error('x'), { code: '42703', severity: 'ERROR' })),
    ).toBeNull();
    expect(domainErrorAnswer('text')).toBeNull();
    expect(domainErrorAnswer(null)).toBeNull();
  });

  it('reads a subclass by its own row, else its parent row, and a cause below', () => {
    class Wider extends InputError {}
    class Own extends InputError {}
    defineDomainError(Own, {
      reason: 'test',
      status: (e) => (e.message === 'gone' ? 410 : 422),
      body: (e) => ({ error: e.message, code: 'own' }),
      toolText: () => 'tool words',
    });
    expect(domainErrorAnswer(new Wider('w'))?.status).toBe(400);
    expect(domainErrorAnswer(new Own('gone'))).toEqual({
      status: 410,
      body: { error: 'gone', code: 'own' },
      toolText: 'tool words',
    });
    const wrapped = new Error('step failed', { cause: new InputError('bad date') });
    expect(domainErrorAnswer(wrapped)?.body).toEqual({ error: 'bad date' });
    expect(DOMAIN_ERRORS.has(InputError)).toBe(true);
  });

  it('a tool says the same text as the route (publicErrorMessage)', () => {
    expect(publicErrorMessage(new InputError('entry_date must be a valid date'), 'test')).toBe(
      'entry_date must be a valid date',
    );
  });

  it("a failed item of a batch says a domain error's text, a fault the fallback (fix round 1, L5)", () => {
    expect(itemErrorText(new InputError('bad spec'), 'test', 'failed')).toBe('bad spec');
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(itemErrorText(new Error('relation "x" does not exist'), 'test', 'failed')).toBe(
      'failed',
    );
    expect(log).toHaveBeenCalledOnce();
    log.mockRestore();
  });
});
