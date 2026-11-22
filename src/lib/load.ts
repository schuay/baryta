// Reads the content directory, validates it and expands it into the model.
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { LineCounter, parseDocument, isNode, type Document } from 'yaml';
import { marked } from 'marked';
import type { z } from 'astro/zod';
import { GalleryFile, SiteFile, type Details } from './schema.ts';
import type { Caption, Frame, Gallery, Img, Page, Site } from './model.ts';
import { processImage } from './images.ts';

const IMAGE_EXT = /\.(jpe?g|png|tiff?|webp|avif)$/i;
const RESERVED_SLUGS = new Set(['_img', '_astro', 'index']);
const DEFAULT_MAX_EDGE = 2560;
const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

export class ContentError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(problems.join('\n'));
    this.name = 'ContentError';
    this.problems = problems;
  }
}

interface Loaded<T> {
  data: T;
  /** Formats `msg` with the file:line:col of the node at `at`. */
  where: (at: (string | number)[], msg: string) => string;
}

async function loadYaml<T>(file: string, schema: z.ZodType<T>, rel: string): Promise<Loaded<T>> {
  const src = await readFile(file, 'utf8');
  const lc = new LineCounter();
  const doc: Document = parseDocument(src, { lineCounter: lc, prettyErrors: false });
  const where = (at: (string | number)[], msg: string) => {
    // Fall back to the nearest existing ancestor, e.g. for a missing key.
    for (let n = at.length; n >= 0; n--) {
      const node = n === 0 ? doc.contents : doc.getIn(at.slice(0, n), true);
      if (isNode(node) && node.range) {
        const { line, col } = lc.linePos(node.range[0]);
        return `${rel}:${line}:${col}: ${msg}`;
      }
    }
    return `${rel}: ${msg}`;
  };
  if (doc.errors.length) {
    throw new ContentError(
      doc.errors.map((e) => {
        const { line, col } = lc.linePos(e.pos[0]);
        return `${rel}:${line}:${col}: ${e.message.split('\n')[0]}`;
      }),
    );
  }
  const parsed = schema.safeParse(doc.toJS());
  if (!parsed.success) {
    throw new ContentError(
      parsed.error.issues.map((i) => {
        const at = i.path.filter((p): p is string | number => typeof p !== 'symbol');
        const label = at.length ? `${formatPath(at)}: ` : '';
        let msg = i.message;
        if (i.code === 'unrecognized_keys') msg = `unknown key ${i.keys.map((k) => `"${k}"`).join(', ')}`;
        return where(at, `${label}${msg}`);
      }),
    );
  }
  return { data: parsed.data, where };
}

function formatPath(at: (string | number)[]) {
  return at.map((p, i) => (typeof p === 'number' ? `[${p}]` : i ? `.${p}` : p)).join('');
}

async function isDir(p: string) {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

async function isFile(p: string) {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
}

function captionFromDetails(d: Details): Caption | undefined {
  const c: Caption = {
    title: d.title,
    year: d.year === undefined ? undefined : String(d.year),
    medium: d.medium,
    size: d.size,
    text: d.caption,
  };
  return Object.values(c).some((v) => v !== undefined) ? c : undefined;
}

/** Number of caption lines a frame needs; free text is estimated by length. */
function captionLines(c: Caption | undefined): number {
  if (!c) return 0;
  let n = 0;
  if (c.title || c.year) n++;
  if (c.medium) n++;
  if (c.size) n++;
  if (c.text) n += Math.ceil(c.text.length / 60);
  return n;
}

interface Entry {
  file: string;
  at: (string | number)[];
  details?: Details;
  caption?: string;
}

function entries(g: GalleryFile): Entry[] | undefined {
  return g.images?.map((e, i) => {
    if (typeof e === 'string') return { file: e, at: ['images', i] };
    const [file, v] = Object.entries(e)[0]!;
    return typeof v === 'string'
      ? { file, at: ['images', i], caption: v }
      : { file, at: ['images', i], details: v };
  });
}

async function loadGallery(
  contentDir: string,
  slug: string,
  site: SiteFile,
  draft: boolean,
  warnings: string[],
): Promise<Gallery> {
  const dir = path.join(contentDir, 'galleries', slug);
  const rel = `galleries/${slug}/gallery.yaml`;
  const { data: g, where } = await loadYaml(path.join(dir, 'gallery.yaml'), GalleryFile, rel);
  const onDisk = (await readdir(dir)).filter((f) => IMAGE_EXT.test(f)).sort(collator.compare);

  let list = entries(g);
  const problems: string[] = [];
  if (list) {
    const listed = new Set(list.map((e) => e.file));
    const seen = new Set<string>();
    for (const e of list) {
      if (!onDisk.includes(e.file)) problems.push(where(e.at, `image not found: ${e.file}`));
      if (seen.has(e.file)) problems.push(where(e.at, `image listed twice: ${e.file}`));
      seen.add(e.file);
    }
    const unlisted = onDisk.filter((f) => !listed.has(f));
    if (unlisted.length) warnings.push(`${rel}: not shown (not listed in images): ${unlisted.join(', ')}`);
  } else {
    if (!onDisk.length) problems.push(`${rel}: no images in galleries/${slug}/`);
    list = onDisk.map((file) => ({ file, at: [] }));
  }
  if (g.cover && !list.some((e) => e.file === g.cover)) {
    problems.push(where(['cover'], `cover must be one of the gallery's images: ${g.cover}`));
  }
  if (problems.length) throw new ContentError(problems);

  const max = site.images?.max ?? DEFAULT_MAX_EDGE;
  const border = g.border ?? site.defaults?.border ?? 'none';
  const processed = await Promise.all(list.map((e) => processImage(path.join(dir, e.file), max)));

  const frames: Frame[] = [];
  const introHtml = g.intro ? await marked.parse(g.intro) : undefined;
  if (introHtml) frames.push({ kind: 'text', html: introHtml });
  let cover: Img = processed[0]!.img;
  let lines = 0;
  list.forEach((e, i) => {
    const { img, embedded } = processed[i]!;
    // A caption given in the config replaces embedded metadata entirely, so the
    // two sources are never mixed on one image.
    let caption: Caption | undefined;
    if (e.caption !== undefined) caption = { text: e.caption };
    else if (e.details) caption = captionFromDetails(e.details);
    if (!caption && (embedded.title || embedded.description)) {
      caption = { title: embedded.title, text: embedded.description };
    }
    lines = Math.max(lines, captionLines(caption));
    if (e.file === g.cover) cover = img;
    frames.push({
      kind: 'image',
      number: i + 1,
      image: img,
      caption,
      alt: e.details?.alt ?? caption?.title ?? caption?.text ?? `${g.title}, image ${i + 1}`,
      border: e.details?.border ?? border,
    });
  });

  return {
    slug,
    title: g.title,
    year: g.year === undefined ? undefined : String(g.year),
    introHtml,
    view: g.view ?? site.defaults?.view ?? 'sequence',
    theme: g.theme ?? site.defaults?.theme ?? 'light',
    cover,
    frames,
    imageCount: list.length,
    captionLines: lines,
    draft,
  };
}

async function loadPage(contentDir: string, name: string, where: (msg: string) => string): Promise<Page> {
  const file = path.join(contentDir, name);
  if (!(await isFile(file))) throw new ContentError([where(`page not found: ${name}`)]);
  let src = await readFile(file, 'utf8');
  const slug = name.replace(/\.md$/, '');
  let title: string | undefined;
  const fm = /^---\n([\s\S]*?)\n---\n/.exec(src);
  if (fm) {
    const doc = parseDocument(fm[1]!);
    const t = doc.get('title');
    if (typeof t === 'string') title = t;
    src = src.slice(fm[0].length);
  }
  title ??= slug.charAt(0).toUpperCase() + slug.slice(1);
  return { slug, title, html: await marked.parse(src) };
}

export interface LoadOptions {
  contentDir: string;
  /** Include galleries not listed in site.yaml, marked as drafts. */
  drafts: boolean;
}

export async function loadSite({ contentDir, drafts }: LoadOptions): Promise<Site> {
  const warnings: string[] = [];
  const { data: site, where } = await loadYaml(path.join(contentDir, 'site.yaml'), SiteFile, 'site.yaml');

  const problems: string[] = [];
  const listed = site.galleries;
  listed.forEach((slug, i) => {
    if (RESERVED_SLUGS.has(slug)) problems.push(where(['galleries', i], `reserved name: ${slug}`));
    if (listed.indexOf(slug) !== i) problems.push(where(['galleries', i], `gallery listed twice: ${slug}`));
  });
  for (const [i, slug] of listed.entries()) {
    if (!(await isFile(path.join(contentDir, 'galleries', slug, 'gallery.yaml')))) {
      problems.push(where(['galleries', i], `missing galleries/${slug}/gallery.yaml`));
    }
  }
  const pageSlugs = (site.pages ?? []).map((p) => p.replace(/\.md$/, ''));
  pageSlugs.forEach((slug, i) => {
    if (listed.includes(slug)) problems.push(where(['pages', i], `page and gallery share the name: ${slug}`));
  });
  if (problems.length) throw new ContentError(problems);

  const galleriesDir = path.join(contentDir, 'galleries');
  const unlisted: string[] = [];
  if (await isDir(galleriesDir)) {
    for (const name of (await readdir(galleriesDir)).sort(collator.compare)) {
      if (listed.includes(name)) continue;
      if (await isFile(path.join(galleriesDir, name, 'gallery.yaml'))) unlisted.push(name);
    }
  }
  if (unlisted.length && !drafts) warnings.push(`not built (not listed in site.yaml): ${unlisted.join(', ')}`);

  const draftSlugs = drafts ? unlisted.filter((s) => !RESERVED_SLUGS.has(s) && !pageSlugs.includes(s)) : [];
  const galleries = await Promise.all([
    ...listed.map((slug) => loadGallery(contentDir, slug, site, false, warnings)),
    ...draftSlugs.map((slug) => loadGallery(contentDir, slug, site, true, warnings)),
  ]);
  const pages = await Promise.all(
    (site.pages ?? []).map((name, i) => loadPage(contentDir, name, (msg) => where(['pages', i], msg))),
  );

  return {
    title: site.title,
    description: site.description,
    footer: site.footer,
    theme: site.defaults?.theme ?? 'light',
    galleries,
    pages,
    warnings,
  };
}

/** Derivative files referenced by `site`, relative to the img cache. */
export function usedImageFiles(site: Site): string[] {
  const files = new Set<string>();
  const add = (img: Img) => {
    for (const v of img.variants) {
      files.add(path.basename(v.jpeg));
      files.add(path.basename(v.avif));
    }
  };
  for (const g of site.galleries) {
    add(g.cover);
    for (const f of g.frames) if (f.kind === 'image') add(f.image);
  }
  return [...files];
}
