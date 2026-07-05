export interface Env {
  DB: D1Database;
  BUCKET: R2Bucket;
  ROOMS: DurableObjectNamespace;
  ASSETS: Fetcher;

  // Instance configuration. These are NOT in wrangler.jsonc — set them as
  // Variables in the Cloudflare dashboard (or `.dev.vars` locally) so the repo
  // carries no deployment-specific config. Every one is optional and defaults
  // safely in code: unset means path-only, no-auth, private.

  /** Sites hang off this host (`foo.<BASE_HOST>`). Unset = path-only mode. */
  BASE_HOST?: string;
  /** "google" = Google OAuth on the apex domain; unset/"none" = trusted network. */
  AUTH?: 'none' | 'google';
  /**
   * "public" lets anonymous visitors view sites and the dashboard (read-only,
   * edge-cached); every API and deploy still requires login. Default: private.
   */
  VISIBILITY?: 'private' | 'public';
  /**
   * "on" retains every deploy, so version history (and future rollback) works;
   * unset/"off" deletes the previous deploy after each publish, keeping R2
   * bounded. Default: off — opt in per instance. (A number could later mean
   * keep-last-N; only "on" is honored for now.)
   */
  DEPLOY_HISTORY?: 'on' | 'off';
  /**
   * Who gets through OAuth: comma-separated email domains and/or exact
   * emails. Both empty/unset = allow anyone who can complete the Google login.
   */
  ALLOWED_EMAIL_DOMAINS?: string;
  ALLOWED_EMAILS?: string;

  SESSION_SECRET?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  DEPLOY_TOKEN?: string;
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY?: string;
}

export interface User {
  email: string;
  name: string;
  picture?: string;
}

/** Hono app environment: bindings plus per-request site + user. */
export type AppEnv = {
  Bindings: Env;
  Variables: {
    /** Site this request belongs to (subdomain, /s/<site> prefix, or header). */
    site: string;
    user: User;
  };
};
