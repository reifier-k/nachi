import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        goldenExplosion: 'golden-explosion/index.html',
        goldenAmbient: 'golden-ambient/index.html',
        goldenCharacter: 'golden-character/index.html',
        goldenSlash: 'golden-slash/index.html',
        playground: 'index.html',
        m1Kernel: 'm1-kernel/index.html',
        m2Runtime: 'm2-runtime/index.html',
        m3Sprites: 'm3-sprites/index.html',
        m4Behaviors: 'm4-behaviors/index.html',
        m5Events: 'm5-events/index.html',
        m6Collision: 'm6-collision/index.html',
        m7Ribbons: 'm7-ribbons/index.html',
        m8TslKit: 'm8-tslkit/index.html',
        spikeCompute: 'spike-compute/index.html',
        spikeDepth: 'spike-depth/index.html',
      },
    },
  },
  resolve: {
    alias: [
      {
        find: '@nachi/tsl-kit/math',
        replacement: fileURLToPath(new URL('../../packages/tsl-kit/src/math.ts', import.meta.url)),
      },
      {
        find: '@nachi/tsl-kit',
        replacement: fileURLToPath(new URL('../../packages/tsl-kit/src/index.ts', import.meta.url)),
      },
      {
        find: '@nachi/trails/three',
        replacement: fileURLToPath(new URL('../../packages/trails/src/three.ts', import.meta.url)),
      },
      {
        find: '@nachi/trails',
        replacement: fileURLToPath(new URL('../../packages/trails/src/index.ts', import.meta.url)),
      },
      {
        find: '@nachi/core',
        replacement: fileURLToPath(new URL('../../packages/core/src/index.ts', import.meta.url)),
      },
    ],
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
  },
});
