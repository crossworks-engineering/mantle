import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { saveSearchLanguages } from '@mantle/content';
import { loadSearchLanguages, SEARCH_LANGUAGES_MAX } from '@mantle/search';
import { ownerCaller } from '@/lib/auth';
import { readBody } from '@/lib/read-body';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  GET: { class: 'area', area: 'settings' },
  PUT: {
    class: 'area',
    area: 'settings',
    item: { none: 'manages the settings area: the Admin step checks it' },
  },
});

/**
 * GET/PUT /api/settings/search-languages: the brain's search languages
 * (@mantle/search search-languages.ts), the extra languages a word search
 * also looks in, by the query's translation. `[]` (the default) is off.
 * The MCP tool is `search_languages`.
 */
export async function GET() {
  const user = ownerCaller();
  return NextResponse.json({
    languages: await loadSearchLanguages(user.id),
    max: SEARCH_LANGUAGES_MAX,
  });
}

const PutBody = z.object({ languages: z.array(z.string().max(40)).max(20) });

/** Set the list; a code that is not one answers 400 (InputError). */
export async function PUT(req: Request) {
  const user = ownerCaller();
  const { languages } = await readBody(req, PutBody);
  return NextResponse.json({
    languages: await saveSearchLanguages(user.id, languages),
    max: SEARCH_LANGUAGES_MAX,
  });
}
