/**
 * The hosts this brain answers on (client logins, audit B25): an absolute URL
 * to one of them inside a body is read as the brain's own path, so a link to
 * a team item written as `https://<brain>/n/<id>` is redacted like `/n/<id>`
 * (client-redact.ts `clientOwnUrl`). The localhost origin is what an agent
 * wrote into stored content on a brain without a public URL (shares.ts
 * `publicBaseUrl`). Its own module so the pure redactor stays free of env.
 */
import { env } from '@mantle/config';

export function clientRedactOrigins(): string[] {
  return [env('MANTLE_PUBLIC_URL'), env('MANTLE_CLIENT_ORIGIN'), 'http://localhost:3000'].filter(
    (o): o is string => !!o,
  );
}
