import { defineConfig } from 'vite';

export default defineConfig(({ command }) => ({
  base: command === 'build' ? '/equation_editor/' : '/',
  build: {
    outDir: 'dist',
  },
  server: {
    port: 5173,
  }
}));
