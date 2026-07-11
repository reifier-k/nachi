import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: [
      {
        find: '@nachi/trails/three',
        replacement: fileURLToPath(new URL('./packages/trails/src/three.ts', import.meta.url)),
      },
      {
        find: '@nachi/trails',
        replacement: fileURLToPath(new URL('./packages/trails/src/index.ts', import.meta.url)),
      },
      {
        find: '@nachi/core',
        replacement: fileURLToPath(new URL('./packages/core/src/index.ts', import.meta.url)),
      },
    ],
  },
  test: {
    environment: 'node',
    include: ['packages/**/*.test.ts', 'apps/**/*.test.ts'],
  },
});
