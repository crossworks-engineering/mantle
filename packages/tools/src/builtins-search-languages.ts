/**
 * `search_languages`: read or set the brain's search languages (@mantle/search
 * search-languages.ts), the extra languages every word search also looks in
 * by the query's translation. The Settings screen's field over MCP (the
 * standing rule: whatever a person sets in Settings, an agent can set
 * through MCP). The same right as the screen: the settings area.
 *
 * Writes the brain's profile row in the caller's scope (saveSearchLanguages,
 * the row rule lets a scope with the Settings area write it), as
 * PUT /api/settings/search-languages does.
 */
import { saveSearchLanguages } from '@mantle/content';
import { loadSearchLanguages, SEARCH_LANGUAGES_MAX } from '@mantle/search';
import { publicErrorText } from '@mantle/std';
import { CS } from './client-sourced-rule';
import type { BuiltinToolDef, ToolHandlerResult } from './types';

export const search_languages: BuiltinToolDef = {
  slug: 'search_languages',
  mcpOnly: true,
  policy: {
    matrix: { none: 'a brain setting is not an item' },
    effect: 'write',
    spends: 'none',
    scope: { area: 'settings' },
    peerRisky: true,
    idempotent: true,
    recipe: { step: 'forbidden' },
    clientSourced: CS.always('it adds a paid translation to every new search query'),
  },
  name: 'Read or set the search languages',
  description:
    "Read or set the brain's search languages: extra languages (codes such as `es`) every word search also looks in, by a translation of the query (the Translator worker's model, cached). Use when the brain holds documents in another language that English words miss. With no argument it only reads them; `languages: []` turns it off. For translating a text or an item use `translate`.",
  inputSchema: {
    type: 'object',
    properties: {
      languages: {
        type: 'array',
        items: { type: 'string', maxLength: 40 },
        maxItems: SEARCH_LANGUAGES_MAX,
        description: 'Language codes to search in besides English, e.g. ["es"]; [] for none.',
      },
    },
  },
  handler: async (input, ctx): Promise<ToolHandlerResult> => {
    try {
      const changed = input.languages !== undefined;
      const languages = changed
        ? await saveSearchLanguages(ctx.ownerId, input.languages)
        : await loadSearchLanguages(ctx.ownerId);
      return { ok: true, output: { languages, max: SEARCH_LANGUAGES_MAX, changed } };
    } catch (err) {
      return { ok: false, error: publicErrorText(err, 'search_languages') };
    }
  },
};

/** MCP only (build-server.ts): no agent is granted it. */
export const SEARCH_LANGUAGES_TOOLS: readonly BuiltinToolDef[] = [search_languages];
