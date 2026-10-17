import { describe, expect, it } from 'vitest';
import {
  BusyError,
  isBusy,
  isHeadsCheckError,
  isPermissionGap,
  isScopeWriteRefusal,
  editRefusalDetail,
  isUniqueViolation,
  inputOnMissingRef,
  isForeignKeyViolation,
  pgConstraint,
  pgErrorCode,
  withBusyRetry,
} from './pg-error';
import { ACCESS_MATRIX, WRITE_ROLE_TABLES, writeRuleArg } from './access-matrix';

/** The shape drizzle 0.45 throws from its query builder: no code on top. */
function drizzleQueryError(cause: unknown): Error {
  return Object.assign(
    new Error(
      'Failed query: insert into "auth"."users" ("id", "email") values ($1, $2)\nparams: x,y',
    ),
    { query: 'insert ...', params: [], cause },
  );
}

const pgUnique = Object.assign(
  new Error('duplicate key value violates unique constraint "users_email_key"'),
  { code: '23505', constraint_name: 'users_email_key' },
);

describe('pgErrorCode', () => {
  it('reads the code off a bare driver error', () => {
    expect(pgErrorCode(pgUnique)).toBe('23505');
  });

  it('reads the code off the cause of a drizzle query error', () => {
    expect(pgErrorCode(drizzleQueryError(pgUnique))).toBe('23505');
    expect(pgErrorCode(drizzleQueryError({ code: '23503' }))).toBe('23503');
    expect(pgErrorCode(drizzleQueryError({ code: '40001' }))).toBe('40001');
  });

  it('walks up to three causes, no further', () => {
    const wrap = (cause: unknown) => ({ message: 'wrapper', cause });
    expect(pgErrorCode(wrap(wrap(wrap({ code: '23505' }))))).toBe('23505');
    expect(pgErrorCode(wrap(wrap(wrap(wrap({ code: '23505' })))))).toBeNull();
  });

  it('returns null for errors that carry no SQLSTATE', () => {
    expect(pgErrorCode(new Error('duplicate key value violates unique constraint'))).toBeNull();
    expect(pgErrorCode(Object.assign(new Error('x'), { code: 'ENOENT' }))).toBeNull();
    expect(pgErrorCode({ code: 23505 })).toBeNull();
    expect(pgErrorCode(null)).toBeNull();
    expect(pgErrorCode(undefined)).toBeNull();
    expect(pgErrorCode('23505')).toBeNull();
  });

  it('survives a cause cycle', () => {
    const a: { message: string; cause?: unknown } = { message: 'a' };
    a.cause = a;
    expect(pgErrorCode(a)).toBeNull();
  });
});

describe('isUniqueViolation', () => {
  it('is true for 23505 on the error or its cause', () => {
    expect(isUniqueViolation(pgUnique)).toBe(true);
    expect(isUniqueViolation(drizzleQueryError(pgUnique))).toBe(true);
  });

  it('is false for other codes and for message-only errors', () => {
    expect(isUniqueViolation(drizzleQueryError({ code: '23503' }))).toBe(false);
    expect(isUniqueViolation(new Error('duplicate key value violates unique constraint'))).toBe(
      false,
    );
  });
});

describe('pgConstraint', () => {
  it('names the constraint from the error that carries the code', () => {
    expect(pgConstraint(pgUnique)).toBe('users_email_key');
    expect(pgConstraint(drizzleQueryError(pgUnique))).toBe('users_email_key');
  });

  it('is null when there is no Postgres error or no name', () => {
    expect(pgConstraint(new Error('users_email_key'))).toBeNull();
    expect(pgConstraint(drizzleQueryError({ code: '40001' }))).toBeNull();
  });
});

describe('withBusyRetry', () => {
  const deadlock = () =>
    drizzleQueryError(Object.assign(new Error('deadlock detected'), { code: '40P01' }));

  it('runs a write once more after a deadlock, and returns its result', async () => {
    let calls = 0;
    const out = await withBusyRetry(async () => {
      calls += 1;
      if (calls === 1) throw deadlock();
      return 'saved';
    });
    expect(out).toBe('saved');
    expect(calls).toBe(2);
  });

  it('busy twice: a BusyError for people, no SQL, still isBusy', async () => {
    const err = await withBusyRetry(async () => {
      throw deadlock();
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BusyError);
    expect((err as Error).message).not.toMatch(/deadlock|insert/i);
    expect(isBusy(err)).toBe(true);
  });

  it('passes any other error through at once', async () => {
    let calls = 0;
    await expect(
      withBusyRetry(async () => {
        calls += 1;
        throw pgUnique;
      }),
    ).rejects.toBe(pgUnique);
    expect(calls).toBe(1);
  });
});

describe('isHeadsCheckError', () => {
  const wrapped = (code: string, message: string) =>
    Object.assign(new Error('Failed query'), {
      cause: Object.assign(new Error(message), { code }),
    });
  it('knows the heads check refusals, through the Drizzle wrapper', () => {
    expect(isHeadsCheckError(wrapped('40001', 'heads not held for nodes_move (node x): y'))).toBe(
      true,
    );
    expect(
      isHeadsCheckError(
        wrapped('55000', 'mantle_lock_heads: heads must be the first lock of the transaction'),
      ),
    ).toBe(true);
  });
  it('is not fooled by other serialization failures or other codes', () => {
    expect(isHeadsCheckError(wrapped('40001', 'could not serialize access'))).toBe(false);
    expect(isHeadsCheckError(wrapped('23505', 'heads not held'))).toBe(false);
    expect(isHeadsCheckError(new Error('heads not held'))).toBe(false);
  });
});

describe('isScopeWriteRefusal (arch A2b2b: every refusal of the write role is a 403)', () => {
  const refusal = (message: string, code = '42501') =>
    drizzleQueryError(Object.assign(new Error(message), { code }));
  it('matches each message the checks raise', () => {
    for (const m of [
      'not allowed to move this item',
      'not allowed to add items to that folder',
      'not allowed to delete this item',
      'not allowed to change this item',
      'not allowed to change this item: it is a read-only snapshot copy',
      'not allowed to share this item: it is a read-only snapshot copy in its private workspace',
      'placing this app adds a workspace you do not moderate',
      // 0278 / 0279, the write role's own checks
      'not allowed to edit this item',
      'not allowed to create an item in that workspace',
      'not allowed to grant to that workspace',
      'not allowed to change the kind of this item',
      // the row rule
      'new row violates row-level security policy for table "nodes"',
      // mantle_default_home (0267)
      'this kind of item lives in the Admin workspace only',
      'no workspace to create this item in',
      // the edit check (A3a, 0280 and 0281)
      'not allowed to change anything: this caller only reads',
      "not allowed to change this app's code: a Moderator of its workspace does",
      "not allowed to change this app's settings: an Admin user does",
      "not allowed to write this app's data",
      'not allowed to change this item: only the brain sets that value',
      'not allowed to change this item: a Moderator of its workspace does',
    ]) {
      expect(isScopeWriteRefusal(refusal(m)), m).toBe(true);
    }
  });
  it('the edit check carries a detail the mapper reads (plan 5.2)', () => {
    const withDetail = (detail: string, code = '42501') =>
      drizzleQueryError(
        Object.assign(new Error('not allowed to change this item'), { code, detail }),
      );
    for (const d of ['no_read', 'no_edit', 'read_only', 'ro_actor'] as const) {
      expect(editRefusalDetail(withDetail(d)), d).toBe(d);
    }
    expect(editRefusalDetail(withDetail('no_actor'))).toBeNull();
    expect(editRefusalDetail(withDetail('no_edit', '23514'))).toBeNull();
    expect(editRefusalDetail(new Error('x'))).toBeNull();
  });
  it('never a missing grant (a gap), another code, or another message', () => {
    expect(isScopeWriteRefusal(refusal('permission denied for table node_snapshots'))).toBe(false);
    expect(isScopeWriteRefusal(refusal('not allowed to edit this item', '23514'))).toBe(false);
    expect(isScopeWriteRefusal(refusal('something else'))).toBe(false);
  });
});

describe('isPermissionGap (arch A2b2b: a right the write role does not hold)', () => {
  it('a missing grant on a table, a column or a function', () => {
    for (const m of [
      'permission denied for table node_snapshots',
      'permission denied for function mantle_lock_subtree_heads',
      'permission denied for sequence x_id_seq',
    ]) {
      expect(
        isPermissionGap(drizzleQueryError(Object.assign(new Error(m), { code: '42501' }))),
        m,
      ).toBe(true);
    }
  });
  it('never a refusal the database decided', () => {
    expect(
      isPermissionGap(Object.assign(new Error('not allowed to edit this item'), { code: '42501' })),
    ).toBe(false);
    expect(
      isPermissionGap(
        Object.assign(new Error('new row violates row-level security policy for table "nodes"'), {
          code: '42501',
        }),
      ),
    ).toBe(false);
  });
});

describe('the gap tables closed (plan v3 S3)', () => {
  it('profiles and app_table_exports are write-role tables; only profiles has a narrower write rule', () => {
    expect(WRITE_ROLE_TABLES).toContain('public.profiles');
    expect(WRITE_ROLE_TABLES).toContain('public.app_table_exports');
    const ruled = ACCESS_MATRIX.filter((t) => writeRuleArg(t) !== null).map((t) => [
      t.table,
      writeRuleArg(t),
    ]);
    expect(ruled).toEqual([['public.profiles', 'own-login']]);
    const exports = ACCESS_MATRIX.find((t) => t.table === 'public.app_table_exports');
    expect(exports?.writeCheck).toEqual({ kind: 'manage', item: 'app_node_id' });
  });
});

describe('isBusy under a query builder (A2b2b fix round 1, M2)', () => {
  it('a BusyError drizzle wrapped (the write pool’s bounded wait) is busy', () => {
    expect(
      isBusy(drizzleQueryError(new BusyError('The server is busy; try again in a moment.'))),
    ).toBe(true);
    expect(isBusy(drizzleQueryError(new Error('other')))).toBe(false);
  });
});

describe('inputOnMissingRef (A10 lows, part 2 #3)', () => {
  const pgMissing = (constraint: string) =>
    Object.assign(new Error(`insert violates foreign key constraint "${constraint}"`), {
      code: '23503',
      constraint_name: constraint,
    });
  const REFS = { ai_workers_api_key_id_api_keys_id_fk: 'apiKeyId names no key in the vault.' };

  it('a named foreign key the write broke is the caller’s InputError, with its message', async () => {
    const { InputError } = await import('@mantle/std');
    const missing = drizzleQueryError(pgMissing('ai_workers_api_key_id_api_keys_id_fk'));
    expect(isForeignKeyViolation(missing)).toBe(true);
    const thrown = await inputOnMissingRef(REFS, () => Promise.reject(missing)).catch(
      (e: unknown) => e,
    );
    expect(thrown).toBeInstanceOf(InputError);
    expect((thrown as Error).message).toBe('apiKeyId names no key in the vault.');
    expect((thrown as Error).cause).toBe(missing);
  });

  it('another foreign key, another error, or a prototype name stays what it was', async () => {
    for (const err of [
      pgMissing('agents_workspace_id_workspaces_id_fk'),
      pgMissing('constructor'),
      pgUnique,
      new Error('plain'),
    ]) {
      expect(await inputOnMissingRef(REFS, () => Promise.reject(err)).catch((e) => e)).toBe(err);
    }
    expect(await inputOnMissingRef(REFS, async () => 7)).toBe(7);
  });
});
