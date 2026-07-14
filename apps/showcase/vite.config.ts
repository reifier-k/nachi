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
        shell: 'index.html',
        barrier: 'barrier/index.html',
        beam: 'beam/index.html',
        heal: 'heal/index.html',
        ice: 'ice/index.html',
        machina: 'machina/index.html',
        slash: 'slash/index.html',
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
    port: 5174,
    strictPort: true,
  },
});
