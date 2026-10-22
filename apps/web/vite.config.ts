import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  worker: { format: 'es' },
  build: {
    target: 'es2022',
    sourcemap: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (/i18next/.test(id)) return 'i18n';
          return 'vendor';
        },
      },
    },
  },
  server: { port: 5173 },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.tsx', 'src/**/*.test.ts'],
    setupFiles: ['src/test-setup.ts'],
    css: false,
  },
});
