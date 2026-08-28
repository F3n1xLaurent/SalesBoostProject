import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import fs from 'fs';

const outputDir = path.resolve(__dirname, '../public');
const generatedAssetsDir = path.join(outputDir, 'assets');

// Vite config for admin frontend; builds into ../public so Express can serve it as before.
export default defineConfig({
  plugins: [
    react(),
    {
      name: 'clean-generated-assets',
      apply: 'build',
      buildStart() {
        // The output directory also contains maintained favicon/manifest files,
        // so remove only Vite's generated hashed assets from previous builds.
        fs.rmSync(generatedAssetsDir, { recursive: true, force: true });
      },
    },
  ],
  root: path.resolve(__dirname),
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3000',
    },
    headers: {
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
    },
  },
  build: {
    outDir: outputDir,
    emptyOutDir: false,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
