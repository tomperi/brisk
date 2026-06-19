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
  /** Node targets only (compose/kubernetes). */
  storage: StorageKind;
  /** Present when storage === 's3'. */
  s3?: S3Answers;
  /** Container image; defaults to the published image. */
  image: string;
}

export const DEFAULT_IMAGE = 'ghcr.io/usebrisk/brisk:latest';

export interface GeneratedFile {
  path: string;
  content: string;
}
