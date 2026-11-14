# @usebrisk/cli

The `brisk` command: drop a folder, get a site.

```sh
npm install -g @usebrisk/cli

brisk login            # authenticate
brisk init my-site     # scaffold a site
brisk deploy my-site   # deploy a folder → get a URL
brisk dev              # run locally
brisk list             # your sites
brisk pull <site>      # download a deployed site
```

Read and write a site's `brisk.db` from a terminal or a job. The site comes from
`--site`, else `brisk.json` or the folder name:

```sh
brisk db get    <collection> <id>                  # one doc
brisk db list   <collection> [--limit n] [--sort -created]
brisk db put    <collection> <id> --file doc.json  # create, or replace every field (stdin without --file)
brisk db put    <collection> --jsonl rows.jsonl    # many rows in one run: {"id":…,"doc":{…}} per line
brisk db delete <collection> <id>
```

- `--json` prints machine-readable output. A single `put` prints
  `{"id","ok","status"}` (201 created, 200 replaced, or `error` on failure); a
  batch prints `{"ok","total","failed","results":[{"line","id","ok","status","error"}]}`.
- A batch sends up to 4 rows at a time. Lines with the same id go in file order,
  so the last one wins. A failed row is reported and the others still run; the
  exit code is non-zero when any row failed.
- `list` returns 100 docs by default and at most 500 (`--limit`); there is no
  paging yet.
- `--timeout <seconds>` caps each request (default 30).
- Ids are 1–200 characters of letters, digits and `. _ : -`, starting with a
  letter or digit.

Part of [Brisk](https://github.com/tomperi/brisk) — an open-source internal
hosting platform on Cloudflare with six zero-config browser APIs (db, identity,
ai, files, channels, hosting).
