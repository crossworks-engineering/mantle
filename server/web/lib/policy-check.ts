/**
 * The box policy's boot check and its read-only report (docs/policy.md).
 *
 *  - `blockedModelRoutes()`: every enabled assistant, AI worker and the
 *    embedder whose model route (primary, or a backup that is on) the
 *    policy's model block refuses. Each would fail at call time
 *    (@mantle/voice model-policy.ts); this names them before anyone calls.
 *  - `runPolicyBootCheck()`: at boot, only when a policy is set. Logs the
 *    rules in force and one line per blocked route, and opens (or closes)
 *    the brain's `model_policy` provider alert, so an admin sees it.
 *  - `policyReport()`: what GET /api/policy answers (the Policy panel).
 *
 * With no policy set nothing here runs: the boot check is never called and
 * the route answers 404 (the panel does not appear).
 */
import {
  boxPolicy,
  modelPolicyRefusal,
  modelPolicySet,
  passwordPolicyMin,
  policySet,
  telegramAllowed,
  type ModelPolicyRuleName,
} from '@mantle/config';
import {
  agents,
  aiWorkers,
  authUsers,
  db,
  embeddingConfig,
  eq,
  isNull,
  sql,
  recordProviderFailure,
  resolveProviderAlert,
  resolveSingleOwnerId,
} from '@mantle/db';
import { PROVIDER_ERROR_REASONS } from '@mantle/std';
import { passwordRule } from './auth/password-rule';

/** An agent row whose model is another's (it inherits): no route of its own. */
const INHERIT = 'inherit';

/** One configured route the model block refuses. */
export type BlockedModelRoute = {
  /** `agent:<slug>`, `worker:<kind>`, `embedding`. */
  ref: string;
  /** Which route of it: the primary or the backup. */
  route: 'primary' | 'backup';
  provider: string;
  model: string;
  /** The rule that refuses it. */
  rule: ModelPolicyRuleName;
};

type Route = {
  ref: string;
  route: 'primary' | 'backup';
  provider: string;
  model: string;
  baseUrl: string | null;
};

/** Every enabled route the model block refuses (empty with no model rule). */
export async function blockedModelRoutes(): Promise<BlockedModelRoute[]> {
  if (!modelPolicySet()) return [];
  const [agentRows, workerRows, embedRows] = await Promise.all([
    db
      .select({
        slug: agents.slug,
        provider: agents.provider,
        model: agents.model,
        baseUrl: agents.baseUrl,
        backupEnabled: agents.backupEnabled,
        backupProvider: agents.backupProvider,
        backupModel: agents.backupModel,
        backupBaseUrl: agents.backupBaseUrl,
      })
      .from(agents)
      .where(eq(agents.enabled, true)),
    db
      .select({
        kind: aiWorkers.kind,
        provider: aiWorkers.provider,
        model: aiWorkers.model,
        baseUrl: aiWorkers.baseUrl,
        backupEnabled: aiWorkers.backupEnabled,
        backupProvider: aiWorkers.backupProvider,
        backupModel: aiWorkers.backupModel,
        backupBaseUrl: aiWorkers.backupBaseUrl,
      })
      .from(aiWorkers)
      .where(eq(aiWorkers.enabled, true)),
    db
      .select({
        model: embeddingConfig.model,
        primaryProvider: embeddingConfig.primaryProvider,
        primaryBaseUrl: embeddingConfig.primaryBaseUrl,
        backupEnabled: embeddingConfig.backupEnabled,
        backupProvider: embeddingConfig.backupProvider,
        backupBaseUrl: embeddingConfig.backupBaseUrl,
      })
      .from(embeddingConfig),
  ]);
  const routes: Route[] = [];
  const add = (
    ref: string,
    route: Route['route'],
    provider: string | null | undefined,
    model: string | null | undefined,
    baseUrl: string | null | undefined,
  ) => {
    if (!provider || !model || model === INHERIT) return;
    routes.push({ ref, route, provider, model, baseUrl: baseUrl ?? null });
  };
  for (const a of agentRows) {
    add(`agent:${a.slug}`, 'primary', a.provider, a.model, a.baseUrl);
    if (a.backupEnabled) {
      add(`agent:${a.slug}`, 'backup', a.backupProvider, a.backupModel, a.backupBaseUrl);
    }
  }
  for (const w of workerRows) {
    add(`worker:${w.kind}`, 'primary', w.provider, w.model, w.baseUrl);
    if (w.backupEnabled) {
      add(`worker:${w.kind}`, 'backup', w.backupProvider, w.backupModel, w.backupBaseUrl);
    }
  }
  for (const e of embedRows) {
    add('embedding', 'primary', e.primaryProvider, e.model, e.primaryBaseUrl);
    if (e.backupEnabled) add('embedding', 'backup', e.backupProvider, e.model, e.backupBaseUrl);
  }
  const blocked: BlockedModelRoute[] = [];
  for (const { baseUrl, ...r } of routes) {
    const refusal = modelPolicyRefusal(r.provider, r.model, baseUrl);
    if (refusal) blocked.push({ ...r, rule: refusal.rule });
  }
  return blocked;
}

/** The policy as the Policy panel shows it: each rule, on or not. */
export type PolicyReport = {
  telegram: { off: boolean };
  models: { deny: readonly string[]; providerAllow: readonly string[] | null };
  passwords: { set: boolean; min: number; commonList: boolean };
  /** Every enabled route the model block refuses. */
  blocked: BlockedModelRoute[];
  endpointAllow: readonly string[] | null;
  /** Enabled logins the password rule holds now (password-hold.ts). */
  heldLogins: { change: number; recheck: number };
};

/** How many enabled logins the password rule holds now: `change` (a weak
 *  password, held to the change step) and `recheck` (not yet checked under
 *  the rule: they sign in once). Zero with no rule. */
export async function heldLoginCounts(): Promise<{ change: number; recheck: number }> {
  const min = passwordPolicyMin();
  if (min === null) return { change: 0, recheck: 0 };
  const [row] = await db
    .select({
      change: sql<number>`count(*) filter (where ${authUsers.mustChangePassword})::int`,
      recheck: sql<number>`count(*) filter (where not ${authUsers.mustChangePassword} and (${authUsers.passwordCheckedMin} is null or ${authUsers.passwordCheckedMin} < ${min}))::int`,
    })
    .from(authUsers)
    .where(isNull(authUsers.disabledAt));
  return { change: row?.change ?? 0, recheck: row?.recheck ?? 0 };
}

/** GET /api/policy's answer, or null with no policy set (the panel does not
 *  appear). */
export async function policyReport(): Promise<PolicyReport | null> {
  if (!policySet()) return null;
  const p = boxPolicy();
  const rule = passwordRule();
  return {
    telegram: { off: !telegramAllowed() },
    models: { deny: p.modelDeny ?? [], providerAllow: p.providerAllow },
    passwords: { set: p.passwordMin !== null, min: rule.min, commonList: rule.commonList },
    blocked: await blockedModelRoutes(),
    endpointAllow: p.endpointAllow,
    heldLogins: await heldLoginCounts(),
  };
}

/**
 * The boot check: only with a policy set (the caller asks policySet first;
 * this asks again). Logs the rules and each blocked route, and opens the
 * `model_policy` alert while any is blocked, or closes one that is open
 * when none is. Never throws: a failed check is logged, the box serves.
 */
export async function runPolicyBootCheck(log: {
  info: (msg: string) => void;
  warn: (msg: string) => void;
}): Promise<void> {
  if (!policySet()) return;
  const p = boxPolicy();
  log.info(
    `box policy: telegram ${p.telegram === 'off' ? 'off' : 'as configured'}; ` +
      `model deny ${p.modelDeny ? p.modelDeny.join(',') : 'none'}; ` +
      `provider allow ${p.providerAllow ? p.providerAllow.join(',') || '(nothing)' : 'any'}; ` +
      `password min ${p.passwordMin ?? 'default'}`,
  );
  if (p.passwordMin !== null) {
    const held = await heldLoginCounts();
    log.info(
      `box policy password rule: ${held.change} login(s) must change their password; ${held.recheck} must sign in once to be checked under the rule`,
    );
  }
  if (!modelPolicySet()) return;
  const blocked = await blockedModelRoutes();
  for (const b of blocked) {
    log.warn(
      `box policy blocks ${b.ref} (${b.route}): ${b.provider}/${b.model} (${b.rule}). Its calls fail until it is moved to an allowed model.`,
    );
  }
  const ownerId = await resolveSingleOwnerId();
  if (!ownerId) return;
  if (blocked.length > 0) {
    const first = blocked[0]!;
    await recordProviderFailure(ownerId, 'model_policy', {
      code: 'policy',
      permanent: true,
      reason: PROVIDER_ERROR_REASONS.policy,
      provider: first.provider,
      model: first.model,
    });
  } else {
    await resolveProviderAlert(ownerId, 'model_policy');
  }
}
