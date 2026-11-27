import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  // Optional, from a git-ignored .env.local: test a Worker version that has been uploaded
  // but is not serving visitors yet (staged at 0% with `wrangler versions deploy`).
  const { ICONIC_API_VERSION } = loadEnv(mode, process.cwd(), 'ICONIC_');
  return {
    server: {
      // The API (landmarks and search) is a Cloudflare Worker backed by a database, neither
      // of which runs under `npm run dev`. Send /api/ requests to the live site instead, so
      // development shows what production shows (the API is read-only). `npm run dev:local`
      // reads landmarks from public/data/landmarks.json instead, to preview ones that have
      // been built here but not deployed.
      proxy: {
        '/api': {
          target: 'https://iconic.place',
          changeOrigin: true,
          headers: ICONIC_API_VERSION ? { 'Cloudflare-Workers-Version-Overrides': `iconic="${ICONIC_API_VERSION}"` } : undefined,
        },
      },
    },
  };
});
