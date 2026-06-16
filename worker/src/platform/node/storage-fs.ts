import { createReadStream } from 'node:fs';
import { mkdir, rm, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { contentType } from '../../mime';
import type { ListResult, Storage, StoredObject } from '../types';

/**
 * Filesystem Storage: objects live under `root/<key>`. No metadata store — the
 * Content-Type is derived from the key's extension (mime.ts). That matches how
 * serveSite already falls back, and keeps the leanest single-pod option free of
 * sidecars. Keys never contain `..` (the worker validates site names; deploy
 * paths are filtered in app.ts), but we still resolve-and-guard against escape.
 */
export function createFsStorage(rootDir: string): Storage {
  const root = resolve(rootDir);
  const pathFor = (key: string): string => {
    const file = resolve(root, key);
    if (file !== root && !file.startsWith(root + sep)) {
      throw new Error(`fs storage: key escapes root: ${key}`);
    }
    return file;
  };

  return {
    async get(key): Promise<StoredObject | null> {
      const file = pathFor(key);
      let s;
      try {
        s = await stat(file);
      } catch {
        return null;
      }
      if (!s.isFile()) return null;
      const body = Readable.toWeb(createReadStream(file)) as unknown as ReadableStream;
      return {
        body,
        contentType: contentType(key),
        etag: `"${s.size}-${Math.trunc(s.mtimeMs)}"`,
        size: s.size,
      };
    },

    async put(key, body, _opts): Promise<void> {
      const file = pathFor(key);
      await mkdir(dirname(file), { recursive: true });
      const buf =
        body instanceof ReadableStream
          ? Buffer.from(await new Response(body).arrayBuffer())
          : Buffer.from(body);
      await writeFile(file, buf);
    },

    async list({ prefix, cursor }): Promise<ListResult> {
      // Walk the tree, return keys under `prefix`. No real pagination needed at
      // internal-tool scale: return everything in one page (cursor unused).
      const objects: { key: string; size: number }[] = [];
      const walk = async (dir: string): Promise<void> => {
        let entries;
        try {
          entries = await readdir(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const e of entries) {
          const abs = join(dir, e.name);
          if (e.isDirectory()) await walk(abs);
          else if (e.isFile()) {
            const key = relative(root, abs).split(sep).join('/');
            if (key.startsWith(prefix)) objects.push({ key, size: (await stat(abs)).size });
          }
        }
      };
      await walk(root);
      void cursor;
      return { objects, cursor: undefined };
    },

    async delete(keys): Promise<void> {
      await Promise.all(keys.map((k) => rm(pathFor(k), { force: true })));
    },
  };
}
