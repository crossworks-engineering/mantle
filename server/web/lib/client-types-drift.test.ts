import { describe, expect, expectTypeOf, it } from 'vitest';
import type {
  AiWorkerKind,
  AppManifest,
  AppSource,
  BuildRef,
  ConversationAttachment,
  ContextSource as CtContextSource,
  MemberAppCard,
  MemberChatArchiveMessage,
  MemberHomeApp,
  NodeCommentAuthorKind,
  TaskPriority,
  TaskStatus,
} from '@mantle/client-types';
import type * as Db from '@mantle/db';
import type {
  AccessKeyArea,
  AccessKeyRole,
  AccessLevel,
  AppRow,
  AuthWhoami,
  HistoryActor,
  LoginKind,
  LoginRole,
  RecallActorKind,
  ShellRole,
  WorkspaceArea,
} from '@mantle/client-types';
import { ACCESS_LEVELS } from '@mantle/client-types/dto/access';
import { ACCESS_KEY_AREAS as CONTRACT_KEY_AREAS } from '@mantle/client-types/dto/access-keys';
import { WORKSPACE_AREAS } from '@mantle/client-types/dto/workspaces';
import { HISTORY_ACTORS, LOGIN_ROLES, RECALL_ACTOR_KINDS } from '@mantle/client-types/role-names';
import { SCOPE_AREAS, VIEWER_LEVELS } from '@mantle/db/viewer';
import { KEY_AREAS, type KeyArea } from '@mantle/mcp-core/key-scope';
import type { McpLoginRole } from '@mantle/mcp-core';
import type { LoginMcpChannel } from '@mantle/tools';
import type { ContextRefKind, ExportKind, ItemKind } from '@mantle/client-types/kinds';
import type { ContextSource } from '@mantle/tracing';
import {
  TASK_PRIORITIES,
  TASK_STATUSES,
  type AppHistoryActor,
  type McpDataRole,
  type RecallActor,
  type ExportKind as ContentExportKind,
  type listMemberApps,
  type resolveMemberHomeApp,
} from '@mantle/content';
import type { AccessKeyRole as ServerAccessKeyRole } from './access-keys';
import { ACCESS_KEY_AREAS } from './access-keys';
import type { WsCaller } from './workspaces';

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

  /**
   * The member app routes (member logins Phase 4b) and the admin's member
   * chats. The routes check their bodies with `satisfies`; these pin the
   * builders in content to the published shapes. The launcher card carries
   * no level since workspaces W5c.
   */
  it('member apps and member chats match the builders in content', () => {
    expectTypeOf<Awaited<ReturnType<typeof listMemberApps>>>().toEqualTypeOf<MemberAppCard[]>();
    expectTypeOf<
      Awaited<ReturnType<typeof resolveMemberHomeApp>>
    >().toEqualTypeOf<MemberHomeApp | null>();
    expectTypeOf<
      SameUnion<Db.AssistantMessage['status'], MemberChatArchiveMessage['status']>
    >().toEqualTypeOf<true>();
  });

  /**
   * The kind registry (A1) and the lists derived from it (A10 #12): the
   * registry names every node_type value, the context ref kinds of @mantle/db
   * are the registry's `contextRef` values, and content's ExportKind is the
   * registry's `exportAs` kinds. A kind added to one side only fails here.
   */
  it('the kind registry matches the node_type column and its derived lists', () => {
    expectTypeOf<SameUnion<Db.Node['type'], ItemKind>>().toEqualTypeOf<true>();
    expectTypeOf<SameUnion<Db.ContextKind, ContextRefKind>>().toEqualTypeOf<true>();
    expectTypeOf<SameUnion<ContentExportKind, ExportKind>>().toEqualTypeOf<true>();
  });

  /**
   * Role and area names (A10 #13): every alias of the login roles, the
   * Admin areas, the history and recall actors, the access levels and the
   * key areas is its source's union. An alias written by hand again (and
   * then left behind when a role is added) fails here, and the lint
   * no-hand-role-lists fails it first.
   */
  it('the role, area and actor aliases are their sources', () => {
    expectTypeOf<SameUnion<(typeof LOGIN_ROLES)[number], LoginRole>>().toEqualTypeOf<true>();
    expectTypeOf<SameUnion<LoginRole, Db.LoginRole>>().toEqualTypeOf<true>();
    expectTypeOf<SameUnion<LoginRole, Db.AuthUser['role']>>().toEqualTypeOf<true>();
    expectTypeOf<SameUnion<LoginRole, LoginKind>>().toEqualTypeOf<true>();
    expectTypeOf<SameUnion<LoginRole, ShellRole>>().toEqualTypeOf<true>();
    expectTypeOf<SameUnion<LoginRole, AccessKeyRole>>().toEqualTypeOf<true>();
    expectTypeOf<SameUnion<LoginRole, ServerAccessKeyRole>>().toEqualTypeOf<true>();
    expectTypeOf<SameUnion<LoginRole, AuthWhoami['role']>>().toEqualTypeOf<true>();
    expectTypeOf<SameUnion<LoginRole, McpLoginRole>>().toEqualTypeOf<true>();
    expectTypeOf<SameUnion<LoginRole, McpDataRole>>().toEqualTypeOf<true>();
    expectTypeOf<
      SameUnion<LoginRole, NonNullable<LoginMcpChannel['role']>>
    >().toEqualTypeOf<true>();
    expectTypeOf<SameUnion<LoginRole, WsCaller['kind']>>().toEqualTypeOf<true>();
    expectTypeOf<SameUnion<WorkspaceArea, Db.ScopeArea>>().toEqualTypeOf<true>();
    expectTypeOf<SameUnion<HistoryActor, AppHistoryActor>>().toEqualTypeOf<true>();
    expectTypeOf<SameUnion<HistoryActor, Db.NodeSnapshot['actor']>>().toEqualTypeOf<true>();
    expectTypeOf<SameUnion<(typeof HISTORY_ACTORS)[number], HistoryActor>>().toEqualTypeOf<true>();
    expectTypeOf<
      SameUnion<(typeof RECALL_ACTOR_KINDS)[number], RecallActorKind>
    >().toEqualTypeOf<true>();
    expectTypeOf<SameUnion<RecallActorKind, RecallActor['kind']>>().toEqualTypeOf<true>();
    expectTypeOf<SameUnion<AccessLevel, Db.ViewerLevel>>().toEqualTypeOf<true>();
    expectTypeOf<SameUnion<AccessKeyArea, KeyArea>>().toEqualTypeOf<true>();
    // The app author ceiling: a level subset with its own meaning, mirrored
    // by hand in the contract (not folded, pinned).
    expectTypeOf<
      SameUnion<Db.AppAuthorLevel, NonNullable<AppRow['authorLevel']>>
    >().toEqualTypeOf<true>();
  });
});

/**
 * The runtime VALUES of the lists both sides of the wire read (A10 #13): the
 * type pins above see a union, not its order, and a list's order reaches the
 * wire (the shell's `areas`) or the screens. Each server list is its
 * contract list, in the contract's order (the access levels reversed, on
 * purpose: VIEWER_LEVELS is lowest first).
 */
describe('client-types runtime lists match the server lists', () => {
  it('the Admin areas, the levels and the key areas', () => {
    expect([...SCOPE_AREAS]).toEqual([...WORKSPACE_AREAS]);
    expect([...VIEWER_LEVELS]).toEqual([...ACCESS_LEVELS].reverse());
    expect([...KEY_AREAS]).toEqual([...CONTRACT_KEY_AREAS]);
    expect([...ACCESS_KEY_AREAS]).toEqual([...CONTRACT_KEY_AREAS]);
  });

  it('the contract values (jackdaw holds hand copies of some)', () => {
    expect([...LOGIN_ROLES]).toEqual(['admin', 'member']);
    expect([...WORKSPACE_AREAS]).toEqual(['settings', 'users', 'assistants', 'connectors', 'keys']);
    expect([...HISTORY_ACTORS]).toEqual(['owner', 'agent', 'mcp', 'system', 'member']);
    expect([...RECALL_ACTOR_KINDS]).toEqual(['owner', 'agent']);
    expect([...ACCESS_LEVELS]).toEqual(['admin', 'team', 'client', 'public']);
  });
});
