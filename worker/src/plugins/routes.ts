import type { Context, Hono } from 'hono';
import type { AppEnv } from '../env';
import type { DbEvent } from '../platform/types';
import { toManifest, type Plugin } from './types';

type Publish = (c: Context<AppEnv>, site: string, event: DbEvent) => void;

/** Mounts the three generic plugin endpoints. `publish` is app.ts's realtime
 *  helper, rebound per-request so action handlers can fan out db changes. */
export function registerPluginRoutes(app: Hono<AppEnv>, plugins: Plugin[], publish: Publish): void {
  const byId = new Map(plugins.map((plugin) => [plugin.id, plugin]));

  app.get('/api/plugins', (c) =>
    c.json({
      plugins: plugins.map(({ id, name, description, requirement }) => ({
        id,
        name,
        description,
        requirement,
      })),
    }),
  );

  app.get('/api/plugins/:id', (c) => {
    const plugin = byId.get(c.req.param('id'));
    return plugin ? c.json(toManifest(plugin)) : c.json({ error: 'no such plugin' }, 404);
  });

  app.post('/api/plugins/:id/actions/:action', async (c) => {
    const plugin = byId.get(c.req.param('id'));
    if (!plugin) return c.json({ error: 'no such plugin' }, 404);
    const action = plugin.actions?.[c.req.param('action')];
    if (!action) {
      return c.json({ error: 'no such action', actions: Object.keys(plugin.actions ?? {}) }, 404);
    }

    const body = await c.req
      .json<{ args?: Record<string, string> }>()
      .catch((): { args?: Record<string, string> } => ({}));
    const args = body.args ?? {};
    for (const spec of action.args ?? []) {
      if (spec.required && !(spec.name in args)) {
        return c.json({ error: `missing required argument: ${spec.name}` }, 400);
      }
    }

    try {
      const result = await action.handler(
        {
          platform: c.var.platform,
          user: c.var.user,
          publish: (site, event) => publish(c, site, event),
        },
        args,
      );
      return c.json({ result });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });
}
