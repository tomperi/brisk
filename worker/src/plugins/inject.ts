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
        `<script src="/_plugins/${p.id}/widget.js" data-brisk-plugin="${p.id}" data-brisk-site="${escapeAttr(site)}" defer></script>`,
    )
    .join('');

  const html = await res.text();
  // Slot the scripts just before the last closing </body>, matched on the
  // original string (lowercasing a copy shifts offsets when case-folding
  // changes length, e.g. İ → i̇). A page with no body tag — a bare fragment
  // browsers render anyway — gets them appended at the end instead.
  //
  // Last match, not first: a literal "</body>" inside an inline script or
  // comment *before* the real close is the common hazard, and the last match
  // skips past it. The inverse — literal "</body>" text trailing the real
  // close — misplaces the tags; a known, accepted limit of string injection
  // (anything stricter needs an HTML tokenizer).
  let idx = -1;
  for (const m of html.matchAll(/<\/body\s*>/gi)) idx = m.index ?? -1;
  const out = idx >= 0 ? html.slice(0, idx) + tags + html.slice(idx) : html + tags;

  // The body changed, so length/etag no longer describe it — drop both and let
  // the runtime recompute the length from the string.
  const headers = new Headers(res.headers);
  headers.delete('content-length');
  headers.delete('etag');
  return new Response(out, { status: res.status, statusText: res.statusText, headers });
}
