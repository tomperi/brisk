export type Target = 'compose' | 'kubernetes' | 'cloudflare';
export type StorageKind = 's3' | 'fs';
export type AuthMode = 'none' | 'google';

export interface S3Answers {
  endpoint: string;
  bucket: string;
  region: string;
}

export interface Answers {
  target: Target;
  /** Sites hang off this host (foo.<baseHost>); empty = path-mode (/s/foo/). */
  baseHost: string;
  auth: AuthMode;
  /**
   * Comma-separated Google login allowlist (domains) when auth === 'google';
   * empty string means "not restricted". An empty allowlist admits ANY Google
   * account, so the generated config flags it and next steps warn about it.
   */
  allowedEmailDomains: string;
  /** Node targets only (compose/kubernetes). */
  storage: StorageKind;
  /** Present when storage === 's3'. */
  s3?: S3Answers;
  /** Container image; defaults to the published image. */
  image: string;
}

export const DEFAULT_IMAGE = 'ghcr.io/usebrisk/brisk:latest';

/**
 * Every instance env var the worker reads, split by how it reaches the pod:
 * plain config, or a secret. This is a hand-kept mirror of `Env` in
 * `worker/src/env.ts`, and `test/env-parity.test.ts` fails the build when the
 * two drift — the scaffolder generating config for a var the worker doesn't
 * have (or, worse, silently omitting one it does) is the whole failure mode
 * these lists exist to prevent.
 */
export const CONFIG_VARS = [
  'BASE_HOST',
  'AUTH',
  'VISIBILITY',
  'DEPLOY_HISTORY',
  'ALLOWED_EMAIL_DOMAINS',
  'ALLOWED_EMAILS',
] as const;

export const SECRET_VARS = [
  'SESSION_SECRET',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'DEPLOY_TOKEN',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'TYPESAFE_API_KEY',
] as const;

export interface GeneratedFile {
  path: string;
  content: string;
}
