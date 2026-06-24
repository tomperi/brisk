import type { Context } from 'hono';
import { createApp } from '../../app';
import type { AppEnv, Env } from '../../env';
import type { Platform, Storage } from '../types';
import { createDiskAssets } from './assets';
import { createMemoryCache } from './cache';
import { NodeDatabase, openNodeDatabase } from './database';
import { createNodeRooms, type NodeRooms } from './rooms';
import { createFsStorage } from './storage-fs';
import { createS3Storage } from './storage-s3';

export interface NodeOptions {
  config: Env;
  db: NodeDatabase;
  rooms: NodeRooms;
  assetsDir: string;
  storage: Storage;
}

/** Select the storage backend from env: S3 by default, filesystem when STORAGE=fs. */
export function storageFromEnv(env: NodeJS.ProcessEnv = process.env): Storage {
  if ((env.STORAGE ?? 's3') === 'fs') {
    return createFsStorage(env.FS_ROOT ?? '/data/objects');
  }
  return createS3Storage({
    endpoint: env.S3_ENDPOINT!,
    bucket: env.S3_BUCKET!,
    region: env.S3_REGION ?? 'us-east-1',
    accessKeyId: env.S3_ACCESS_KEY_ID!,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY!,
  });
}

/**
 * The Node makePlatform hook. Runs in createApp's first middleware, so it also
 * delivers config onto c.env. Node's default c.env is {incoming, outgoing} on
 * the HTTP path, and on the websocket-upgrade path node-server adds its own
 * fields/symbols there and relies on that object's identity to complete the
 * upgrade — so we MERGE the config in (Object.assign) instead of replacing the
 * object, which would strip those internals and break websocket upgrades. Every
 * existing c.env.X read then works.
 */
export function makeNodePlatform(opts: NodeOptions): (c: Context<AppEnv>) => Platform {
  const assets = createDiskAssets(opts.assetsDir);
  const cache = createMemoryCache();
  const waitUntil = (p: Promise<unknown>): void => {
    void p.catch((err) => console.error('[brisk] background task failed:', err));
  };
  return (c) => {
    Object.assign(c.env, opts.config);
    return { storage: opts.storage, db: opts.db, rooms: opts.rooms, assets, cache, waitUntil };
  };
}

export interface BuildArgs {
  config: Env;
  dbPath: string;
  migrationsDir: string;
  assetsDir: string;
  storage: Storage;
}

/** Build the Node Hono app (no server). Returns the app + the rooms object so
 *  the entry/tests can wire the websocket server. */
export function buildNodeApp(args: BuildArgs) {
  const db = openNodeDatabase(args.dbPath, args.migrationsDir);
  const rooms = createNodeRooms();
  const platform = makeNodePlatform({
    config: args.config,
    db,
    rooms,
    assetsDir: args.assetsDir,
    storage: args.storage,
  });
  const app = createApp(platform, rooms.wsRoute);
  return { app, rooms, db };
}
