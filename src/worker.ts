import { handle } from '@astrojs/cloudflare/handler';
import { handleApi } from './server/api';
import { withSecurityHeaders } from './server/security';

export { Moderation } from './server/moderation';
export { Quota } from './server/quota';
export { Room } from './server/room';

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    const response = pathname.startsWith('/api/') ? await handleApi(request, env, ctx) : await handle(request, env, ctx);
    return withSecurityHeaders(response, import.meta.env.DEV);
  },
} satisfies ExportedHandler<Env>;
