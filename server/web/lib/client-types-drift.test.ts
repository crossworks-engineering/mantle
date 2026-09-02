import { describe, expectTypeOf, it } from 'vitest';
import type {
  AiWorkerKind,
  AppManifest,
  AppSource,
  BuildRef,
  ConversationAttachment,
  ContextSource as CtContextSource,
  ForumPostRequestKind,
  ForumTopicKind,
  ForumTopicStatus,
  ForumTopicVisibility,
  NodeCommentAuthorKind,
  TaskPriority,
  TaskStatus,
} from '@mantle/client-types';
import type * as Db from '@mantle/db';
import type { ContextSource } from '@mantle/tracing';
import { TASK_PRIORITIES, TASK_STATUSES } from '@mantle/content';

/**
 * Drift pins for the hand-copied types in @mantle/client-types.
 *
 * client-types is deliberately zero-dependency: a browser component must be
 * able to name a row shape without dragging `postgres` into the bundle. The
 * cost of that rule is that fourteen shapes are hand-copied from the packages
 * that own them, and a copy has no compiler telling it when the original moves.
 *
 * What was catching drift before was incidental — "the row-builder won't
 * compile". That holds only while some row-builder still assigns one to the
 * other, and stops the moment a signature widens to `unknown` or a DTO grows a
 * field the row never had. It also reports the failure in whichever unrelated
 * file happened to do the assignment. These pins are direct, and they name
 * what drifted.
 *
 * ## Not the only pins in the repo
 *
 * The three redacted ACCOUNT DTOs (PublicEmailAccount, PublicMsAccount,
 * SyncRun) are already pinned at their source, by the `AssertSameKeys` consts
 * in packages/email/src/accounts.ts and packages/microsoft/src/accounts.ts.
 * They are deliberately NOT repeated here: two pins on one type is two things
 * to update and a licence for each to assume the other one covers it. Those
 * three compare KEY SETS rather than types, because a row's `Date` is a string
 * on the wire — the same reason the task vocabulary below goes through an
 * array's element type instead of the array.
 *
 * ## Why this file lives in server/web
 *
 * A pin needs BOTH sides in scope, and client-types may never import the
 * originals. server/web is the only package that already depends on every
 * owner involved (db, tracing, content), so it is the only place the
 * comparison can be written without inventing a dependency to hold a test.
 *
 * ## How a failure shows up
 *
 * `expectTypeOf` is a COMPILE-TIME assertion, and server/web's tsconfig covers
 * every .ts file under the app — this one included. So a drifted mirror fails
 * `pnpm -r typecheck` before the test runner is reached. `SameUnion` resolves
 * to `true` when clean and otherwise to an object naming the offending
 * members, so the error reads `{ missingInDto: "poll"; extraInDto: never }`
 * rather than dumping two unions and leaving you to diff them by eye.
 *
 * ## Adding a mirror
 *
 * If you hand-copy another shape into client-types, add its pin here. A
 * mirrored type with no pin is a copy nothing is watching, which is the state
 * this file exists to end.
 */

/**
 * `true` when two unions have exactly the same members, otherwise an object
 * naming what each side is missing. Deliberately the same shape as the
 * `AssertSameKeys` guards in packages/email and packages/microsoft, so a drift
 * failure reads the same wherever in the repo it fires.
 */
type SameUnion<Source, Dto> = [Exclude<Source, Dto>, Exclude<Dto, Source>] extends [never, never]
  ? true
  : { missingInDto: Exclude<Source, Dto>; extraInDto: Exclude<Dto, Source> };

describe('client-types mirrors have not drifted from their source of truth', () => {
  it('@mantle/db enum mirrors', () => {
    expectTypeOf<
      SameUnion<Db.NodeCommentAuthorKind, NodeCommentAuthorKind>
    >().toEqualTypeOf<true>();
    expectTypeOf<SameUnion<Db.ForumTopicKind, ForumTopicKind>>().toEqualTypeOf<true>();
    expectTypeOf<SameUnion<Db.ForumTopicVisibility, ForumTopicVisibility>>().toEqualTypeOf<true>();
    expectTypeOf<SameUnion<Db.ForumTopicStatus, ForumTopicStatus>>().toEqualTypeOf<true>();
    expectTypeOf<SameUnion<Db.ForumPostRequestKind, ForumPostRequestKind>>().toEqualTypeOf<true>();
  });

  /**
   * Plain JSON shapes with no Date columns, so full type equality is the right
   * invariant here — an optional field added on either side is drift.
   */
  it('@mantle/db jsonb shape mirrors', () => {
    expectTypeOf<ConversationAttachment>().toEqualTypeOf<Db.ConversationAttachment>();
    expectTypeOf<AppSource>().toEqualTypeOf<Db.AppSource>();
    expectTypeOf<AppManifest>().toEqualTypeOf<Db.AppManifest>();
    expectTypeOf<BuildRef>().toEqualTypeOf<Db.BuildRef>();
  });

  it('@mantle/tracing ContextSource mirror', () => {
    expectTypeOf<SameUnion<ContextSource, CtContextSource>>().toEqualTypeOf<true>();
  });

  /**
   * AiWorkerKind mirrors the `ai_worker_kind` Postgres enum, whose TS form is
   * the column's own inferred union rather than an exported alias. Its comment
   * says drift is caught by `toAiWorkerDTO`'s mapping — true today, and true
   * only for as long as that mapping stays exhaustive.
   */
  it('AiWorkerKind matches the ai_worker_kind column', () => {
    expectTypeOf<SameUnion<Db.AiWorker['kind'], AiWorkerKind>>().toEqualTypeOf<true>();
  });

  /**
   * These mirror const ARRAYS in @mantle/content rather than a type, so the
   * pin goes through the array's element type. A status added to
   * `TASK_STATUSES` but not to the union (or the reverse) fails here, and that
   * is the direction that actually happens: the array is what the server
   * validates incoming values against.
   */
  it('task vocabulary matches the const arrays in content', () => {
    expectTypeOf<SameUnion<(typeof TASK_STATUSES)[number], TaskStatus>>().toEqualTypeOf<true>();
    expectTypeOf<SameUnion<(typeof TASK_PRIORITIES)[number], TaskPriority>>().toEqualTypeOf<true>();
  });
});
