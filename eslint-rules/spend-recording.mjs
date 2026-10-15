/**
 * Spend recording (A10 #5, docs/spend-recording.md): every provider call's
 * usage is written by one recorder (@mantle/tracing recordUsage) from one
 * recording point (the @mantle/voice adapter registry, which wraps every
 * capability). Two patterns are counted, and outside its named list each is
 * 0:
 *
 *  - hand spend recording: a call of the recorder or its attribution
 *    (recordUsage, captureLlmUsage, attributeUsage), or a hand addition to a
 *    usage total (`costMicroUsd +=`, `tokens.in +=` and the like). Before:
 *    three recorders called from eight files, and three hand cost sinks;
 *  - a provider call that bypasses the recording point: the contract
 *    package's unwrapped registry, the OpenRouter SDK constructed outside an
 *    adapter, or the OpenAI speech calls reached without their adapter.
 *
 * scripts/arch-scoreboard.ts pins each number; spend-recording.test.ts holds
 * each list to exactly the files that still have the pattern. The rule is the
 * editor's early warning: it flags a file outside a list.
 */
import { repoPathOf, stripComments } from './arch-counts.mjs';

/** @typedef {Record<string, string>} AllowList file -> why */

/** @type {AllowList} */
export const HAND_SPEND_ALLOWED = {
  'packages/tracing/src/spend.ts':
    'the one recorder: recordUsage, and captureLlmUsage writing through it',
  'packages/tracing/src/store.ts':
    'the attribution itself: a trace, step or prelude takes the usage from context',
  'packages/voice/src/adapters/spend.ts':
    'the recording point: each capability the registry hands out records its call',
  'packages/tools/src/builtins-research.ts':
    'the one provider call outside an adapter (the OpenRouter SDK call carries the Perplexity params): its raw usage goes through captureLlmUsage',
};

/** @type {AllowList} */
export const PROVIDER_BYPASS_ALLOWED = {
  'packages/voice/src/adapters/registry.ts':
    'the recording point: it reads the unwrapped registry to hand each adapter out wrapped',
  'packages/voice/src/adapters/openrouter-chat.ts':
    'the OpenRouter chat adapter: its calls go out through the registry wrapper',
  'packages/voice/src/adapters/openai-tts.ts':
    'the OpenAI speech adapter around synthesizeSpeech: its calls go out through the registry wrapper',
  'packages/voice/src/adapters/openai-stt.ts':
    'the OpenAI transcription adapter around transcribeAudio: its calls go out through the registry wrapper',
  'packages/tools/src/builtins-research.ts':
    'the research tool constructs the OpenRouter SDK client itself and records with captureLlmUsage',
};

/** Recorder calls and hand usage additions in `code` (comments blanked). */
export function handSpendSites(code) {
  const calls = code.match(/\b(?:recordUsage|captureLlmUsage|attributeUsage)\s*\(/g) ?? [];
  const sums = code.match(/\b(?:costMicroUsd|tokens\.(?:in|out|cacheRead))\s*\+=/g) ?? [];
  // A definition is not a call.
  const defs =
    code.match(/\bfunction\s+(?:recordUsage|captureLlmUsage|attributeUsage)\s*\(/g) ?? [];
  return calls.length - defs.length + sums.length;
}

/** Provider calls that bypass the recording point, in `code`. */
export function providerBypassSites(code) {
  const registry = code.match(/['"]@mantle\/voice-client\/adapters\/registry['"]/g) ?? [];
  const unwrapped = code.match(/\bregisteredChatAdapter\s*\(/g) ?? [];
  const sdk = code.match(/\bnew\s+OpenRouter\s*\(/g) ?? [];
  const speech = code.match(/\b(?:transcribeAudio|synthesizeSpeech)\s*\(/g) ?? [];
  const defs =
    code.match(/\bfunction\s+(?:registeredChatAdapter|transcribeAudio|synthesizeSpeech)\s*\(/g) ??
    [];
  return registry.length + unwrapped.length + sdk.length + speech.length - defs.length;
}

/** Each pattern: its counter and its named list. */
export const SPEND_PATTERNS = {
  handSpend: { count: handSpendSites, allowed: HAND_SPEND_ALLOWED },
  providerBypass: { count: providerBypassSites, allowed: PROVIDER_BYPASS_ALLOWED },
};

const MESSAGES = {
  handSpend:
    'Spend is recorded in one place: call the provider through the @mantle/voice registry (getChatAdapter, getEmbeddingAdapter, ...), which records the call on the trace and step in context. Read a total from the trace (currentTrace()), never add one by hand (docs/spend-recording.md).',
  providerBypass:
    'Reach a provider through the @mantle/voice registry (getChatAdapter, getSttAdapter, ...), whose adapters record their spend; not the unwrapped registry, the OpenRouter SDK, or the OpenAI speech calls directly (docs/spend-recording.md).',
};

function ruleFor(key) {
  const { count, allowed } = SPEND_PATTERNS[key];
  return {
    meta: {
      type: 'problem',
      docs: { description: `spend recording (A10 #5): ${key}` },
      messages: { over: MESSAGES[key] },
      schema: [],
    },
    create(context) {
      const path = repoPathOf(context.filename);
      if (!path || Object.hasOwn(allowed, path)) return {};
      return {
        Program(node) {
          if (count(stripComments(context.sourceCode.getText())) > 0) {
            context.report({ node, messageId: 'over' });
          }
        },
      };
    },
  };
}

export const rules = Object.fromEntries(Object.keys(SPEND_PATTERNS).map((k) => [k, ruleFor(k)]));

export default { rules };
