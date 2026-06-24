import type { Env } from '../../env';

/** Build the typed instance config from process.env. Mirrors the Cloudflare
 *  binding shape so handlers read c.env.X unchanged. Fail-fast on the same
 *  misconfigurations the worker rejects at request time, but at boot. */
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): Env {
  const auth = env.AUTH as Env['AUTH'] | undefined;
  if (auth === 'google' && !env.SESSION_SECRET) {
    throw new Error('AUTH=google requires SESSION_SECRET');
  }
  return {
    // Cloudflare bindings are absent on Node; the platform provides those
    // capabilities via the Platform object, not via c.env. We cast because the
    // Env type names them, but no handler reads c.env.DB/BUCKET/ROOMS/ASSETS
    // (Phase 1 routed all of those through c.var.platform).
    DB: undefined as never,
    BUCKET: undefined as never,
    ROOMS: undefined as never,
    ASSETS: undefined as never,
    BASE_HOST: env.BASE_HOST,
    AUTH: auth,
    VISIBILITY: env.VISIBILITY as Env['VISIBILITY'] | undefined,
    ALLOWED_EMAIL_DOMAINS: env.ALLOWED_EMAIL_DOMAINS,
    ALLOWED_EMAILS: env.ALLOWED_EMAILS,
    SESSION_SECRET: env.SESSION_SECRET,
    GOOGLE_CLIENT_ID: env.GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET: env.GOOGLE_CLIENT_SECRET,
    DEPLOY_TOKEN: env.DEPLOY_TOKEN,
    ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY,
    OPENAI_API_KEY: env.OPENAI_API_KEY,
  };
}
