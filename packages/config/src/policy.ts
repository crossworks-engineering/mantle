/**
 * The box policy: the operator's rules for a corporate box, read from the
 * box `.env` ONCE per process and never written by the app, so a box admin
 * cannot turn a rule off from Settings (plan "Corporate sign-in", section
 * 6.1; docs/policy.md).
 *
 *   MANTLE_POLICY_TELEGRAM=off
 *   MANTLE_POLICY_MODEL_DENY=deepseek/*,qwen/*
 *   MANTLE_POLICY_PROVIDER_ALLOW=foundry,local
 *   MANTLE_POLICY_PASSWORD_MIN=12
 *
 * An empty or missing value is NO rule. A box with every value empty
 * behaves exactly as a box from before this module: no Telegram switch, no
 * model block, the 8-character password rule, no Policy panel, no boot
 * check (policy.test.ts and the acceptance test pin it). A value that does
 * not parse is a boot error (policyProblems, read by assertEnvShape):
 * a typo must never quietly leave a box without the rule its operator set.
 *
 * Each rule has ONE reader here and one gate where it bites:
 *   - Telegram: telegramAllowed() (the poll worker, the Bot transport, the
 *     tool lists, the Telegram routes' switch).
 *   - Models: modelPolicyRefusal() (the one model check, @mantle/voice
 *     model-policy.ts, which every model call path goes through).
 *   - Passwords: passwordPolicyMin() (the one password rule,
 *     server/web/lib/auth/password-rule.ts).
 *
 * No dependency beyond this package and no network call: safe on every hot
 * path and in every process.
 */
import { env } from './index';

/** Today's password rule: 8 characters, no list. The floor of any policy. */
export const DEFAULT_PASSWORD_MIN = 8;
/** The longest minimum a policy may ask for (a password is capped at 1024). */
export const MAX_PASSWORD_MIN = 128;

/** The parsed policy. `null` on a field = no rule. */
export type BoxPolicy = Readonly<{
  /** 'off': Telegram is switched off for the whole box. */
  telegram: 'off' | null;
  /** Model patterns no route may call (lowercase, see modelPolicyRefusal). */
  modelDeny: readonly string[] | null;
  /** The only providers any route may call (lowercase provider ids). */
  providerAllow: readonly string[] | null;
  /** The minimum password length, with the common-password list on. */
  passwordMin: number | null;
}>;

const EMPTY: BoxPolicy = Object.freeze({
  telegram: null,
  modelDeny: null,
  providerAllow: null,
  passwordMin: null,
});

/** The raw values, as the box .env gives them. */
export type PolicyEnv = Readonly<{
  telegram?: string;
  modelDeny?: string;
  providerAllow?: string;
  passwordMin?: string;
}>;

function blank(v: string | undefined): boolean {
  return v === undefined || v.trim() === '';
}

function list(v: string): string[] {
  return [
    ...new Set(
      v
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
}

/** A provider id or a model pattern: letters, digits and `-_.:/@*~`. */
const PATTERN_RE = /^[a-z0-9][a-z0-9._:/@~*-]*$/;
const PROVIDER_RE = /^[a-z0-9][a-z0-9_-]*$/;

/**
 * Pure: the policy from raw values, and every problem with them. A value
 * with a problem still yields the strictest reading (Telegram off, the
 * list as far as it parsed, the floor), so a worker that boots without
 * assertEnvShape never runs looser than the operator asked.
 */
export function parsePolicy(raw: PolicyEnv): { policy: BoxPolicy; problems: string[] } {
  const problems: string[] = [];
  let telegram: BoxPolicy['telegram'] = null;
  if (!blank(raw.telegram)) {
    const v = raw.telegram!.trim().toLowerCase();
    if (v === 'off') telegram = 'off';
    else if (v !== 'on') {
      problems.push('MANTLE_POLICY_TELEGRAM must be off, on or empty');
      telegram = 'off';
    }
  }
  let modelDeny: string[] | null = null;
  if (!blank(raw.modelDeny)) {
    modelDeny = list(raw.modelDeny!);
    const bad = modelDeny.filter((p) => !PATTERN_RE.test(p));
    if (bad.length) {
      problems.push(`MANTLE_POLICY_MODEL_DENY has a pattern it cannot read: ${bad.join(', ')}`);
    }
    if (!modelDeny.length) modelDeny = null;
  }
  let providerAllow: string[] | null = null;
  if (!blank(raw.providerAllow)) {
    providerAllow = list(raw.providerAllow!);
    const bad = providerAllow.filter((p) => !PROVIDER_RE.test(p));
    if (bad.length) {
      problems.push(
        `MANTLE_POLICY_PROVIDER_ALLOW has a provider id it cannot read: ${bad.join(', ')}`,
      );
    }
    // An allow-list that parsed to nothing still allows nothing.
  }
  let passwordMin: number | null = null;
  if (!blank(raw.passwordMin)) {
    const v = raw.passwordMin!.trim();
    const n = /^\d+$/.test(v) ? Number(v) : NaN;
    if (!Number.isInteger(n) || n < DEFAULT_PASSWORD_MIN || n > MAX_PASSWORD_MIN) {
      problems.push(
        `MANTLE_POLICY_PASSWORD_MIN must be a whole number from ${DEFAULT_PASSWORD_MIN} to ${MAX_PASSWORD_MIN}`,
      );
      // The strictest reading the value allows: never below the floor.
      passwordMin = Number.isInteger(n)
        ? Math.min(Math.max(n, DEFAULT_PASSWORD_MIN), MAX_PASSWORD_MIN)
        : MAX_PASSWORD_MIN;
    } else {
      passwordMin = n;
    }
  }
  if (telegram === null && modelDeny === null && providerAllow === null && passwordMin === null) {
    return { policy: EMPTY, problems };
  }
  return {
    policy: Object.freeze({
      telegram,
      modelDeny: modelDeny ? Object.freeze(modelDeny) : null,
      providerAllow: providerAllow ? Object.freeze(providerAllow) : null,
      passwordMin,
    }),
    problems,
  };
}

function readEnv(): PolicyEnv {
  return {
    telegram: env('MANTLE_POLICY_TELEGRAM'),
    modelDeny: env('MANTLE_POLICY_MODEL_DENY'),
    providerAllow: env('MANTLE_POLICY_PROVIDER_ALLOW'),
    passwordMin: env('MANTLE_POLICY_PASSWORD_MIN'),
  };
}

let cached: { policy: BoxPolicy; problems: string[] } | null = null;

function loaded(): { policy: BoxPolicy; problems: string[] } {
  if (!cached) cached = parsePolicy(readEnv());
  return cached;
}

/** The box policy, read once per process. */
export function boxPolicy(): BoxPolicy {
  return loaded().policy;
}

/** Tests only: read the environment again on the next call. */
export function resetBoxPolicyForTests(): void {
  cached = null;
}

/** Every problem of the policy values, for the boot's assertEnvShape: a
 *  value set but malformed stops the box. */
export function policyProblems(): string[] {
  return [...loaded().problems];
}

/** At least one rule is set: the Policy panel shows, the boot check runs. */
export function policySet(): boolean {
  return boxPolicy() !== EMPTY;
}

// ── Telegram ────────────────────────────────────────────────────────────────

/** False when the policy switches Telegram off for the box. */
export function telegramAllowed(): boolean {
  return boxPolicy().telegram !== 'off';
}

/** False for a tool the box policy switches off: every `telegram_*` tool
 *  while Telegram is off. The agent's tool list (@mantle/runtime
 *  effectiveToolSlugs) and the MCP list (@mantle/mcp-core build-server)
 *  leave it out; the grant stays, so it comes back with the setting. */
export function toolPolicyAllows(slug: string): boolean {
  return telegramAllowed() || !slug.startsWith('telegram_');
}

/** What every Telegram refusal says. */
export const TELEGRAM_POLICY_OFF_MESSAGE =
  "Telegram is switched off by this box's policy (MANTLE_POLICY_TELEGRAM).";

// ── Models ──────────────────────────────────────────────────────────────────

/** Model ids that hide which model answers: an auto router picks one per
 *  call, a preset names one elsewhere. Blocked whenever a deny list is set,
 *  since nothing can tell what they will call. */
export function isAutoRouterModel(model: string): boolean {
  const m = model.trim().toLowerCase();
  if (m === 'auto' || m.endsWith('/auto') || m.endsWith(':auto')) return true;
  // OpenRouter's own ids (openrouter/auto and its kind) and presets.
  return m.startsWith('openrouter/') || m.startsWith('@preset/') || m.includes('/@preset/');
}

function globToRegExp(glob: string): RegExp {
  const body = glob
    .split('*')
    .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${body}$`);
}

/** The model's own name: after the last `/`, the `:tag` and a `~` alias
 *  mark taken off (`qwen/qwen3-8b:free` -> `qwen3-8b`). */
function bareName(model: string): string {
  const last = model.slice(model.lastIndexOf('/') + 1);
  return last.replace(/^~/, '').replace(/:.*$/, '');
}

/**
 * Whether one deny pattern matches a provider and model (both lowercase).
 * A pattern is a glob on the model id (`deepseek/deepseek-chat`,
 * `qwen/*`). A family pattern `<family>/*` also matches:
 *  - the provider of that name (`deepseek/*` blocks the direct `deepseek`
 *    provider whatever model it names);
 *  - a model id with the family as any path segment (a local server's
 *    `lmstudio-community/qwen/...`);
 *  - a bare model name that starts with the family followed by no letter
 *    (`qwen2.5:7b`, `deepseek-r1:8b` on a local server).
 */
export function denyPatternMatches(pattern: string, provider: string, model: string): boolean {
  if (globToRegExp(pattern).test(model)) return true;
  if (globToRegExp(pattern).test(`${provider}/${model}`)) return true;
  const fam = /^([a-z0-9][a-z0-9._-]*)\/\*$/.exec(pattern)?.[1];
  if (!fam) return false;
  if (provider === fam) return true;
  if (model.split('/').slice(0, -1).includes(fam)) return true;
  const bare = bareName(model);
  return bare.startsWith(fam) && !/[a-z]/.test(bare.charAt(fam.length));
}

/** A model rule is set (a deny list or a provider allow-list). */
export function modelPolicySet(): boolean {
  const p = boxPolicy();
  return p.modelDeny !== null || p.providerAllow !== null;
}

/** Why the policy refuses a provider and model, or null when it allows it.
 *  The one model check's rule (@mantle/voice model-policy.ts reads it). */
export function modelPolicyRefusal(
  provider: string,
  model: string | null | undefined,
): { rule: 'provider_allow' | 'model_deny' | 'auto_router'; message: string } | null {
  const p = boxPolicy();
  if (!p.providerAllow && !p.modelDeny) return null;
  const prov = (provider ?? '').trim().toLowerCase();
  // A leading `~` is OpenRouter's "latest of" alias: the id it names.
  const mod = (model ?? '').trim().toLowerCase().replace(/^~/, '');
  if (p.providerAllow && !p.providerAllow.includes(prov)) {
    return {
      rule: 'provider_allow',
      message: `The provider ${prov || '(none)'} is not on this box's allowed list (MANTLE_POLICY_PROVIDER_ALLOW).`,
    };
  }
  if (p.modelDeny && mod) {
    if (isAutoRouterModel(mod)) {
      return {
        rule: 'auto_router',
        message: `The model ${mod} picks its model per call, which this box's model block cannot check (MANTLE_POLICY_MODEL_DENY). Choose a named model.`,
      };
    }
    const hit = p.modelDeny.find((pat) => denyPatternMatches(pat, prov, mod));
    if (hit) {
      return {
        rule: 'model_deny',
        message: `The model ${mod} is blocked by this box's policy (MANTLE_POLICY_MODEL_DENY: ${hit}).`,
      };
    }
  }
  if (p.modelDeny && !mod && p.modelDeny.some((pat) => denyPatternMatches(pat, prov, ''))) {
    return {
      rule: 'model_deny',
      message: `The provider ${prov} is blocked by this box's policy (MANTLE_POLICY_MODEL_DENY).`,
    };
  }
  return null;
}

// ── Passwords ───────────────────────────────────────────────────────────────

/** The policy's minimum password length, or null (today's rule). */
export function passwordPolicyMin(): number | null {
  return boxPolicy().passwordMin;
}

/** Whether a login's must_change_password flag (0347) holds it now: only
 *  while the policy sets a password rule, so a box whose operator removed
 *  the rule lets every login through again, and a box that never had one
 *  never reads the flag. */
export function passwordChangeHolds(flag: boolean | null | undefined): boolean {
  return flag === true && passwordPolicyMin() !== null;
}
