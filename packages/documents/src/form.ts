import { InputError } from '@mantle/std';
import { MANTLE_OWNED_FIELDS } from './schemas';
import type { RouteDef } from './routes';

/**
 * A caller's options, checked: the Mantle-owned fields refused first (each
 * with why), then the route's strict schema (the first problem, in the
 * engine's own field name). The answer is what goes on the form.
 */
export function checkOptions(route: RouteDef, raw: unknown): Record<string, unknown> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new InputError('options must be an object of Gotenberg field names');
  }
  for (const key of Object.keys(raw as object)) {
    const why = MANTLE_OWNED_FIELDS[key];
    if (why) throw new InputError(`the option '${key}' is not yours to set: ${why}`);
  }
  const parsed = route.options.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path?.length ? `${issue.path.map(String).join('.')}: ` : '';
    throw new InputError(`options for ${route.key}: ${where}${issue?.message ?? 'invalid'}`);
  }
  return parsed.data;
}

/** One form value as the engine reads it: a boolean or a number as text, an
 *  array or an object as JSON, text as is. */
export function formValue(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'boolean' || typeof v === 'number') return String(v);
  return JSON.stringify(v);
}

/** The option fields onto a form, each as formValue says. */
export function appendOptions(form: FormData, options: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(options)) {
    if (v === undefined) continue;
    form.append(k, formValue(v));
  }
}
