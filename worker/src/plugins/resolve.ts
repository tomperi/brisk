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

/**
 * Fold every currently-mandatory plugin into an already-resolved id list.
 * A site's enabled set is resolved and stored at deploy time, so a plugin that
 * becomes mandatory afterwards (a fork adds one, or upgrades a requirement)
 * would never reach already-deployed sites. Applying this at serve time keeps
 * `resolveEnabled`'s "mandatory is always on" contract true without a redeploy,
 * while the stored list stays authoritative for `default`/`optional`.
 */
export function withMandatory(registry: Plugin[], ids: string[]): string[] {
  const enabled = new Set(ids);
  for (const plugin of registry) {
    if (plugin.requirement === 'mandatory') enabled.add(plugin.id);
  }
  return [...enabled];
}
