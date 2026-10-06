// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import { sidebar } from './src/lib/guide.mjs';

// docs.mantle-ai.tech: a static build of the mantle repo's docs/guide tree.
export default defineConfig({
  site: 'https://docs.mantle-ai.tech',
  trailingSlash: 'always',
  integrations: [
    starlight({
      title: 'Mantle docs',
      description: 'Install, use and run Mantle, the self-hosted AI brain, and Jackdaw, the app you open it in.',
      logo: { src: './src/assets/brand/mantle-logo-full.svg', alt: 'Mantle', replacesTitle: true },
      favicon: '/favicon.svg',
      social: [
        { icon: 'github', label: 'GitHub', href: 'https://github.com/crossworks-engineering/mantle' },
      ],
      customCss: [
        '@fontsource-variable/archivo/wdth.css',
        '@fontsource/michroma/400.css',
        '@fontsource/fragment-mono/400.css',
        './src/styles/mantle.css',
      ],
      // Commands sit on a "scope" in both finishes: phosphor on dark glass.
      expressiveCode: {
        themes: ['github-dark'],
        useStarlightDarkModeSwitch: false,
        useStarlightUiThemeColors: false,
        styleOverrides: {
          borderRadius: '3px',
          borderColor: '#3a3833',
          codeFontFamily: "'Fragment Mono', ui-monospace, monospace",
          codeBackground: '#0f1a13',
          codeForeground: '#a8f291',
          frames: {
            editorBackground: '#0f1a13',
            terminalBackground: '#0f1a13',
            editorTabBarBackground: '#121210',
            terminalTitlebarBackground: '#121210',
            frameBoxShadowCssValue: 'none',
          },
        },
      },
      // The guide lives outside src/content, so name it here for Starlight's
      // Markdown plugins: `:::note` / `:::tip` asides. Heading links stay off,
      // as on the rest of the site.
      markdown: { processedDirs: ['../docs/guide'], headingLinks: false },
      sidebar: sidebar(),
      lastUpdated: false,
      pagination: true,
    }),
  ],
});
