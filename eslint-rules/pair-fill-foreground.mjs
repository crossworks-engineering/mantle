/**
 * ESLint rule: a themed fill must carry an ink that is legible on it.
 *
 * THE BUG THIS EXISTS FOR. The style guide has said "pair every fill with its
 * OWN -foreground" for months, and it shipped broken twice anyway — slash-menu
 * + mention-list (v0.205.7), then the shared CommandItem, the ⌘K palette and
 * four more call sites (v0.206.1). Both were `bg-accent` rendering
 * `text-muted-foreground`, which on many themes is near-invisible. A user found
 * it, not CI. Prose rules only work while the reader is diligent.
 *
 * WHY IT IS NARROW, ON PURPOSE. The naive check — "this className mentions
 * bg-accent and text-muted-foreground" — is almost entirely false positives.
 * The dominant idiom in this codebase is
 *
 *     text-muted-foreground hover:bg-accent hover:text-accent-foreground
 *
 * which is CORRECT: the muted ink applies to the resting state on the page
 * background, and the hover state re-pairs both tokens together. So the rule
 * resolves ink per VARIANT STATE: a `hover:bg-accent` is judged against
 * `hover:text-*` if present, and only falls through to the unprefixed ink when
 * that state sets no ink of its own.
 *
 * Three deliberate limits, per the plan's "accept false negatives" instruction:
 *   1. Only BRANDED fills are checked. `bg-card` / `bg-muted` / `bg-background`
 *      legitimately take both `text-foreground` and `text-muted-foreground`.
 *   2. Fills with an opacity modifier (`bg-destructive/5`) are skipped — a 5%
 *      tint is a different surface and muted ink on it is normal.
 *   3. Only THEMED `-foreground` inks are flagged. `text-foreground` is the
 *      strongest ink available and never the bug; `text-white` and friends are
 *      deliberate opt-outs this rule cannot reason about.
 */

/** Fills that carry their own `-foreground` and must be paired with it. */
const BRANDED_FILLS = [
  'accent',
  'primary',
  'secondary',
  'destructive',
  'success',
  'warning',
  'info',
  'sidebar-accent',
  'sidebar-primary',
];

/** Inks that are themed foregrounds — the ones a mismatch can be proven about. */
const THEMED_INKS = [
  'muted-foreground',
  'card-foreground',
  'popover-foreground',
  'accent-foreground',
  'primary-foreground',
  'secondary-foreground',
  'destructive-foreground',
  'success-foreground',
  'warning-foreground',
  'info-foreground',
  'sidebar-foreground',
  'sidebar-accent-foreground',
  'sidebar-primary-foreground',
];

const splitVariant = (token) => {
  const at = token.lastIndexOf(':');
  return at < 0
    ? { variant: '', base: token }
    : { variant: token.slice(0, at), base: token.slice(at + 1) };
};

/**
 * @param {string} classes a whitespace-separated Tailwind class string
 * @returns {Array<{ fill: string, ink: string, variant: string }>} mismatches
 */
export function findMismatches(classes) {
  const tokens = classes.split(/\s+/).filter(Boolean).map(splitVariant);

  // ink applying in each variant state, plus the unprefixed fallthrough
  const inkByVariant = new Map();
  for (const { variant, base } of tokens) {
    if (!base.startsWith('text-')) continue;
    const ink = base.slice(5).split('/')[0];
    if (THEMED_INKS.includes(ink) || ink === 'foreground') inkByVariant.set(variant, ink);
  }

  const out = [];
  for (const { variant, base } of tokens) {
    if (!base.startsWith('bg-')) continue;
    const raw = base.slice(3);
    if (raw.includes('/')) continue; // tinted fill — different surface
    if (!BRANDED_FILLS.includes(raw)) continue;

    const ink = inkByVariant.has(variant) ? inkByVariant.get(variant) : inkByVariant.get('');
    if (!ink) continue; // no themed ink in play — nothing provable
    if (ink === 'foreground') continue; // strongest ink, never the bug
    if (ink === `${raw}-foreground`) continue; // correctly paired
    if (!THEMED_INKS.includes(ink)) continue;

    out.push({ fill: raw, ink, variant });
  }
  return out;
}

/** Pull every static class-string out of className={...} / cn(...) arguments. */
function stringsFrom(node) {
  const out = [];
  const walk = (n) => {
    if (!n) return;
    if (n.type === 'Literal' && typeof n.value === 'string') out.push({ node: n, value: n.value });
    else if (n.type === 'TemplateLiteral')
      for (const q of n.quasis) out.push({ node: n, value: q.value.raw });
    else if (n.type === 'JSXExpressionContainer') walk(n.expression);
    else if (n.type === 'CallExpression') n.arguments.forEach(walk);
    else if (n.type === 'ConditionalExpression') [n.consequent, n.alternate].forEach(walk);
    else if (n.type === 'LogicalExpression') [n.left, n.right].forEach(walk);
    else if (n.type === 'ArrayExpression') n.elements.forEach(walk);
    else if (n.type === 'ObjectExpression') n.properties.forEach((p) => walk(p.key));
  };
  walk(node);
  return out;
}

export const rule = {
  meta: {
    type: 'problem',
    docs: { description: 'A themed fill must be paired with an ink that is legible on it.' },
    schema: [],
    messages: {
      mismatch:
        '`bg-{{fill}}` is paired with `text-{{ink}}`{{where}} — use `text-{{fill}}-foreground` (or `text-foreground`). ' +
        'A fill and a foreign foreground are not guaranteed any contrast; this exact shape shipped invisible text twice.',
    },
  },
  create(context) {
    const check = (node) => {
      for (const { node: strNode, value } of stringsFrom(node)) {
        for (const m of findMismatches(value)) {
          context.report({
            node: strNode,
            messageId: 'mismatch',
            data: {
              fill: m.fill,
              ink: m.ink,
              where: m.variant ? ` in the \`${m.variant}:\` state` : '',
            },
          });
        }
      }
    };
    return {
      JSXAttribute(node) {
        if (node.name?.name === 'className') check(node.value);
      },
      CallExpression(node) {
        if (node.callee?.name === 'cn' || node.callee?.name === 'clsx') check(node);
      },
    };
  },
};

/** Fills whose text form is a separate token. */
const INK_FILLS = ['primary', 'destructive', 'success', 'warning', 'info'];

export const inkRule = {
  meta: {
    type: 'problem',
    docs: { description: 'Use the -ink token for text, not the fill.' },
    fixable: 'code',
    schema: [],
    messages: {
      useInk:
        '`text-{{fill}}` is the FILL colour used as text. Use `text-{{fill}}-ink`, which is ' +
        'contrast-guaranteed on every surface in every theme. The fill is tuned to sit behind ' +
        '`text-{{fill}}-foreground` and is frequently illegible as ink — one preset rendered it ' +
        'at 1.05:1.',
    },
  },
  create(context) {
    const check = (node) => {
      for (const { node: strNode, value } of stringsFrom(node)) {
        for (const tok of value.split(/\s+/).filter(Boolean)) {
          const { base } = splitVariant(tok);
          const m = /^text-([a-z-]+?)(\/\d+)?$/.exec(base);
          if (!m || !INK_FILLS.includes(m[1])) continue;
          context.report({ node: strNode, messageId: 'useInk', data: { fill: m[1] } });
        }
      }
    };
    return {
      JSXAttribute(node) {
        if (node.name?.name === 'className') check(node.value);
      },
      CallExpression(node) {
        if (node.callee?.name === 'cn' || node.callee?.name === 'clsx') check(node);
      },
    };
  },
};

export default { rules: { 'pair-fill-foreground': rule, 'use-ink-for-text': inkRule } };
