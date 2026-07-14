import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: [
      {
        find: '@nachi-vfx/three',
        replacement: fileURLToPath(new URL('./packages/three/src/index.ts', import.meta.url)),
      },
      {
        find: '@nachi-vfx/format',
        replacement: fileURLToPath(new URL('./packages/format/src/index.ts', import.meta.url)),
      },
      {
        find: '@nachi-vfx/timeline',
        replacement: fileURLToPath(new URL('./packages/timeline/src/index.ts', import.meta.url)),
      },
      {
        find: '@nachi-vfx/mesh-fx',
        replacement: fileURLToPath(new URL('./packages/mesh-fx/src/index.ts', import.meta.url)),
      },
      {
        find: '@nachi-vfx/trails/three',
        replacement: fileURLToPath(new URL('./packages/trails/src/three.ts', import.meta.url)),
      },
      {
        find: '@nachi-vfx/trails',
        replacement: fileURLToPath(new URL('./packages/trails/src/index.ts', import.meta.url)),
      },
      {
        find: '@nachi-vfx/core',
        replacement: fileURLToPath(new URL('./packages/core/src/index.ts', import.meta.url)),
      },
    ],
  },
  test: {
    environment: 'node',
    include: ['packages/**/*.test.{ts,tsx}', 'apps/**/*.test.{ts,tsx}'],
  },
});
