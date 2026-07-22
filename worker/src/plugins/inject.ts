import type { Plugin } from './types';

const escapeAttr = (s: string): string => s.replace(/[&<>"]/g, (ch) => `&#${ch.charCodeAt(0)};`);

/**
 * Insert each enabled widget's <script> just before </body>. String-based so it
 * works on every platform (Cloudflare workerd, Node, …) — an HTMLRewriter here
 * would be Cloudflare-only. Only touches text/html; every other content type
 * passes through untouched. `site` rides on the tag as data-brisk-site so the
 * widget knows which site's actions to call (it can't derive that on a subdomain).
 */
export async function injectWidgets(
  res: Response,
  plugins: Plugin[],
  enabled: string[],
  site: string,
): Promise<Response> {
  if (!(res.headers.get('content-type') ?? '').includes('text/html')) return res;
  const widgets = plugins.filter((p) => p.widget && enabled.includes(p.id));
  if (!widgets.length) return res;

  const tags = widgets
    .map(
      (p) =>
        `<script src="/_plugins/${p.id}/${p.widget}" data-brisk-plugin="${p.id}" data-brisk-site="${escapeAttr(site)}" defer></script>`,
    )
    .join('');

  const html = await res.text();
  // Slot the scripts just before the closing </body>; fall back to appending if
  // a page has no body tag (a bare fragment gets nothing to anchor to).
  const idx = html.toLowerCase().lastIndexOf('</body>');
  const out = idx >= 0 ? html.slice(0, idx) + tags + html.slice(idx) : html;

  // The body changed, so length/etag no longer describe it — drop both and let
  // the runtime recompute the length from the string.
  const headers = new Headers(res.headers);
  headers.delete('content-length');
  headers.delete('etag');
  return new Response(out, { status: res.status, statusText: res.statusText, headers });
}
