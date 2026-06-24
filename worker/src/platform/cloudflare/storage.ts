import type { Storage } from '../types';

/** R2 implementation of `Storage`. Normalizes R2's httpMetadata/httpEtag into
 *  the flat `StoredObject` shape; Brisk only ever stores a Content-Type. */
export function cloudflareStorage(bucket: R2Bucket): Storage {
  return {
    async get(key) {
      const o = await bucket.get(key);
      if (!o) return null;
      const h = new Headers();
      o.writeHttpMetadata(h);
      return {
        body: o.body,
        contentType: h.get('content-type') ?? undefined,
        etag: o.httpEtag,
        size: o.size,
      };
    },
    async put(key, body, opts) {
      await bucket.put(
        key,
        body,
        opts?.contentType ? { httpMetadata: { contentType: opts.contentType } } : undefined,
      );
    },
    async list({ prefix, cursor }) {
      const page = await bucket.list({ prefix, cursor });
      return {
        objects: page.objects.map((o) => ({ key: o.key, size: o.size })),
        cursor: page.truncated ? page.cursor : undefined,
      };
    },
    async delete(keys) {
      await bucket.delete(keys);
    },
  };
}
