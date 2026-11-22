// Reads the content directory, validates it and expands it into the model.
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { LineCounter, parseDocument, isNode, type Document } from 'yaml';
import { marked } from 'marked';
import type { z } from 'astro/zod';
import { GalleryFile, SiteFile } from './schema.ts';
import type { Gallery, Img, Page, Site, Visibility } from './model.ts';
import { processImage } from './images.ts';
import { buildFrames, imageRefs } from './frames.ts';
import { BUILTIN_LAYOUTS } from './layout.ts';

const IMAGE_EXT = /\.(jpe?g|png|tiff?|webp|avif)$/i;
const RESERVED_SLUGS = new Set(['_img', '_astro', 'index', 'p']);
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
  const parsed = schema.safeParse(doc.toJS(), { reportInput: true });
  if (!parsed.success) {
    throw new ContentError(
      parsed.error.issues.flatMap((issue) =>
        explain(issue, []).map(({ at, message }) => where(at, `${at.length ? `${formatPath(at)}: ` : ''}${message}`)),
      ),
    );
  }
  return { data: parsed.data, where };
}

type Issue = z.core.$ZodIssue;
type Located = { at: (string | number)[]; message: string };

/** The value has the wrong shape for this alternative altogether, e.g. a list where a map is expected. */
function wrongShape(i: Issue): boolean {
  if (i.path.length) return false;
  if (i.code === 'invalid_type') return true;
  return i.code === 'invalid_union' && i.errors.every((b) => b.some(wrongShape));
}

/**
 * How badly an alternative of a union fits: its problems, counting each
 * unrecognised key, and weighting map keys that cannot be valid (a file name
 * was expected) like a wrong shape.
 */
function misfit(issues: Issue[]): number {
  // Several problems inside one key count once: that key's value is wrong.
  const byKey = new Map<PropertyKey, number>();
  let root = 0;
  for (const i of issues) {
    if (!i.path.length) root += issueMisfit(i);
    else byKey.set(i.path[0]!, Math.max(byKey.get(i.path[0]!) ?? 0, issueMisfit(i)));
  }
  return root + [...byKey.values()].reduce((a, b) => a + b, 0);
}

function issueMisfit(i: Issue): number {
  if (i.code === 'unrecognized_keys') return i.keys.length;
  if (i.code === 'invalid_key') return 3;
  if (i.code === 'invalid_union') {
    const fits = i.errors.filter((b) => b.length && !b.some(wrongShape)).map(misfit);
    return fits.length ? Math.min(...fits) : 1;
  }
  return 1;
}

/**
 * Messages and locations for an issue. A failed union reports the problems of
 * the alternative that fits the input best, e.g. a misspelt key, instead of
 * listing every alternative.
 */
function explain(issue: Issue, prefix: (string | number)[]): Located[] {
  const at = [...prefix, ...issue.path.filter((p): p is string | number => typeof p !== 'symbol')];
  if (issue.code === 'unrecognized_keys') {
    return [{ at, message: `unknown key ${issue.keys.map((k) => `"${k}"`).join(', ')}` }];
  }
  if (issue.code === 'invalid_type' && issue.input === undefined) return [{ at, message: 'missing' }];
  if (issue.code === 'invalid_union') {
    // Alternatives of the wrong type (e.g. a list where a map was given) do not fit at all.
    const candidates = issue.errors.filter((b) => b.length && !b.some(wrongShape));
    if (candidates.length) {
      // On a tie, prefer the alternative that matched deeper into the value.
      const depth = (b: Issue[]) => Math.max(...b.map((i) => i.path.length));
      const best = candidates.reduce((a, b) =>
        misfit(b) < misfit(a) || (misfit(b) === misfit(a) && depth(b) > depth(a)) ? b : a,
      );
      return best.flatMap((i) => explain(i, at));
    }
  }
  return [{ at, message: issue.message }];
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

async function loadGallery(
  contentDir: string,
  slug: string,
  site: SiteFile,
  visibility: Visibility,
  warnings: string[],
): Promise<Gallery> {
  const dir = path.join(contentDir, 'galleries', slug);
  const rel = `galleries/${slug}/gallery.yaml`;
  const { data: g, where } = await loadYaml(path.join(dir, 'gallery.yaml'), GalleryFile, rel);
  const onDisk = (await readdir(dir)).filter((f) => IMAGE_EXT.test(f)).sort(collator.compare);

  // Without `images` or `spreads`, the folder is shown in filename order.
  const config: GalleryFile = g.images || g.spreads ? g : { ...g, images: onDisk };
  const refs = imageRefs(config);
  const problems: string[] = [];
  if (!refs.length) problems.push(`${rel}: no images in galleries/${slug}/`);
  const seen = new Set<string>();
  for (const r of refs) {
    if (!onDisk.includes(r.file)) problems.push(where(r.at, `image not found: ${r.file}`));
    else if (seen.has(r.file)) problems.push(where(r.at, `image used twice: ${r.file}`));
    seen.add(r.file);
  }
  const unused = onDisk.filter((f) => !seen.has(f));
  if (unused.length) warnings.push(`${rel}: not shown (not used in the gallery): ${unused.join(', ')}`);
  if (g.cover && !seen.has(g.cover)) {
    problems.push(where(['cover'], `cover must be one of the gallery's images: ${g.cover}`));
  }
  if (problems.length) throw new ContentError(problems);

  const max = site.images?.max ?? DEFAULT_MAX_EDGE;
  const files = [...seen];
  const processed = await Promise.all(files.map((f) => processImage(path.join(dir, f), max)));
  const byFile = new Map(files.map((f, i) => [f, processed[i]!]));

  const { frames, captionLines } = buildFrames(config, {
    galleryTitle: g.title,
    border: g.border ?? site.defaults?.border ?? 'none',
    layouts: { ...BUILTIN_LAYOUTS, ...site.layouts },
    image: (file) => byFile.get(file),
    problem: (at, msg) => problems.push(where(at, msg)),
  });
  if (problems.length) throw new ContentError(problems);

  const key = site.private?.[slug];
  return {
    slug,
    visibility,
    path: visibility === 'private' ? `/p/${key}/` : `/${slug}/`,
    title: g.title,
    year: g.year === undefined ? undefined : String(g.year),
    introHtml: frames[0]?.kind === 'text' ? frames[0].html : undefined,
    view: g.view ?? site.defaults?.view ?? 'sequence',
    theme: g.theme ?? site.defaults?.theme ?? 'light',
    paper: g.book?.paper ?? false,
    cover: byFile.get(g.cover ?? files[0]!)!.img,
    frames,
    plateCount: frames.filter((f) => f.kind === 'plate').length,
    imageCount: files.length,
    captionLines,
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
  /** Include galleries not named in site.yaml, as drafts. */
  drafts: boolean;
}

export async function loadSite({ contentDir, drafts }: LoadOptions): Promise<Site> {
  const warnings: string[] = [];
  const { data: site, where } = await loadYaml(path.join(contentDir, 'site.yaml'), SiteFile, 'site.yaml');

  const problems: string[] = [];
  const listed = site.galleries;
  const privateSlugs = Object.keys(site.private ?? {});
  listed.forEach((slug, i) => {
    if (RESERVED_SLUGS.has(slug)) problems.push(where(['galleries', i], `reserved name: ${slug}`));
    if (listed.indexOf(slug) !== i) problems.push(where(['galleries', i], `gallery listed twice: ${slug}`));
    if (privateSlugs.includes(slug)) problems.push(where(['galleries', i], `gallery is both listed and private: ${slug}`));
  });
  const keys = Object.values(site.private ?? {});
  privateSlugs.forEach((slug, i) => {
    if (keys.indexOf(keys[i]!) !== i) problems.push(where(['private', slug], `key used twice: ${slug}`));
  });
  const named: [string, (string | number)[]][] = [
    ...listed.map((slug, i): [string, (string | number)[]] => [slug, ['galleries', i]]),
    ...privateSlugs.map((slug): [string, (string | number)[]] => [slug, ['private', slug]]),
  ];
  for (const [slug, at] of named) {
    if (!(await isFile(path.join(contentDir, 'galleries', slug, 'gallery.yaml')))) {
      problems.push(where(at, `missing galleries/${slug}/gallery.yaml`));
    }
  }
  const pageSlugs = (site.pages ?? []).map((p) => p.replace(/\.md$/, ''));
  pageSlugs.forEach((slug, i) => {
    if (listed.includes(slug)) problems.push(where(['pages', i], `page and gallery share the name: ${slug}`));
  });
  if (problems.length) throw new ContentError(problems);

  const galleriesDir = path.join(contentDir, 'galleries');
  const unnamed: string[] = [];
  if (await isDir(galleriesDir)) {
    for (const name of (await readdir(galleriesDir)).sort(collator.compare)) {
      if (listed.includes(name) || privateSlugs.includes(name)) continue;
      if (await isFile(path.join(galleriesDir, name, 'gallery.yaml'))) unnamed.push(name);
    }
  }
  if (unnamed.length && !drafts) warnings.push(`not built (not in site.yaml): ${unnamed.join(', ')}`);

  const draftSlugs = drafts ? unnamed.filter((s) => !RESERVED_SLUGS.has(s) && !pageSlugs.includes(s)) : [];
  const galleries = await Promise.all([
    ...listed.map((slug) => loadGallery(contentDir, slug, site, 'public', warnings)),
    ...privateSlugs.map((slug) => loadGallery(contentDir, slug, site, 'private', warnings)),
    ...draftSlugs.map((slug) => loadGallery(contentDir, slug, site, 'draft', warnings)),
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
    for (const f of g.frames) {
      if (f.kind !== 'plate') continue;
      for (const c of f.columns) for (const r of c.regions) if (r.content.kind === 'image') add(r.content.image);
    }
  }
  return [...files];
}
