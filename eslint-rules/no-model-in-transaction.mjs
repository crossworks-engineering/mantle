/**
 * no-model-in-transaction: no database transaction is held across a model
 * call or a stream. A turn
 * waits seconds on a model; a transaction open that long holds its
 * connection and its locks (the heads) for all of it, and the pool runs
 * dry as users grow. Read and write before and after the call, each in its
 * own short transaction.
 *
 * A transaction is the callback of a call that opens one: `.transaction(`
 * (drizzle), `.begin(` (postgres.js), withSystemTx, withScope,
 * readTransaction, withSpace, and the heads helpers (HEADS_CALLEES of
 * heads-writers.mjs, not copied). Inside it, this rule flags:
 *  - `await` of a model call: a method of a model dispatcher (each method
 *    of an interface that extends AdapterMeta in
 *    packages/voice-client/src/adapters/types.ts, read from that file, not
 *    copied), or a function imported from a package that calls models
 *    (MODEL_MODULES);
 *  - `await fetch(...)`: a network call;
 *  - `for await (...)`: a stream read to its end.
 * It also sees a model call returned from the callback, one stored in a
 * name and awaited later, one inside Promise.all (allSettled, race, any)
 * and one at the root of a .then chain. A for-await over a postgres.js
 * `.cursor()` reads the transaction's own rows and is allowed. No type
 * information: a dispatcher method is matched by its name on any receiver
 * (a false match only asks for a look), and a helper that calls a model
 * inside is not followed. Tests and migrations are out of scope.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { HEADS_CALLEES, isExempt } from './heads-writers.mjs';

/** The packages whose exported functions call a model: the embedder and
 *  the provider adapters (speech, chat, vision, images, decisions). */
const MODEL_MODULES = new Set(['@mantle/embeddings', '@mantle/voice', '@mantle/voice-client']);

/** Functions that open a transaction and run their last argument in it. */
const TX_CALLEES = new Set([
  ...HEADS_CALLEES,
  'withSystemTx',
  'withScope',
  'readTransaction',
  'withSpace',
]);

/** Member calls that open one: drizzle's db.transaction, postgres.js sql.begin. */
const TX_METHODS = new Set(['transaction', 'begin']);

/** The methods of the model dispatchers that return a promise (the calls
 *  that reach a provider), read from their interfaces. */
export function dispatcherMethods(text) {
  const out = new Set();
  const iface = /export interface \w+ extends AdapterMeta \{([\s\S]*?)\n\}/g;
  for (let m = iface.exec(text); m; m = iface.exec(text)) {
    const body = m[1];
    const meth = /^ {2}(\w+)\??\(/gm;
    for (let x = meth.exec(body); x; x = meth.exec(body)) {
      const end = body.indexOf(';', x.index);
      if (body.slice(x.index, end < 0 ? undefined : end).includes('Promise<')) out.add(x[1]);
    }
  }
  return out;
}

const TYPES_FILE = fileURLToPath(
  new URL('../packages/voice-client/src/adapters/types.ts', import.meta.url),
);
export const DISPATCHER_METHODS = dispatcherMethods(readFileSync(TYPES_FILE, 'utf8'));

function calleeName(call) {
  const c = call.callee;
  if (c.type === 'Identifier') return c.name;
  if (c.type === 'MemberExpression' && !c.computed && c.property.type === 'Identifier') {
    return c.property.name;
  }
  return null;
}

/** Whether `call` opens a transaction around a function argument. */
function opensTransaction(call) {
  const last = call.arguments[call.arguments.length - 1];
  if (!last || (last.type !== 'ArrowFunctionExpression' && last.type !== 'FunctionExpression')) {
    return false;
  }
  if (call.callee.type === 'Identifier') return TX_CALLEES.has(call.callee.name);
  const name = calleeName(call);
  return name !== null && (TX_CALLEES.has(name) || TX_METHODS.has(name));
}

/** The module `name` is imported from at `node`, or null. */
function importSource(context, node, name) {
  const source = context.sourceCode ?? context.getSourceCode();
  for (let scope = source.getScope(node); scope; scope = scope.upper) {
    const v = scope.set.get(name);
    if (!v) continue;
    const def = v.defs.find((d) => d.type === 'ImportBinding');
    return def ? def.parent.source.value : null;
  }
  return null;
}

/** What kind of model call `call` is, or null. */
function modelCall(context, call) {
  const c = call.callee;
  if (c.type === 'Identifier') {
    if (c.name === 'fetch') return 'fetch';
    const from = importSource(context, call, c.name);
    if (from && MODEL_MODULES.has(from)) return `${c.name} (${from})`;
    return null;
  }
  if (c.type === 'MemberExpression' && !c.computed && c.property.type === 'Identifier') {
    if (DISPATCHER_METHODS.has(c.property.name)) return `.${c.property.name}()`;
    // A namespace import: embeddings.embed(...).
    if (c.object.type === 'Identifier') {
      const from = importSource(context, call, c.object.name);
      if (from && MODEL_MODULES.has(from)) return `${c.object.name}.${c.property.name} (${from})`;
    }
  }
  return null;
}

/** Promise combinators whose array argument the transaction then waits for. */
const COMBINATORS = new Set(['all', 'allSettled', 'race', 'any']);

/**
 * What model call `expr` waits on, or null: a model call itself, one at
 * the root of a `.then`/`.catch`/`.finally` chain, one inside the array of
 * Promise.all (allSettled, race, any), or a name bound to one earlier in
 * the transaction (`pending`). Cheap shapes only: no data flow beyond that.
 */
function heldCall(context, expr, pending) {
  let e = expr;
  while (e?.type === 'ChainExpression') e = e.expression;
  if (!e) return null;
  if (e.type === 'Identifier') return pending.get(e.name) ?? null;
  if (e.type !== 'CallExpression') return null;
  const direct = modelCall(context, e);
  if (direct) return direct;
  const c = e.callee;
  if (c.type === 'MemberExpression' && !c.computed && c.property.type === 'Identifier') {
    if (['then', 'catch', 'finally'].includes(c.property.name)) {
      return heldCall(context, c.object, pending);
    }
    if (
      c.object.type === 'Identifier' &&
      c.object.name === 'Promise' &&
      COMBINATORS.has(c.property.name) &&
      e.arguments[0]?.type === 'ArrayExpression'
    ) {
      for (const el of e.arguments[0].elements) {
        const w = heldCall(context, el, pending);
        if (w) return w;
      }
    }
  }
  return null;
}

/** A for-await over a postgres.js cursor reads rows of the transaction
 *  itself, not a stream from outside. */
function isCursorLoop(node) {
  let r = node.right;
  while (r?.type === 'ChainExpression') r = r.expression;
  return (
    r?.type === 'CallExpression' &&
    r.callee.type === 'MemberExpression' &&
    !r.callee.computed &&
    r.callee.property.type === 'Identifier' &&
    r.callee.property.name === 'cursor'
  );
}

export const rule = {
  meta: {
    type: 'problem',
    docs: { description: 'No database transaction is held across a model call or a stream.' },
    messages: {
      held: 'This awaits {{what}} inside a database transaction ({{tx}}): the transaction holds its connection and locks for the whole call. Read or write before and after it, each in its own short transaction (plan 4.2).',
    },
    schema: [],
  },
  create(context) {
    if (isExempt(context.filename)) return {};
    /** The open transaction callbacks around the current node, each with
     *  the names bound to a model call inside it. */
    const open = [];
    const report = (node, what) =>
      context.report({ node, messageId: 'held', data: { what, tx: open.at(-1).tx } });
    const pending = () => open.at(-1).pending;
    const enter = (node) => {
      const call = node.parent;
      if (
        call?.type === 'CallExpression' &&
        call.arguments.at(-1) === node &&
        opensTransaction(call)
      ) {
        open.push({ fn: node, tx: calleeName(call) ?? 'a transaction', pending: new Map() });
        // `async (tx) => adapter.chat(o)`: the transaction returns the call.
        if (node.body.type !== 'BlockStatement') {
          const what = heldCall(context, node.body, pending());
          if (what) report(node.body, what);
        }
      }
    };
    const leave = (node) => {
      if (open.at(-1)?.fn === node) open.pop();
    };
    return {
      ArrowFunctionExpression: enter,
      FunctionExpression: enter,
      'ArrowFunctionExpression:exit': leave,
      'FunctionExpression:exit': leave,
      VariableDeclarator(node) {
        if (!open.length || node.id.type !== 'Identifier' || !node.init) return;
        const what = heldCall(context, node.init, pending());
        if (what) pending().set(node.id.name, what);
      },
      AwaitExpression(node) {
        if (!open.length) return;
        const what = heldCall(context, node.argument, pending());
        if (what) report(node, what);
      },
      ReturnStatement(node) {
        if (!open.length || !node.argument) return;
        // Only the transaction callback's own return: it hands the promise
        // to the transaction, which waits for it.
        let fn = node.parent;
        while (fn && !/Function/.test(fn.type)) fn = fn.parent;
        if (fn !== open.at(-1).fn) return;
        const what = heldCall(context, node.argument, pending());
        if (what) report(node, what);
      },
      ForOfStatement(node) {
        if (!open.length || !node.await || isCursorLoop(node)) return;
        report(node, 'a stream (for await)');
      },
    };
  },
};

export default { rules: { 'no-model-in-transaction': rule } };
