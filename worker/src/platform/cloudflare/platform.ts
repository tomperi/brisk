import type { Env } from '../../env';
import type { Database, Platform } from '../types';
import { cloudflareAssets } from './assets';
import { cloudflareCache } from './cache';
import { cloudflareRooms } from './rooms';
import { cloudflareStorage } from './storage';

/** Build the per-request Platform from Cloudflare bindings + execution context.
 *  `D1Database` already satisfies the `Database` interface structurally, so it
 *  is used directly. */
export function buildCloudflarePlatform(env: Env, ctx: ExecutionContext): Platform {
  return {
    storage: cloudflareStorage(env.BUCKET),
    db: env.DB as Database,
    rooms: cloudflareRooms(env.ROOMS),
    assets: cloudflareAssets(env.ASSETS),
    cache: cloudflareCache(),
    waitUntil: (p) => ctx.waitUntil(p),
  };
}
