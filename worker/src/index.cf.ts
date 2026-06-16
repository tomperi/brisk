import { createApp } from './app';
import { buildCloudflarePlatform } from './platform/cloudflare/platform';

export { SiteRoom } from './room';

export default createApp((c) => buildCloudflarePlatform(c.env, c.executionCtx));
