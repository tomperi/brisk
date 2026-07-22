import type { Plugin } from './types';

/**
 * The enabled plugin ids for a deploy, from the registry and the site's
 * requested map (its brisk.json `plugins`). Mandatory is always on; default is
 * on unless explicitly false; optional is off unless explicitly true. Unknown
 * requested ids are ignored, so a stale brisk.json can't enable a gone plugin.
 */
export function resolveEnabled(
  registry: Plugin[],
  requested: Record<string, boolean> = {},
): string[] {
  return registry
    .filter((plugin) => {
      if (plugin.requirement === 'mandatory') return true;
      const asked = requested[plugin.id];
      if (typeof asked === 'boolean') return asked;
      return plugin.requirement === 'default';
    })
    .map((plugin) => plugin.id);
}
