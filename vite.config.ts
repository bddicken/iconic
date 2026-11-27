import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  // Optional, from a git-ignored .env.local: test a Worker version that has been uploaded
  // but is not serving visitors yet (staged at 0% with `wrangler versions deploy`).
  const { ICONIC_API_VERSION } = loadEnv(mode, process.cwd(), 'ICONIC_');
  return {
    server: {
      // The search API is a Cloudflare Worker backed by a database, neither of which runs
      // under `npm run dev`. Send /api/ requests to the live site instead, so search
      // behaves the same in development as in production (it is read-only).
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
