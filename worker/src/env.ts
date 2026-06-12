export interface Env {
  DB: D1Database;
  BUCKET: R2Bucket;
  ROOMS: DurableObjectNamespace;
  ASSETS: Fetcher;

  /** Sites hang off this host (`foo.<BASE_HOST>`). Empty = path-only mode. */
  BASE_HOST: string;
  /** "google" = Google OAuth on the apex domain; "none" = trusted network. */
  AUTH: 'none' | 'google';
  /**
   * "public" lets anonymous visitors view sites and the dashboard (read-only,
   * edge-cached); every API and deploy still requires login. Default: private.
   */
  VISIBILITY?: 'private' | 'public';
  /**
   * Who gets through OAuth: comma-separated email domains and/or exact
   * emails. Both empty = allow anyone who can complete the Google login.
   */
  ALLOWED_EMAIL_DOMAINS: string;
  ALLOWED_EMAILS: string;

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
