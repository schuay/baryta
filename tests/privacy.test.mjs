// Checks the built site (npm run build first) for leaks of private galleries:
// their key, title or slug must appear only inside their own /p/<key>/ pages.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'yaml';
import { serve } from './serve.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const DIST = path.join(ROOT, 'dist');
const CONTENT = process.env.BARYTA_CONTENT ?? path.join(ROOT, 'example');
const BINARY = /\.(jpe?g|avif|png|webp|woff2?)$/i;

const site = existsSync(path.join(CONTENT, 'site.yaml')) ? parse(await readFile(path.join(CONTENT, 'site.yaml'), 'utf8')) : {};
const privates = await Promise.all(
  Object.entries(site.private ?? {}).map(async ([slug, key]) => {
    const g = parse(await readFile(path.join(CONTENT, 'galleries', slug, 'gallery.yaml'), 'utf8'));
    return { slug, key, title: g.title };
  }),
);

const skip = (!existsSync(path.join(DIST, 'index.html')) && 'dist/ not built') || (!privates.length && 'no private galleries');
let server, base;

before(async () => {
  if (skip) return;
  server = await serve(DIST);
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server?.close());

async function* files(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* files(p);
    else yield p;
  }
}

test('private galleries appear only under their own path', { skip }, async () => {
  for (const { slug, key, title } of privates) {
    const own = path.join(DIST, 'p', key) + path.sep;
    assert.ok(existsSync(path.join(own, 'index.html')), `missing ${own}`);
    assert.ok(!existsSync(path.join(DIST, slug)), `published under its slug: /${slug}/`);
    for await (const f of files(DIST)) {
      if (f.startsWith(own) || BINARY.test(f)) continue;
      const text = await readFile(f, 'utf8');
      const rel = path.relative(DIST, f);
      assert.ok(!text.includes(key), `key of ${slug} in ${rel}`);
      assert.ok(!text.includes(title), `title of ${slug} in ${rel}`);
      assert.ok(!text.includes(`/${slug}/`), `path of ${slug} in ${rel}`);
    }
  }
});

test('private pages ask not to be indexed and not to send referrers', { skip }, async () => {
  for (const { key } of privates) {
    for (const view of ['', 'sequence/', 'grid/']) {
      const res = await fetch(`${base}/p/${key}/${view}`);
      if (view && res.status === 404) continue; // only the gallery's two views exist
      assert.equal(res.status, 200, `/p/${key}/${view}`);
      const html = await res.text();
      assert.match(html, /<meta name="robots" content="noindex, nofollow"/);
      assert.match(html, /<meta name="referrer" content="no-referrer"/);
      for (const [, href] of html.matchAll(/href="(\/[^"]*)"/g)) {
        if (/^\/(p\/|_astro\/|$)/.test(href)) continue;
        // Links out of the gallery go to public pages only.
        assert.ok(!href.includes(key), href);
      }
    }
  }
});

test('wrong or partial private addresses are not found', { skip }, async () => {
  for (const { slug, key } of privates) {
    for (const p of [`/p/`, `/p/${key.slice(0, -1)}/`, `/p/${key}x/`, `/${slug}/`, `/p/${slug}/`]) {
      assert.equal((await fetch(base + p)).status, 404, p);
    }
  }
});

test('public pages carry no noindex', { skip }, async () => {
  const html = await (await fetch(`${base}/`)).text();
  assert.doesNotMatch(html, /noindex/);
});
