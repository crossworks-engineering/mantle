/**
 * no-model-in-transaction (workspaces arch A2b, plan 4.2 and REVIEW B M6):
 * no database transaction is held across a model call or a stream. A turn
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
 * It sees direct calls only; a helper that calls a model inside is not
 * followed. Tests and migrations are out of scope.
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
    /** The open transaction callbacks around the current node. */
    const open = [];
    const enter = (node) => {
      const call = node.parent;
      if (
        call?.type === 'CallExpression' &&
        call.arguments.at(-1) === node &&
        opensTransaction(call)
      ) {
        open.push({ fn: node, tx: calleeName(call) ?? 'a transaction' });
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
      AwaitExpression(node) {
        if (!open.length) return;
        let arg = node.argument;
        while (arg?.type === 'ChainExpression') arg = arg.expression;
        if (arg?.type !== 'CallExpression') return;
        const what = modelCall(context, arg);
        if (what) context.report({ node, messageId: 'held', data: { what, tx: open.at(-1).tx } });
      },
      ForOfStatement(node) {
        if (!open.length || !node.await) return;
        context.report({
          node,
          messageId: 'held',
          data: { what: 'a stream (for await)', tx: open.at(-1).tx },
        });
      },
    };
  },
};

export default { rules: { 'no-model-in-transaction': rule } };
