import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    cloudflareTest({
      // Bindings, migrations and compatibility settings come from wrangler.jsonc ...
      wrangler: { configPath: './wrangler.jsonc' },
      // ... but the entrypoint skips Astro, and secrets get test values
      main: './test/worker.ts',
      miniflare: {
        bindings: {
          TURNSTILE_SITE_KEY: '',
          TURNSTILE_SECRET_KEY: '',
          ADMIN_SECRET: 'test-admin-secret',
          REPORT_TO: 'operator@example.com',
        },
      },
    }),
  ],
  test: {
    include: ['test/**/*.test.ts'],
  },
});
