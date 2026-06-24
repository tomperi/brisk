import type { AssetServer } from '../types';

/** Serves bundled assets via the Workers `ASSETS` fetcher binding. The base
 *  origin is arbitrary — only the path matters to the binding. */
export function cloudflareAssets(assets: Fetcher): AssetServer {
  return {
    fetch: (path: string) => assets.fetch(new URL(path, 'https://assets.local')),
  };
}
