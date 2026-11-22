import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';

const tmp = await mkdtemp(path.join(os.tmpdir(), 'folio-test-'));
process.env.FOLIO_CACHE = path.join(tmp, 'cache');
const { loadSite, usedImageFiles, ContentError } = await import('../src/lib/load.ts');

const XMP = `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title><rdf:Alt><rdf:li xml:lang="x-default">Embedded title</rdf:li></rdf:Alt></dc:title></rdf:Description></rdf:RDF></x:xmpmeta>`;

async function grey(file: string, width = 900, height = 600) {
  await sharp({ create: { width, height, channels: 3, background: { r: 120, g: 120, b: 120 } } })
    .jpeg()
    .toFile(file);
}

async function sepia(file: string) {
  await sharp({ create: { width: 600, height: 900, channels: 3, background: { r: 150, g: 120, b: 90 } } })
    .jpeg()
    .toFile(file);
}

let n = 0;
/** Writes a content directory from a map of relative path -> contents. */
async function content(files: Record<string, string | ((p: string) => Promise<void>)>) {
  const dir = path.join(tmp, `content-${n++}`);
  for (const [rel, v] of Object.entries(files)) {
    const p = path.join(dir, rel);
    await mkdir(path.dirname(p), { recursive: true });
    if (typeof v === 'string') await writeFile(p, v);
    else await v(p);
  }
  return dir;
}

async function problems(dir: string): Promise<string[]> {
  try {
    await loadSite({ contentDir: dir, drafts: false });
  } catch (e) {
    if (e instanceof ContentError) return e.problems;
    throw e;
  }
  assert.fail('expected a ContentError');
}

after(() => rm(tmp, { recursive: true, force: true }));

test('level 0: a one-line gallery shows all images in natural order', async () => {
  const dir = await content({
    'site.yaml': 'title: T\ngalleries: [g]\n',
    'galleries/g/gallery.yaml': 'title: G\n',
    'galleries/g/img10.jpg': (p) => grey(p, 500, 500),
    'galleries/g/img2.jpg': grey,
    'galleries/g/notes.txt': 'not an image',
  });
  const site = await loadSite({ contentDir: dir, drafts: false });
  const g = site.galleries[0]!;
  assert.equal(g.imageCount, 2);
  assert.equal(g.view, 'sequence');
  const frames = g.frames.filter((f) => f.kind === 'image');
  assert.deepEqual(frames.map((f) => f.number), [1, 2]);
  // img2 (900 wide) sorts before img10 (500 wide).
  assert.deepEqual(frames.map((f) => f.image.width), [900, 500]);
  assert.equal(frames[0]!.alt, 'G, image 1');
});

test('level 1 and 2: shorthand and structured captions expand to the model', async () => {
  const dir = await content({
    'site.yaml': 'title: T\ngalleries: [g]\ndefaults: { border: hairline }\n',
    'galleries/g/gallery.yaml': [
      'title: G',
      'intro: Some *text*.',
      'images:',
      '  - b.jpg: A caption',
      '  - a.jpg: { title: Ferry Slip, year: 1979, medium: Gelatin silver print, border: none }',
      '  - c.jpg',
    ].join('\n'),
    'galleries/g/a.jpg': grey,
    'galleries/g/b.jpg': grey,
    'galleries/g/c.jpg': grey,
  });
  const site = await loadSite({ contentDir: dir, drafts: false });
  const g = site.galleries[0]!;
  assert.equal(g.frames[0]!.kind, 'text');
  const [b, a, c] = g.frames.slice(1);
  assert.ok(b?.kind === 'image' && a?.kind === 'image' && c?.kind === 'image');
  assert.deepEqual(b.caption, { text: 'A caption' });
  assert.equal(b.border, 'hairline');
  assert.deepEqual(a.caption, { title: 'Ferry Slip', year: '1979', medium: 'Gelatin silver print', size: undefined, text: undefined });
  assert.equal(a.border, 'none');
  assert.equal(a.alt, 'Ferry Slip');
  assert.equal(c.caption, undefined);
  assert.equal(g.captionLines, 2);
});

test('unlisted galleries are not built, and their images are not published', async () => {
  const dir = await content({
    'site.yaml': 'title: T\ngalleries: [public]\n',
    'galleries/public/gallery.yaml': 'title: Public\n',
    'galleries/public/a.jpg': grey,
    'galleries/secret/gallery.yaml': 'title: Secret\n',
    'galleries/secret/b.jpg': (p) => grey(p, 700, 700),
  });
  const site = await loadSite({ contentDir: dir, drafts: false });
  assert.deepEqual(site.galleries.map((g) => g.slug), ['public']);
  assert.match(site.warnings.join('\n'), /not built.*secret/);

  const withDrafts = await loadSite({ contentDir: dir, drafts: true });
  const secret = withDrafts.galleries.find((g) => g.slug === 'secret')!;
  assert.equal(secret.draft, true);
  const published = new Set(usedImageFiles(site));
  for (const v of secret.cover.variants) assert.ok(!published.has(path.basename(v.jpeg)));
});

test('errors point at file and line', async () => {
  const dir = await content({
    'site.yaml': 'title: T\ngalleries: [g]\n',
    'galleries/g/gallery.yaml': ['title: G', 'images:', '  - a.jpg', '  - missing.jpg', '  - a.jpg: { captoin: x }'].join('\n'),
    'galleries/g/a.jpg': grey,
  });
  const p = await problems(dir);
  assert.equal(p.length, 1);
  assert.match(p[0]!, /^galleries\/g\/gallery\.yaml:5:\d+: .*unknown key "captoin"/);

  const dir2 = await content({
    'site.yaml': 'title: T\ngalleries: [g]\n',
    'galleries/g/gallery.yaml': ['title: G', 'images:', '  - a.jpg', '  - missing.jpg'].join('\n'),
    'galleries/g/a.jpg': grey,
  });
  assert.deepEqual(await problems(dir2), ['galleries/g/gallery.yaml:4:5: image not found: missing.jpg']);

  const dir3 = await content({ 'site.yaml': 'title: T\ngalleries: [nope]\n' });
  assert.deepEqual(await problems(dir3), ['site.yaml:2:13: missing galleries/nope/gallery.yaml']);
});

test('images not listed in a gallery are reported', async () => {
  const dir = await content({
    'site.yaml': 'title: T\ngalleries: [g]\n',
    'galleries/g/gallery.yaml': 'title: G\nimages: [a.jpg]\n',
    'galleries/g/a.jpg': grey,
    'galleries/g/b.jpg': grey,
  });
  const site = await loadSite({ contentDir: dir, drafts: false });
  assert.equal(site.galleries[0]!.imageCount, 1);
  assert.match(site.warnings.join('\n'), /not shown.*b\.jpg/);
});

test('neutral images are encoded greyscale, toned ones keep colour', async () => {
  const dir = await content({
    'site.yaml': 'title: T\ngalleries: [g]\n',
    'galleries/g/gallery.yaml': 'title: G\n',
    'galleries/g/1.jpg': grey,
    'galleries/g/2.jpg': sepia,
  });
  const site = await loadSite({ contentDir: dir, drafts: false });
  const [a, b] = site.galleries[0]!.frames.filter((f) => f.kind === 'image');
  assert.ok(a && b);
  assert.equal(a.image.neutral, true);
  assert.equal(b.image.neutral, false);
  const cache = path.join(process.env.FOLIO_CACHE!, 'img');
  const meta = await sharp(path.join(cache, path.basename(a.image.variants[0]!.jpeg))).metadata();
  assert.equal(meta.channels, 1);
  const metaToned = await sharp(path.join(cache, path.basename(b.image.variants[0]!.jpeg))).metadata();
  assert.equal(metaToned.channels, 3);
});

test('derivatives never exceed the source or images.max', async () => {
  const dir = await content({
    'site.yaml': 'title: T\ngalleries: [g]\nimages: { max: 1000 }\n',
    'galleries/g/gallery.yaml': 'title: G\n',
    'galleries/g/small.jpg': (p) => grey(p, 700, 500),
    'galleries/g/large.jpg': (p) => grey(p, 3000, 2000),
  });
  const site = await loadSite({ contentDir: dir, drafts: false });
  const [large, small] = site.galleries[0]!.frames.filter((f) => f.kind === 'image');
  assert.ok(large && small);
  assert.deepEqual(large.image.variants.map((v) => v.width), [480, 800, 1000]);
  assert.deepEqual(small.image.variants.map((v) => v.width), [480, 700]);
});

test('embedded XMP title is used only when the config gives no caption', async () => {
  const tagged = (p: string) =>
    sharp({ create: { width: 600, height: 400, channels: 3, background: { r: 90, g: 90, b: 90 } } })
      .withXmp(XMP)
      .jpeg()
      .toFile(p)
      .then(() => undefined);
  const dir = await content({
    'site.yaml': 'title: T\ngalleries: [g]\n',
    'galleries/g/gallery.yaml': 'title: G\nimages:\n  - a.jpg\n  - b.jpg: Config caption\n',
    'galleries/g/a.jpg': tagged,
    'galleries/g/b.jpg': tagged,
  });
  const site = await loadSite({ contentDir: dir, drafts: false });
  const [a, b] = site.galleries[0]!.frames.filter((f) => f.kind === 'image');
  assert.ok(a && b);
  assert.deepEqual(a.caption, { title: 'Embedded title', text: undefined });
  assert.deepEqual(b.caption, { text: 'Config caption' });
});
