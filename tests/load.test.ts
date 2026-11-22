import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import type { Gallery, PlateFrame } from '../src/lib/model.ts';

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

/** A site with one gallery `g` holding the given gallery.yaml and images. */
function gallery(yaml: string, images: Record<string, (p: string) => Promise<void>>, site = '') {
  const files: Record<string, string | ((p: string) => Promise<void>)> = {
    'site.yaml': `title: T\ngalleries: [g]\n${site}`,
    'galleries/g/gallery.yaml': yaml,
  };
  for (const [name, make] of Object.entries(images)) files[`galleries/g/${name}`] = make;
  return content(files);
}

async function load(dir: string): Promise<Gallery> {
  return (await loadSite({ contentDir: dir, drafts: false })).galleries[0]!;
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

const plates = (g: Gallery) => g.frames.filter((f): f is PlateFrame => f.kind === 'plate');

/** Images of a plate in column and reading order. */
function images(f: PlateFrame) {
  return f.columns.flatMap((c) => c.regions.flatMap((r) => (r.content.kind === 'image' ? [{ ...r.content, box: r.box }] : [])));
}

const close = (a: number, b: number, msg?: string) => assert.ok(Math.abs(a - b) < 1e-6, msg ?? `${a} != ${b}`);

after(() => rm(tmp, { recursive: true, force: true }));

test('level 0: a one-line gallery shows all images in natural order', async () => {
  const dir = await content({
    'site.yaml': 'title: T\ngalleries: [g]\n',
    'galleries/g/gallery.yaml': 'title: G\n',
    'galleries/g/img10.jpg': (p) => grey(p, 500, 500),
    'galleries/g/img2.jpg': grey,
    'galleries/g/notes.txt': 'not an image',
  });
  const g = await load(dir);
  assert.equal(g.imageCount, 2);
  assert.equal(g.view, 'sequence');
  const ps = plates(g);
  assert.deepEqual(ps.map((f) => f.number), [1, 2]);
  // img2 (900 wide) sorts before img10 (500 wide).
  assert.deepEqual(ps.map((f) => images(f)[0]!.image.width), [900, 500]);
  const single = ps[0]!;
  assert.equal(single.columns.length, 1);
  close(single.aspect, 1.5);
  assert.deepEqual(single.columns[0]!.regions[0]!.box, [0, 0, 1, 1]);
  assert.equal(single.naturalWidth, 900);
  assert.equal(single.splittable, false);
  assert.equal(images(single)[0]!.alt, 'G, image 1');
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
  const g = await load(dir);
  assert.equal(g.frames[0]!.kind, 'text');
  const [b, a, c] = plates(g);
  assert.ok(b && a && c);
  assert.deepEqual(b.columns[0]!.captions, [{ text: 'A caption' }]);
  assert.equal(images(b)[0]!.border, 'hairline');
  assert.deepEqual(a.columns[0]!.captions, [
    { title: 'Ferry Slip', year: '1979', medium: 'Gelatin silver print', size: undefined, text: undefined },
  ]);
  assert.equal(images(a)[0]!.border, 'none');
  assert.equal(images(a)[0]!.alt, 'Ferry Slip');
  assert.deepEqual(c.columns[0]!.captions, []);
  assert.equal(g.captionLines, 2);
});

test('a list in images shows the images side by side at equal height', async () => {
  const dir = await gallery('title: G\nimages:\n  - [wide.jpg: Left, tall.jpg]\n  - single.jpg\n', {
    'wide.jpg': (p) => grey(p, 900, 600),
    'tall.jpg': (p) => grey(p, 600, 900),
    'single.jpg': grey,
  });
  const [pair, single] = plates(await load(dir));
  assert.ok(pair && single);
  const gap = 0.05;
  close(pair.aspect, 1.5 + gap + 2 / 3);
  assert.equal(pair.columns.length, 2);
  assert.equal(pair.splittable, true);
  const [l, r] = pair.columns;
  close(l!.x, 0);
  close(l!.w, 1.5 / pair.aspect);
  close(r!.x, (1.5 + gap) / pair.aspect);
  close(r!.x + r!.w, 1);
  for (const c of pair.columns) assert.deepEqual(c.regions[0]!.box, [0, 0, 1, 1]);
  assert.deepEqual(l!.captions, [{ text: 'Left' }]);
  assert.deepEqual(r!.captions, []);
  // The tall image limits the width: 600 px over its share of the frame.
  close(pair.naturalWidth, Math.floor(Math.min(900 / l!.w, 600 / r!.w)));
  assert.equal(single.columns.length, 1);
});

test('spreads place images on pages within the margins', async () => {
  const dir = await gallery(
    [
      'title: G',
      'book: { page: 4/5, margins: { top: 0.1, bottom: 0.1, inner: 0.1, outer: 0.1 } }',
      'spreads:',
      '  - [square.jpg, ~]',
      '  - spread: { image: wide.jpg, scale: bleed }',
      '  - right: { layout: stack-2, images: [a.jpg, b.jpg] }',
      '  - left: { image: small.jpg, scale: small, align: bottom }',
      '  - left: [{ image: at.jpg, at: [0.5, 0, 0.5, 0.5] }, { text: Hello, at: [0, 0.9, 1, 0.1] }]',
    ].join('\n'),
    {
      'square.jpg': (p) => grey(p, 800, 800),
      'wide.jpg': (p) => grey(p, 2000, 1000),
      'a.jpg': grey,
      'b.jpg': grey,
      'small.jpg': (p) => grey(p, 800, 800),
      'at.jpg': (p) => grey(p, 800, 800),
    },
  );
  const g = await load(dir);
  const [first, bleed, stack, small, free] = plates(g);
  assert.ok(first && bleed && stack && small && free);

  // Page 0.8 wide, 1 high; margins 0.08 of the page height on every side.
  close(first.aspect, 1.6);
  assert.deepEqual(first.columns.map((c) => c.page), ['left', 'right']);
  assert.equal(first.splittable, true);
  const [x, y, w, h] = first.columns[0]!.regions[0]!.box;
  // Live area 0.64 x 0.84; the square fits its width and is centred vertically.
  close(x, 0.1);
  close(w, 0.8);
  close(h, 0.64);
  close(y, 0.08 + (0.84 - 0.64) / 2);
  assert.equal(first.columns[1]!.regions.length, 0);

  assert.equal(bleed.columns.length, 1);
  assert.equal(bleed.splittable, false);
  assert.deepEqual(bleed.columns[0]!.regions[0]!.box, [0, 0, 1, 1]);
  assert.equal(images(bleed)[0]!.fit, 'cover');

  const right = stack.columns[1]!;
  assert.equal(right.regions.length, 2);
  assert.equal(stack.columns[0]!.regions.length, 0);
  const [top, bottom] = right.regions.map((r) => r.box);
  assert.ok(top![1] + top![3] <= bottom![1], 'stack-2 images do not overlap');

  // small: 0.42 of the live area, at its bottom.
  const sbox = small.columns[0]!.regions[0]!.box;
  close(sbox[1] + sbox[3], 0.92);
  close(sbox[2], (0.64 * 0.42) / 0.8);

  // Free placement is relative to the page, not the live area; the square is
  // centred in its 0.4 x 0.5 box.
  const [img, text] = free.columns[0]!.regions;
  const [fx, fy, fw, fh] = img!.box;
  close(fx, 0.5);
  close(fy, 0.05);
  close(fw, 0.5);
  close(fh, 0.4);
  assert.equal(text!.content.kind, 'text');
  // Captions go below the text, aligned with the image.
  close(free.columns[0]!.captionTop, 1);
  close(free.columns[0]!.captionLeft, 0.5);
});

test('layout errors point at the spread', async () => {
  const dir = await gallery(
    ['title: G', 'spreads:', '  - right: { layout: stack-9, images: [a.jpg] }', '  - right: { layout: pair, images: [b.jpg] }'].join('\n'),
    { 'a.jpg': grey, 'b.jpg': grey },
  );
  const p = await problems(dir);
  assert.match(p[0]!, /^galleries\/g\/gallery\.yaml:3:\d+: unknown layout "stack-9"; known: pair, stack-2/);
  assert.match(p[1]!, /^galleries\/g\/gallery\.yaml:4:\d+: layout "pair" takes 2 images, got 1/);

  const twice = await gallery('title: G\nspreads:\n  - [a.jpg, a.jpg]\n', { 'a.jpg': grey });
  assert.match((await problems(twice))[0]!, /gallery\.yaml:3:\d+: image used twice: a\.jpg/);
});

test('site.yaml can define layouts', async () => {
  const dir = await gallery('title: G\nspreads:\n  - right: { layout: corner, images: [a.jpg] }\n', { 'a.jpg': grey }, [
    'layouts:',
    '  corner: [{ at: [0.5, 0.5, 0.5, 0.5], align: right }]',
  ].join('\n'));
  // Slots are fractions of the live area: the right page's live area starts at
  // the inner margin (0.08) and is 1 - 0.08 - 0.09 of the page wide.
  const [f] = plates(await load(dir));
  const [x, y] = f!.columns[1]!.regions[0]!.box;
  close(x, 0.08 + 0.5 * (1 - 0.08 - 0.09));
  assert.ok(y > 0.072 + 0.5 * (1 - 0.072 - 0.104));
});

test('errors point at file and line', async () => {
  const dir = await content({
    'site.yaml': 'title: T\ngalleries: [g]\n',
    'galleries/g/gallery.yaml': ['title: G', 'images:', '  - a.jpg', '  - missing.jpg', '  - b.jpg: { captoin: x }'].join('\n'),
    'galleries/g/a.jpg': grey,
    'galleries/g/b.jpg': grey,
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

  // Inside a group, the misspelt key is still found and located.
  const dir4 = await gallery('title: G\nimages:\n  - [a.jpg, b.jpg: { captoin: x }]\n', { 'a.jpg': grey, 'b.jpg': grey });
  assert.match((await problems(dir4))[0]!, /gallery\.yaml:3:\d+: images\[0\]\[1\]\.b\.jpg: unknown key "captoin"/);

  // In a spread page, the alternative that fits best is reported.
  const dir6 = await gallery(
    'title: G\nspreads:\n  - left: { image: a.jpg, scale: huge }\n  - left: { layout: pair, imgs: [a.jpg, b.jpg] }\n',
    { 'a.jpg': grey, 'b.jpg': grey },
  );
  assert.deepEqual(
    (await problems(dir6)).map((m) => m.replace(/^[^ ]+ /, '')),
    [
      'spreads[0].left.scale: Invalid option: expected one of "small"|"medium"|"large"|"bleed"',
      'spreads[1].left.images: missing',
      'spreads[1].left: unknown key "imgs"',
    ],
  );

  const dir5 = await gallery('title: G\nimages: [a.jpg]\nspreads: [[a.jpg, ~]]\n', { 'a.jpg': grey });
  assert.match((await problems(dir5))[0]!, /either `images` or `spreads`/);
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
  assert.equal(secret.visibility, 'draft');
  const published = new Set(usedImageFiles(site));
  for (const v of secret.cover.variants) assert.ok(!published.has(path.basename(v.jpeg)));
});

test('private galleries are built at /p/<key>/ only', async () => {
  const key = 'abcdefghijklmnopqrstuv';
  const dir = await content({
    'site.yaml': `title: T\ngalleries: [public]\nprivate:\n  secret: ${key}\n`,
    'galleries/public/gallery.yaml': 'title: Public\n',
    'galleries/public/a.jpg': grey,
    'galleries/secret/gallery.yaml': 'title: Secret\n',
    'galleries/secret/b.jpg': grey,
  });
  for (const drafts of [false, true]) {
    const site = await loadSite({ contentDir: dir, drafts });
    assert.deepEqual(
      site.galleries.map((g) => [g.slug, g.visibility, g.path]),
      [
        ['public', 'public', '/public/'],
        ['secret', 'private', `/p/${key}/`],
      ],
    );
    assert.doesNotMatch(site.warnings.join('\n'), /secret/);
  }
});

test('private gallery configuration is checked', async () => {
  const key = 'abcdefghijklmnopqrstuv';
  const base = { 'galleries/g/gallery.yaml': 'title: G\n', 'galleries/g/a.jpg': grey, 'galleries/h/gallery.yaml': 'title: H\n', 'galleries/h/b.jpg': grey };
  const cases: [string, RegExp][] = [
    [`galleries: [g]\nprivate:\n  g: ${key}\n`, /^site\.yaml:2:\d+: gallery is both listed and private: g/],
    [`galleries: [g]\nprivate:\n  h: short\n`, /^site\.yaml:4:\d+: private\.h: use a random key of at least 22/],
    [`galleries: [g]\nprivate:\n  nope: ${key}\n`, /^site\.yaml:4:\d+: missing galleries\/nope\/gallery\.yaml/],
    [`galleries: [g]\nprivate:\n  h: ${key}\n  i: ${key}\n`, /key used twice/],
    [`galleries: [p]\n`, /reserved name: p/],
  ];
  for (const [yaml, expected] of cases) {
    const dir = await content({ ...base, 'site.yaml': `title: T\n${yaml}` });
    assert.match((await problems(dir)).join('\n'), expected, yaml);
  }
});

test('images not used in a gallery are reported', async () => {
  const dir = await gallery('title: G\nimages: [a.jpg]\n', { 'a.jpg': grey, 'b.jpg': grey });
  const site = await loadSite({ contentDir: dir, drafts: false });
  assert.equal(site.galleries[0]!.imageCount, 1);
  assert.match(site.warnings.join('\n'), /not shown.*b\.jpg/);
});

test('neutral images are encoded greyscale, toned ones keep colour', async () => {
  const dir = await gallery('title: G\n', { '1.jpg': grey, '2.jpg': sepia });
  const [a, b] = plates(await load(dir)).map((f) => images(f)[0]!.image);
  assert.ok(a && b);
  assert.equal(a.neutral, true);
  assert.equal(b.neutral, false);
  const cache = path.join(process.env.FOLIO_CACHE!, 'img');
  const meta = await sharp(path.join(cache, path.basename(a.variants[0]!.jpeg))).metadata();
  assert.equal(meta.channels, 1);
  const metaToned = await sharp(path.join(cache, path.basename(b.variants[0]!.jpeg))).metadata();
  assert.equal(metaToned.channels, 3);
});

test('derivatives never exceed the source or images.max', async () => {
  const dir = await gallery('title: G\n', { 'small.jpg': (p) => grey(p, 700, 500), 'large.jpg': (p) => grey(p, 3000, 2000) }, 'images: { max: 1000 }\n');
  const [large, small] = plates(await load(dir)).map((f) => images(f)[0]!.image);
  assert.ok(large && small);
  assert.deepEqual(large.variants.map((v) => v.width), [480, 800, 1000]);
  assert.deepEqual(small.variants.map((v) => v.width), [480, 700]);
});

test('embedded XMP title is used only when the config gives no caption', async () => {
  const tagged = (p: string) =>
    sharp({ create: { width: 600, height: 400, channels: 3, background: { r: 90, g: 90, b: 90 } } })
      .withXmp(XMP)
      .jpeg()
      .toFile(p)
      .then(() => undefined);
  const dir = await gallery('title: G\nimages:\n  - a.jpg\n  - b.jpg: Config caption\n', { 'a.jpg': tagged, 'b.jpg': tagged });
  const [a, b] = plates(await load(dir));
  assert.deepEqual(a!.columns[0]!.captions, [{ title: 'Embedded title', text: undefined }]);
  assert.deepEqual(b!.columns[0]!.captions, [{ text: 'Config caption' }]);
});
