import type { IngestRule, IngestRuleThen, IngestRuleWhen } from '@mantle/db';

/**
 * Email-side input the engine matches against. Provider adapters normalize
 * their messages into something this shape can read.
 */
export interface RuleInput {
  fromAddr: string;
  toAddrs: string[];
  subject?: string;
  labels?: string[];
  hasAttachment?: boolean;
}

/** Cumulative actions to apply to the resulting `nodes` / `emails` rows. */
export interface RuleEffects {
  addTags: Set<string>;
  movePath?: string;
  routeNodeId?: string;
  markRead?: boolean;
}

function matches(when: IngestRuleWhen, input: RuleInput): boolean {
  if (when.from) {
    const needle = when.from.toLowerCase();
    if (!input.fromAddr.toLowerCase().includes(needle)) return false;
  }
  if (when.to) {
    const needle = when.to.toLowerCase();
    if (!input.toAddrs.some((a) => a.toLowerCase().includes(needle))) return false;
  }
  if (when.subjectRegex) {
    const re = new RegExp(when.subjectRegex, 'i');
    if (!input.subject || !re.test(input.subject)) return false;
  }
  if (when.label) {
    if (!input.labels?.includes(when.label)) return false;
  }
  if (when.hasAttachment !== undefined && when.hasAttachment !== !!input.hasAttachment) {
    return false;
  }
  return true;
}

function apply(into: RuleEffects, then: IngestRuleThen): void {
  for (const t of then.addTags ?? []) into.addTags.add(t);
  if (then.moveUnderPath) into.movePath = then.moveUnderPath;
  if (then.routeNodeId) into.routeNodeId = then.routeNodeId;
  if (then.markRead !== undefined) into.markRead = then.markRead;
}

/**
 * Apply all enabled rules in priority order (ascending — lower priority value
 * wins ties for tags by being last to add, but later rules override `movePath`
 * and `routeNodeId`). Rules are non-stopping by design: multiple can fire.
 */
export function runRules(rules: IngestRule[], input: RuleInput): RuleEffects {
  const effects: RuleEffects = { addTags: new Set() };
  const ordered = rules.filter((r) => r.enabled).sort((a, b) => a.priority - b.priority);
  for (const r of ordered) {
    if (matches(r.when, input)) apply(effects, r.then);
  }
  return effects;
}
