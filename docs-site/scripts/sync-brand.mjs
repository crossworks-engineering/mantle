// Copies the MantleOS marks from ../brand (the source of truth) into the site:
// the wordmark for the header, the sun icon for the favicon.
// The copies are gitignored; never edit them, change brand/ instead.
import { copyFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const brand = new URL('../../brand/', import.meta.url);
const site = new URL('../', import.meta.url);
mkdirSync(new URL('src/assets/brand/', site), { recursive: true });
mkdirSync(new URL('public/', site), { recursive: true });
for (const f of ['mantle-logo-os.svg', 'mantle-sun-icon.svg']) {
  copyFileSync(new URL(f, brand), new URL(`src/assets/brand/${f}`, site));
}
copyFileSync(new URL('mantle-sun-icon.svg', brand), new URL('public/favicon.svg', site));
console.log(`brand: logo copied from ${fileURLToPath(brand)}`);
