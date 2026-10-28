import { env } from '@mantle/config';

/**
 * The origin a render sidecar (the browser sidecar, the documents engine)
 * uses to reach this app's render routes (/print/pages/<id>,
 * /print/draws/<id>). Never the public origin: no Caddy or TLS round trip.
 *
 *   MANTLE_PRINT_ORIGIN  prod compose: http://web:3000 (service DNS).
 *   dev default:         http://host.docker.internal:$PORT (the app runs as
 *                        native node; a sidecar container reaches the host
 *                        through its host-gateway alias).
 */
export function printOrigin(): string {
  const configured = env('MANTLE_PRINT_ORIGIN');
  if (configured) return configured.replace(/\/+$/, '');
  return `http://host.docker.internal:${env('PORT') || '3000'}`;
}
