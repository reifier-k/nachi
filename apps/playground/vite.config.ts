import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        playground: 'index.html',
        m1Kernel: 'm1-kernel/index.html',
        m2Runtime: 'm2-runtime/index.html',
        spikeCompute: 'spike-compute/index.html',
        spikeDepth: 'spike-depth/index.html',
      },
    },
  },
  resolve: {
    alias: {
      '@nachi/core': fileURLToPath(new URL('../../packages/core/src/index.ts', import.meta.url)),
    },
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
  },
});
