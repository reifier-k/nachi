import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  plugins: [
    {
      name: 'favicon-no-content',
      configureServer(server) {
        server.middlewares.use((request, response, next) => {
          if (request.url !== '/favicon.ico') {
            next();
            return;
          }
          response.statusCode = 204;
          response.end();
        });
      },
    },
  ],
  build: {
    rollupOptions: {
      input: {
        goldenExplosion: 'golden-explosion/index.html',
        goldenAmbient: 'golden-ambient/index.html',
        goldenCharacter: 'golden-character/index.html',
        goldenCharge: 'golden-charge/index.html',
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
        m8MeshFx: 'm8-meshfx/index.html',
        m8Vat: 'm8-vat/index.html',
        spikeCompute: 'spike-compute/index.html',
        spikeDepth: 'spike-depth/index.html',
      },
    },
  },
  resolve: {
    alias: [
      {
        find: '@nachi/mesh-fx',
        replacement: fileURLToPath(new URL('../../packages/mesh-fx/src/index.ts', import.meta.url)),
      },
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
