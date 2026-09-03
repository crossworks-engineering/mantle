import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertPublishable,
  findPrivateDeps,
  NPM_SCOPE,
  PACKAGES,
  stageManifest,
} from '../../../scripts/publish-contract.mjs';

/**
 * The publish gate for the @crossworks contract packages. npm versions are
 * immutable: the v0.232.122-153 app-build tarballs shipped
 * "@mantle/config": "0.0.1" and "@mantle/std": "0.0.1" (private workspace
 * names that do not exist on npm) and can never be fixed in place.
 *
 * Two halves are pinned here. The alias pass must keep the deliberate
 * @mantle/<sibling> -> npm:@crossworks/<sibling>@<version> shape (the KEY
 * stays, because the shipped TS source imports that name), and anything else
 * under @mantle/* must be refused BEFORE a publish, naming the package and the
 * dependency. The last block runs the gate over the real manifests, so a
 * private dep added to any contract package fails in build-check, before a
 * tag exists, not in a consumer's install after the version is immutable.
 */
const ROOT = join(__dirname, '..', '..', '..');
const VERSION = '1.2.3';

const stage = (pkg: string, manifest: Record<string, unknown>) =>
  stageManifest(manifest, { pkg, version: VERSION });

describe('stageManifest', () => {
  it('renames to the public scope, stamps the version and drops private', () => {
    const input = { name: '@mantle/client-types', version: '0.0.1', private: true };
    const out = stage('client-types', input);
    expect(out.name).toBe(`${NPM_SCOPE}/client-types`);
    expect(out.version).toBe(VERSION);
    expect(out.private).toBeUndefined();
    expect(out.repository.url).toContain('github.com/crossworks-engineering/mantle');
    // Pure: the workspace manifest object is untouched.
    expect(input).toEqual({ name: '@mantle/client-types', version: '0.0.1', private: true });
  });

  it('keeps the @mantle/* KEY for sibling contract packages and aliases only the spec', () => {
    const out = stage('share-ui', {
      name: '@mantle/share-ui',
      version: '0.0.1',
      dependencies: {
        '@mantle/client-types': 'workspace:*',
        '@mantle/content-core': 'workspace:*',
        clsx: '^2.1.1',
      },
      peerDependencies: { react: '^19.2.7' },
    });
    expect(out.dependencies).toEqual({
      '@mantle/client-types': `npm:${NPM_SCOPE}/client-types@${VERSION}`,
      '@mantle/content-core': `npm:${NPM_SCOPE}/content-core@${VERSION}`,
      clsx: '^2.1.1',
    });
    expect(out.peerDependencies).toEqual({ react: '^19.2.7' });
    expect(findPrivateDeps(out)).toEqual([]);
  });

  it('leaves a non-contract workspace dep untouched for the gate to refuse', () => {
    // It must never be rewritten into something that looks resolvable.
    const out = stage('app-build', {
      name: '@mantle/app-build',
      version: '0.0.1',
      dependencies: { '@mantle/config': 'workspace:*', '@mantle/share-ui': 'workspace:*' },
    });
    expect(out.dependencies['@mantle/config']).toBe('workspace:*');
    expect(out.dependencies['@mantle/share-ui']).toBe(`npm:${NPM_SCOPE}/share-ui@${VERSION}`);
    expect(findPrivateDeps(out).map((b) => b.dep)).toEqual(['@mantle/config']);
  });
});

describe('findPrivateDeps / assertPublishable', () => {
  it('refuses the exact shape the broken app-build tarballs shipped, naming package and deps', () => {
    const staged = {
      name: `${NPM_SCOPE}/app-build`,
      version: VERSION,
      dependencies: { '@mantle/config': '0.0.1', '@mantle/std': '0.0.1', esbuild: '^0.28.1' },
    };
    expect(findPrivateDeps(staged).map((b) => b.dep)).toEqual(['@mantle/config', '@mantle/std']);
    const boom = () => assertPublishable(staged);
    expect(boom).toThrow(`${NPM_SCOPE}/app-build@${VERSION} is NOT publishable: 2 dependencies`);
    expect(boom).toThrow('"@mantle/config": "0.0.1"');
    expect(boom).toThrow('"@mantle/std": "0.0.1"');
    expect(boom).not.toThrow('esbuild');
  });

  it('checks every dependency section and every bad shape', () => {
    const staged = {
      name: `${NPM_SCOPE}/x`,
      version: VERSION,
      dependencies: { '@mantle/config': 'workspace:*', ok: '^1.0.0' },
      peerDependencies: { renamed: '@mantle/std' },
      optionalDependencies: { aliased: 'npm:@mantle/std@1.0.0' },
      devDependencies: { 'left-pad': 'workspace:*' },
    };
    expect(findPrivateDeps(staged).map((b) => `${b.section} ${b.dep}`)).toEqual([
      'dependencies @mantle/config',
      'peerDependencies renamed',
      'optionalDependencies aliased',
      'devDependencies left-pad',
    ]);
  });

  it('requires the sibling alias to target the public scope', () => {
    const staged = {
      name: `${NPM_SCOPE}/share-ui`,
      version: VERSION,
      dependencies: { '@mantle/client-types': `npm:@mantle/client-types@${VERSION}` },
    };
    expect(findPrivateDeps(staged)).toHaveLength(1);
    expect(() => assertPublishable(staged)).toThrow('@mantle/client-types');
  });

  it('passes a clean manifest', () => {
    expect(() =>
      assertPublishable({
        name: `${NPM_SCOPE}/content-core`,
        version: VERSION,
        dependencies: { '@mantle/client-types': `npm:${NPM_SCOPE}/client-types@${VERSION}` },
        devDependencies: { '@types/node': '^26.4.0' },
      }),
    ).not.toThrow();
    expect(() =>
      assertPublishable({ name: `${NPM_SCOPE}/voice-client`, version: VERSION }),
    ).not.toThrow();
  });
});

describe('the real contract manifests', () => {
  for (const pkg of PACKAGES) {
    it(`packages/${pkg} stages to a publishable manifest`, () => {
      const manifest = JSON.parse(
        readFileSync(join(ROOT, 'packages', pkg, 'package.json'), 'utf8'),
      );
      expect(() => assertPublishable(stage(pkg, manifest))).not.toThrow();
    });
  }
});
