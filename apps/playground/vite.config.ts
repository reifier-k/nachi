import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  base: './',
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
        goldenFluid: 'golden-fluid/index.html',
        goldenUltimate: 'golden-ultimate/index.html',
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
        m9Compose: 'm9-compose/index.html',
        m9Timeline: 'm9-timeline/index.html',
        m10Post: 'm10-post/index.html',
        m10Lit: 'm10-lit/index.html',
        m10Sort: 'm10-sort/index.html',
        m11Scale: 'm11-scale/index.html',
        m11Cache: 'm11-cache/index.html',
        m11Debug: 'm11-debug/index.html',
        m12Grid: 'm12-grid/index.html',
        m12Neighbors: 'm12-neighbors/index.html',
        m12Space: 'm12-space/index.html',
        reproReadback: 'repro-readback/index.html',
        spikeCompute: 'spike-compute/index.html',
        spikeDepth: 'spike-depth/index.html',
      },
    },
  },
  resolve: {
    alias: [
      {
        find: '@nachi-vfx/format',
        replacement: fileURLToPath(new URL('../../packages/format/src/index.ts', import.meta.url)),
      },
      {
        find: '@nachi-vfx/post',
        replacement: fileURLToPath(new URL('../../packages/post/src/index.ts', import.meta.url)),
      },
      {
        find: '@nachi-vfx/timeline',
        replacement: fileURLToPath(
          new URL('../../packages/timeline/src/index.ts', import.meta.url),
        ),
      },
      {
        find: '@nachi-vfx/mesh-fx',
        replacement: fileURLToPath(new URL('../../packages/mesh-fx/src/index.ts', import.meta.url)),
      },
      {
        find: '@nachi-vfx/tsl-kit/math',
        replacement: fileURLToPath(new URL('../../packages/tsl-kit/src/math.ts', import.meta.url)),
      },
      {
        find: '@nachi-vfx/tsl-kit',
        replacement: fileURLToPath(new URL('../../packages/tsl-kit/src/index.ts', import.meta.url)),
      },
      {
        find: '@nachi-vfx/trails/three',
        replacement: fileURLToPath(new URL('../../packages/trails/src/three.ts', import.meta.url)),
      },
      {
        find: '@nachi-vfx/trails',
        replacement: fileURLToPath(new URL('../../packages/trails/src/index.ts', import.meta.url)),
      },
      {
        find: '@nachi-vfx/core',
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
