// Test entrypoint: the same Durable Objects and API as src/worker.ts, without the Astro
// page renderer (which only exists after `astro build`). Pages are covered by scripts/smoke.mjs.
import { handleApi } from '../src/server/api';
import { withSecurityHeaders } from '../src/server/security';

export { Moderation } from '../src/server/moderation';
export { Quota } from '../src/server/quota';
export { Room } from '../src/server/room';

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    if (!pathname.startsWith('/api/')) return new Response('Pages are not part of the unit tests', { status: 404 });
    return withSecurityHeaders(await handleApi(request, env, ctx));
  },
} satisfies ExportedHandler<Env>;
