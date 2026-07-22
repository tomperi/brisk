import type { User } from '../env';
import type { DbEvent, Platform } from '../platform/types';

export type PluginRequirement = 'mandatory' | 'default' | 'optional';
export type RenderHint = 'table' | 'markdown' | 'json' | 'text';

export interface ActionArg {
  name: string;
  required?: boolean;
  help?: string;
}

/** What a plugin action handler is handed. `publish` fans a db mutation out to
 *  the site's realtime room, exactly like the built-in db routes do. */
export interface PluginActionCtx {
  platform: Platform;
  user: User;
  publish: (site: string, event: DbEvent) => void;
}

export interface PluginAction {
  summary: string;
  args?: ActionArg[];
  render?: RenderHint;
  columns?: string[];
  handler: (ctx: PluginActionCtx, args: Record<string, string>) => Promise<unknown>;
}

export interface Plugin {
  id: string;
  name: string;
  description: string;
  requirement: PluginRequirement;
  /** Filename of the injected widget bundle, served at /_plugins/<id>/<widget>. */
  widget?: string;
  actions?: Record<string, PluginAction>;
}

/** The public shape of an action — the handler stripped off. */
export interface ActionManifest {
  summary: string;
  args: ActionArg[];
  render: RenderHint;
  columns?: string[];
}

export interface PluginManifest {
  id: string;
  name: string;
  description: string;
  requirement: PluginRequirement;
  widget?: string;
  actions: Record<string, ActionManifest>;
}

/** Registry entry → what the CLI is allowed to see (never the handler). */
export function toManifest(plugin: Plugin): PluginManifest {
  const actions: Record<string, ActionManifest> = {};
  for (const [name, action] of Object.entries(plugin.actions ?? {})) {
    actions[name] = {
      summary: action.summary,
      args: action.args ?? [],
      render: action.render ?? 'json',
      ...(action.columns ? { columns: action.columns } : {}),
    };
  }
  return {
    id: plugin.id,
    name: plugin.name,
    description: plugin.description,
    requirement: plugin.requirement,
    ...(plugin.widget ? { widget: plugin.widget } : {}),
    actions,
  };
}
