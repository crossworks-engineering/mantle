/**
 * Workspaces plan U1, V2 and V5: every writer of the rows that carry access
 * (nodes, content_chunks, content_chunk_windows, facts, item_grants) locks
 * the heads of the nodes it touches FIRST, in its own transaction. The
 * database checks that at run time (mantle.heads_check: off, warn, on); this
 * rule finds the writers before they run.
 *
 * A write counts as covered when it sits, in the same file, inside the
 * callback of one of the heads helpers of @mantle/db (HEADS_CALLEES below),
 * or inside a function whose leading comment carries `@heads-held` (the
 * caller holds the heads and passes its transaction in; say which caller;
 * the database checks it). There is no exemption marker: a migration that
 * writes these rows in bulk calls the named migration bypass, which
 * the database logs and the runner prints (0244).
 *
 * What counts as a write that needs heads:
 *  - insert or delete on any of the five tables;
 *  - update of `nodes` that sets `path` (a move), `ownerId` (a re-own is a
 *    move, 0244), `loginId` (the copies follow it) or that is not a plain
 *    object literal (unknown columns); a title or summary save does not
 *    touch access and needs no heads (plan V2);
 *  - update of `facts` that sets `sourceNodeId`; any update of the other
 *    three tables;
 *  - raw SQL that inserts into, deletes from, or moves rows of those
 *    tables, or updates content_chunks, content_chunk_windows, facts or
 *    item_grants, or MERGE INTO or COPY ... FROM into the five: a tagged
 *    template, or a string or template literal passed to `.unsafe(...)`
 *    (postgres.js) or `sql.raw(...)` (drizzle);
 *  - `.unsafe(...)` with SQL that is not a literal, outside the reviewed
 *    files (DYNAMIC_UNSAFE_REVIEWED).
 *
 * Tests and migrations are out of scope.
 */

const TABLE_IDENTS = new Set([
  'nodes',
  'contentChunks',
  'contentChunkWindows',
  'facts',
  'itemGrants',
]);

const HEADS_CALLEES = new Set([
  'withHeads',
  'withSubtreeHeads',
  'withNodeInsertHeads',
  'withNodeMoveHeads',
  'withNodeDeleteHeads',
  // In the brain it takes heads; inside a personal space (removed in W6b)
  // it writes on the space's own transaction.
  'headsOrSpace',
  // Rows of the current personal space only (throws outside withSpace); the
  // database exempts them from the heads check (0244). Removed in W6b.
  'withSpaceRows',
  // Personal-space rows written outside a space scope (checks the ids are
  // personal spaces; the database still checks any brain row). W6b.
  'onSpaceRows',
]);

const RAW_SQL_WRITE =
  /\b(insert\s+into|delete\s+from)\s+"?(public"?\."?)?"?(nodes|content_chunks|content_chunk_windows|facts|item_grants)\b|\bupdate\s+"?(public"?\."?)?"?nodes"?(\s+\w+)?\s+set\s+(?:(?!\bwhere\b)[^;])*?\b(path|owner_id|login_id)\s*=|\bupdate\s+"?(public"?\."?)?"?(content_chunks|content_chunk_windows|facts|item_grants)"?(\s+\w+)?\s+set\b|\bmerge\s+into\s+"?(public"?\."?)?"?(nodes|content_chunks|content_chunk_windows|facts|item_grants)\b|\bcopy\s+"?(public"?\."?)?"?(nodes|content_chunks|content_chunk_windows|facts|item_grants)"?\s*(\([^)]*\))?\s*from\b/i;

/** A write whose table the rule cannot read (`'delete from ' + t`,
 *  `delete from ${t}`): treated as a write to a guarded table. */
const DYNAMIC_TABLE_WRITE = /\b(insert\s+into|delete\s+from|update|merge\s+into|copy)\s+\$x\b/i;

/**
 * Files whose `.unsafe(...)` takes SQL that is not a literal, each reviewed:
 * none of them writes the guarded tables. A new dynamic `.unsafe` elsewhere
 * is an error (W1 audit, LOW 6): write the SQL as a literal or a tagged
 * template, or add the file here with its reason.
 */
// Whole-file: a NEW dynamic .unsafe added to one of these files is not checked.
const DYNAMIC_UNSAFE_REVIEWED = new Map([
  ['packages/db/src/access-matrix.ts', 'GRANT and REVOKE statements for the limited roles'],
  ['packages/db/src/viewer-roles.ts', 'CREATE and ALTER ROLE statements'],
  ['packages/db/src/init-scratch.ts', 'the scratch init SQL files'],
  ['packages/db/src/migrate.ts', 'the migration runner (migrations are out of scope)'],
  ['packages/search/src/entities.ts', 'one read query on the simple protocol'],
  ['server/api/src/bench/run.ts', 'the bench harness on its own database'],
  ['server/web/scripts/dedupe-edges.ts', 'a constant PARTITION BY fragment'],
  ['server/web/scripts/extract-backfill.ts', 'a read query'],
  ['server/web/scripts/relations-backfill.ts', 'a read query'],
  ['server/web/scripts/extract-images-backfill.ts', 'read queries'],
]);

function dynamicUnsafeReviewed(filename) {
  const f = filename.replace(/\\/g, '/');
  for (const k of DYNAMIC_UNSAFE_REVIEWED.keys()) if (f.endsWith(`/${k}`) || f === k) return true;
  return false;
}

/** Drizzle tables interpolated into raw SQL (`update ${nodes} set ...`),
 *  by the SQL name they stand for. */
const SQL_NAME = {
  nodes: 'nodes',
  contentChunks: 'content_chunks',
  contentChunkWindows: 'content_chunk_windows',
  facts: 'facts',
  itemGrants: 'item_grants',
};

export function isExempt(filename) {
  const f = filename.replace(/\\/g, '/');
  if (/\.test\.tsx?$/.test(f) || /\.db\.test\.ts$/.test(f)) return true;
  if (f.includes('/test-support') || f.includes('/__tests__/')) return true;
  if (f.includes('/migrations/')) return true;
  return false;
}

function calleeName(call) {
  const c = call.callee;
  if (c.type === 'Identifier') return c.name;
  if (c.type === 'MemberExpression' && c.property.type === 'Identifier') return c.property.name;
  return null;
}

function leadingCommentHas(context, fnNode, marker) {
  const source = context.sourceCode ?? context.getSourceCode();
  // The comment may sit on the function, or on its declaration statement
  // (export const f = async () => ...).
  let n = fnNode;
  for (let i = 0; n && i < 4; i++) {
    const comments = source.getCommentsBefore(n);
    if (comments.some((c) => c.value.includes(marker))) return true;
    n = n.parent;
    if (!n || n.type === 'Program' || n.type === 'BlockStatement') break;
  }
  return false;
}

function covered(context, node) {
  for (let p = node.parent; p; p = p.parent) {
    if (
      p.type === 'FunctionDeclaration' ||
      p.type === 'FunctionExpression' ||
      p.type === 'ArrowFunctionExpression'
    ) {
      if (leadingCommentHas(context, p, '@heads-held')) return true;
      const call = p.parent;
      if (
        call &&
        call.type === 'CallExpression' &&
        call.arguments.includes(p) &&
        HEADS_CALLEES.has(calleeName(call) ?? '')
      ) {
        return true;
      }
    }
  }
  return false;
}

/** For `.update(t).set({...})`: the keys set, or null when unknown. */
function setKeys(updateCall) {
  const member = updateCall.parent;
  if (!member || member.type !== 'MemberExpression') return null;
  if (member.property.type !== 'Identifier' || member.property.name !== 'set') return null;
  const setCall = member.parent;
  if (!setCall || setCall.type !== 'CallExpression') return null;
  return objectKeys(setCall.arguments[0]);
}

/** The keys an object literal can set, following spreads of literals
 *  (`...(x ? { a } : {})`); null when any key is unknown. */
function objectKeys(expr) {
  if (!expr) return null;
  if (expr.type === 'ConditionalExpression') {
    const a = objectKeys(expr.consequent);
    const b = objectKeys(expr.alternate);
    return a && b ? [...a, ...b] : null;
  }
  if (expr.type === 'LogicalExpression') {
    // `...(cond && { a })`: the right side, or nothing.
    return objectKeys(expr.right);
  }
  if (expr.type !== 'ObjectExpression') return null;
  const keys = [];
  for (const prop of expr.properties) {
    if (prop.type === 'SpreadElement') {
      const inner = objectKeys(prop.argument);
      if (!inner) return null;
      keys.push(...inner);
      continue;
    }
    if (prop.type !== 'Property' || prop.computed) return null;
    if (prop.key.type === 'Identifier') keys.push(prop.key.name);
    else if (prop.key.type === 'Literal') keys.push(String(prop.key.value));
    else return null;
  }
  return keys;
}

function needsHeads(op, table, call) {
  if (op === 'insert' || op === 'delete') return true;
  // update
  if (table === 'nodes') {
    const keys = setKeys(call);
    return (
      keys === null || keys.includes('path') || keys.includes('ownerId') || keys.includes('loginId')
    );
  }
  if (table === 'facts') {
    const keys = setKeys(call);
    return keys === null || keys.includes('sourceNodeId');
  }
  return true;
}

/** The text of a string or untagged template literal (interpolations as
 *  placeholders); null for anything else. */
function literalText(arg) {
  if (!arg) return null;
  if (arg.type === 'Literal' && typeof arg.value === 'string') return arg.value;
  if (arg.type === 'TemplateLiteral') {
    return arg.quasis.map((q) => q.value.cooked ?? q.value.raw).join(' $x ');
  }
  // `'...' + '...'` of literals (a conditional suffix reads as a placeholder).
  if (arg.type === 'BinaryExpression' && arg.operator === '+') {
    const l = literalText(arg.left);
    const r = literalText(arg.right);
    if (l === null && r === null) return null;
    return `${l ?? ' $x '}${r ?? ' $x '}`;
  }
  return null;
}

/** Whether `name`, seen at `node`, is bound by an import declaration. */
function isImported(context, node, name) {
  const source = context.sourceCode ?? context.getSourceCode();
  let scope = source.getScope ? source.getScope(node) : context.getScope();
  for (; scope; scope = scope.upper) {
    const v = scope.set.get(name);
    if (v) return v.defs.some((d) => d.type === 'ImportBinding');
  }
  return false;
}

export const rule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Writers of nodes, chunks, windows, facts and item grants lock heads first (withHeads).',
    },
    messages: {
      dynamicUnsafe:
        'This passes SQL the heads rule cannot read to .unsafe(). Write it as a literal or a tagged template, or add the file to DYNAMIC_UNSAFE_REVIEWED in eslint-rules/heads-writers.mjs with its reason (it must not write nodes, chunks, windows, facts or grants).',
      noHeads:
        "This writes {{what}} without heads. Wrap the transaction in withHeads(...) or withSubtreeHeads(...) from @mantle/db (plan U1), or mark the function '@heads-held' when its caller holds them.",
    },
    schema: [],
  },
  create(context) {
    if (isExempt(context.filename)) return {};
    return {
      CallExpression(node) {
        const name = calleeName(node);
        if (name !== 'insert' && name !== 'update' && name !== 'delete') return;
        if (node.callee.type !== 'MemberExpression') return;
        const arg = node.arguments[0];
        if (!arg || arg.type !== 'Identifier' || !TABLE_IDENTS.has(arg.name)) return;
        if (!needsHeads(name, arg.name, node)) return;
        if (covered(context, node)) return;
        context.report({ node, messageId: 'noHeads', data: { what: `${name}(${arg.name})` } });
      },
      // Raw strings: postgres.js `.unsafe('...')` and drizzle `sql.raw('...')`.
      'CallExpression:exit'(node) {
        const name = calleeName(node);
        if (name !== 'unsafe' && name !== 'raw') return;
        if (node.callee.type !== 'MemberExpression') return;
        const text = literalText(node.arguments[0]);
        if (text === null) {
          // SQL this rule cannot read: only reviewed files may pass it to
          // postgres.js (a heads helper around it does not tell what it does).
          if (name === 'unsafe' && node.arguments[0] && !dynamicUnsafeReviewed(context.filename)) {
            context.report({ node, messageId: 'dynamicUnsafe' });
          }
          return;
        }
        if (!RAW_SQL_WRITE.test(text) && !DYNAMIC_TABLE_WRITE.test(text)) return;
        if (covered(context, node)) return;
        context.report({ node, messageId: 'noHeads', data: { what: `raw SQL (.${name})` } });
      },
      TaggedTemplateExpression(node) {
        // Interpolated tables read as their SQL names; any other value as a
        // placeholder that matches nothing.
        const parts = [];
        node.quasi.quasis.forEach((q, i) => {
          parts.push(q.value.cooked ?? q.value.raw);
          const e = node.quasi.expressions[i];
          if (!e) return;
          if (e.type === 'Identifier' && SQL_NAME[e.name]) parts.push(SQL_NAME[e.name]);
          // An imported binding is a Drizzle table of another name
          // (`update ${recallNodes} set ...`); anything else (a local string,
          // a call) is a table the rule cannot read.
          else if (e.type === 'Identifier' && isImported(context, node, e.name)) {
            parts.push(` ${e.name} `);
          } else parts.push(' $x ');
        });
        const text = parts.join('');
        if (!RAW_SQL_WRITE.test(text) && !DYNAMIC_TABLE_WRITE.test(text)) return;
        if (covered(context, node)) return;
        context.report({ node, messageId: 'noHeads', data: { what: 'raw SQL' } });
      },
    };
  },
};

export default { rules: { 'heads-writers': rule } };
