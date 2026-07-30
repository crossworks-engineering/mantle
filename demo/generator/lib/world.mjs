// Loads the world bible + targets. The bible is the ONLY source of names,
// companies, projects and domains — content modules must draw from here.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const worldDir = join(here, '..', '..', 'world');

export const world = JSON.parse(readFileSync(join(worldDir, 'world.json'), 'utf8'));
export const targets = JSON.parse(readFileSync(join(worldDir, 'targets.json'), 'utf8'));

const byId = (arr) => Object.fromEntries(arr.map((x) => [x.id, x]));
export const people = byId(world.people);
export const companies = byId(world.companies);
export const projects = byId(world.projects);
export const owner = world.owner;

export const person = (id) => {
  const p = id === owner.id ? owner : people[id];
  if (!p) throw new Error(`world: unknown person '${id}'`);
  return p;
};
export const first = (id) => person(id).name.split(' ')[0];
export const staff = world.people.filter((p) => p.company === 'harbour-labs');
export const clientsOf = (companyId) => world.people.filter((p) => p.company === companyId);
export const timeline = world.timeline;
export const SPAN = world.timeline.span; // [-180, 21]

export function assertOffset(off) {
  if (off < SPAN[0] || off > SPAN[1]) throw new Error(`offset ${off} outside span ${SPAN}`);
  return off;
}
