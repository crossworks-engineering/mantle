/**
 * actor-setters-in-db-only (workspaces arch plan v2, sections 4.2 and 11;
 * A2a): only packages/db sets who a statement runs as. Anywhere else, a
 * string that names the actor settings (mantle.actor, mantle.write_mode,
 * mantle.actor_check) or their setter functions (mantle_set_actor,
 * mantle_operator_actor) is refused. Code binds an actor with the
 * TypeScript API instead (runAsActor, runAsSystem from @mantle/db), and
 * packages/db/src/gateway/actor-sql.ts sets the settings.
 *
 * Not a secret: any role can set a mantle.* setting. The protection is this
 * lint, the runtime role (A9) and the read predicate on the write role
 * (plan 20.1, 20.3 item 6). Tests may set them (the matrix does).
 */
export const ACTOR_SETTER_PATTERN =
  /\bmantle_set_actor\b|\bmantle_operator_actor\b|\bmantle\.(actor|write_mode|actor_check)\b/;

/** Whether `filename` may name the actor settings. */
export function mayNameActorSetters(filename) {
  const f = filename.replace(/\\/g, '/');
  if (/\.test\.tsx?$/.test(f)) return true;
  return f.includes('/packages/db/src/') || f.startsWith('packages/db/src/');
}

export const rule = {
  meta: {
    type: 'problem',
    docs: { description: 'Only packages/db sets the actor settings (plan v2, section 11).' },
    messages: {
      notHere:
        'Only packages/db sets mantle.actor and mantle.write_mode (arch A2a). Bind an actor with runAsActor or runAsSystem from @mantle/db instead.',
    },
    schema: [],
  },
  create(context) {
    if (mayNameActorSetters(context.filename)) return {};
    const check = (node, text) => {
      if (typeof text === 'string' && ACTOR_SETTER_PATTERN.test(text)) {
        context.report({ node, messageId: 'notHere' });
      }
    };
    return {
      Literal(node) {
        check(node, node.value);
      },
      TemplateElement(node) {
        check(node, node.value.cooked ?? node.value.raw);
      },
    };
  },
};

export default { rules: { 'actor-setters-in-db-only': rule } };
