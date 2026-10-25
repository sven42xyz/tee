// @ts-check
import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';

export default defineConfig({
  site: 'https://tee.chapter42.de',
  output: 'server',
  // No sessions (they would otherwise require a KV binding)
  session: false,
  adapter: cloudflare({ imageService: 'passthrough' }),
  devToolbar: { enabled: false },
  // Always ship CSS as files: the Content-Security-Policy allows styles from 'self' only
  build: { inlineStylesheets: 'never' },
  // qrcode is CommonJS: pre-bundle it explicitly, otherwise the dev server sometimes loads it too late
  vite: {
    optimizeDeps: { include: ['qrcode'] },
    // Never inline small scripts into the HTML: the Content-Security-Policy forbids inline scripts
    build: { assetsInlineLimit: 0 },
  },
});
