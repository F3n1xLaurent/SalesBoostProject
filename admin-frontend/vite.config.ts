import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { sentryVitePlugin } from '@sentry/vite-plugin';
import path from 'path';
import fs from 'fs';

const outputDir = path.resolve(__dirname, '../public');
const generatedAssetsDir = path.join(outputDir, 'assets');

// Vite config for admin frontend; builds into ../public so Express can serve it as before.
export default defineConfig(({ mode }) => {
  const rootEnv = loadEnv(mode, path.resolve(__dirname, '..'), '');
  const readEnv = (name: string) => process.env[name]?.trim() || rootEnv[name]?.trim() || '';
  const sentryDsn = readEnv('SENTRY_FRONTEND_DSN');
  const sentryOrg = readEnv('SENTRY_ORG');
  const sentryProject = readEnv('SENTRY_FRONTEND_PROJECT');
  const sentryAuthToken = readEnv('SENTRY_AUTH_TOKEN');
  const sentryEnvironment = readEnv('SENTRY_ENVIRONMENT') || (mode === 'production' ? 'production' : 'development');
  const sentryRelease = readEnv('SENTRY_RELEASE');
  const tracesSampleRate = Number(readEnv('SENTRY_TRACES_SAMPLE_RATE'));
  const uploadSourceMaps = readEnv('SENTRY_UPLOAD_SOURCEMAPS').toLowerCase() === 'true'
    && Boolean(sentryOrg && sentryProject && sentryAuthToken);

  return {
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
      ...(uploadSourceMaps ? [sentryVitePlugin({
        org: sentryOrg,
        project: sentryProject,
        authToken: sentryAuthToken,
        telemetry: false,
        ...(sentryRelease ? { release: { name: sentryRelease } } : {}),
        sourcemaps: { filesToDeleteAfterUpload: [`${outputDir}/assets/**/*.map`] },
      })] : []),
    ],
    define: {
      __SENTRY_FRONTEND_DSN__: JSON.stringify(sentryDsn),
      __SENTRY_ENVIRONMENT__: JSON.stringify(sentryEnvironment),
      __SENTRY_RELEASE__: JSON.stringify(sentryRelease),
      __SENTRY_TRACES_SAMPLE_RATE__: JSON.stringify(Number.isFinite(tracesSampleRate) ? Math.max(0, Math.min(1, tracesSampleRate)) : 0.1),
    },
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
      sourcemap: uploadSourceMaps ? 'hidden' : false,
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },
  };
});
