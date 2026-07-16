import { readFileSync } from 'node:fs';
import { defineConfig, type Plugin } from 'vite';

// Single source of truth for the advertised version: the fixed-group core package. Every public
// @nachi-vfx package shares one version (RFC 003 §1 fixed group), so reading core keeps the docs
// site in lockstep with whatever actually shipped. The HTML carries the `__NACHI_VERSION__` token
// and this plugin stamps it at build (and dev-serve) time, so the version can never go stale in
// source again.
const nachiVersion = (
  JSON.parse(
    readFileSync(new URL('../../packages/core/package.json', import.meta.url), 'utf8'),
  ) as { version: string }
).version;

function injectNachiVersion(): Plugin {
  return {
    name: 'nachi-inject-version',
    transformIndexHtml(html) {
      return html.replaceAll('__NACHI_VERSION__', nachiVersion);
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [injectNachiVersion()],
  build: {
    rollupOptions: {
      input: {
        main: 'index.html',
        ja: 'index.ja.html',
      },
    },
  },
});
