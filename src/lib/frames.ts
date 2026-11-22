// Expands a gallery's `images:` or `spreads:` into plate frames.
import { marked } from 'marked';
import type {
  Details,
  Fill,
  GalleryFile,
  ImageRef,
  LayoutUse,
  PageSpec,
  Placed,
  PlacedImage,
  Slot,
  SpreadSpec,
  Text,
} from './schema.ts';
import type { Border, Caption, Column, Content, Frame, Img, PlateFrame, Region } from './model.ts';
import type { Embedded } from './images.ts';
import {
  DEFAULT_MARGINS,
  DEFAULT_PAGE_ASPECT,
  fit,
  groupColumns,
  liveArea,
  naturalLimit,
  pageRect,
  scaled,
  within,
  type Rect,
  type Side,
} from './layout.ts';

export type Path = (string | number)[];

export interface ImageInfo {
  img: Img;
  embedded: Embedded;
}

export interface BuildContext {
  galleryTitle: string;
  border: Border;
  layouts: Record<string, Slot[]>;
  /** Processed image for a file; undefined if missing (reported by the caller). */
  image: (file: string) => ImageInfo | undefined;
  problem: (at: Path, msg: string) => void;
}

interface Ref {
  file: string;
  at: Path;
  caption?: string;
  details?: Details;
}

/** The forms a page (or a whole spread) can take, told apart once. */
type Page =
  | { kind: 'blank' }
  | { kind: 'ref'; ref: ImageRef }
  | { kind: 'placed'; spec: PlacedImage }
  | { kind: 'layout'; spec: LayoutUse }
  | { kind: 'fill'; spec: Fill }
  | { kind: 'text'; spec: Text }
  | { kind: 'free'; items: Placed };

function classify(p: PageSpec): Page {
  if (p === null) return { kind: 'blank' };
  if (typeof p === 'string') return { kind: 'ref', ref: p };
  if (Array.isArray(p)) return { kind: 'free', items: p };
  // `file.jpg: caption` maps have a file name as their only key; the schema
  // guarantees the other forms do not.
  if ('layout' in p && 'images' in p) return { kind: 'layout', spec: p as LayoutUse };
  if ('image' in p && typeof p.image === 'string') return { kind: 'placed', spec: p as PlacedImage };
  if ('fill' in p && typeof p.fill === 'string') return { kind: 'fill', spec: p as Fill };
  if ('text' in p && typeof p.text === 'string') return { kind: 'text', spec: p as Text };
  return { kind: 'ref', ref: p as ImageRef };
}

function toRef(r: ImageRef, at: Path): Ref {
  if (typeof r === 'string') return { file: r, at };
  const [file, v] = Object.entries(r)[0]!;
  return typeof v === 'string' ? { file, at, caption: v } : { file, at, details: v };
}

function placedRef(p: PlacedImage, at: Path): Ref {
  const { title, year, medium, size, caption, alt, border } = p;
  return { file: p.image, at: [...at, 'image'], details: { title, year, medium, size, caption, alt, border } };
}

function pagesOf(s: SpreadSpec): [string | number, PageSpec][] {
  if (Array.isArray(s)) return [[0, s[0]], [1, s[1]]];
  if ('spread' in s) return [['spread', s.spread]];
  return [['left', s.left ?? null], ['right', s.right ?? null]];
}

/** Every image file a gallery references, with where it is referenced. */
export function imageRefs(g: GalleryFile): Ref[] {
  const refs: Ref[] = [];
  g.images?.forEach((e, i) => {
    if (Array.isArray(e)) e.forEach((r, j) => refs.push(toRef(r, ['images', i, j])));
    else refs.push(toRef(e, ['images', i]));
  });
  g.spreads?.forEach((s, i) => {
    for (const [key, spec] of pagesOf(s)) {
      const at: Path = ['spreads', i, key];
      const page = classify(spec);
      if (page.kind === 'ref') refs.push(toRef(page.ref, at));
      else if (page.kind === 'placed') refs.push(placedRef(page.spec, at));
      else if (page.kind === 'layout') page.spec.images.forEach((r, k) => refs.push(toRef(r, [...at, 'images', k])));
      else if (page.kind === 'free') {
        page.items.forEach((item, k) => {
          if ('image' in item) refs.push(placedRef(item, [...at, k]));
        });
      }
    }
  });
  return refs;
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

/** Number of caption lines, estimating wrapped lines at `perLine` characters. */
export function captionLines(c: Caption | undefined, perLine: number): number {
  if (!c) return 0;
  const lines = (s: string | undefined) => (s ? Math.ceil(s.length / perLine) : 0);
  const head = [c.title, c.year].filter(Boolean).join(', ');
  return lines(head) + lines(c.medium) + lines(c.size) + lines(c.text);
}

function markdown(src: string): string {
  return marked.parse(src, { async: false });
}

/** An image, fill or text placed in frame units, before it is assigned to a column. */
interface Item {
  rect: Rect;
  content: Content;
  caption?: Caption;
}

type ColumnRect = Rect & { page?: 'left' | 'right' };

export interface FrameResult {
  frames: Frame[];
  /** Largest caption block of any column, in lines. */
  captionLines: number;
}

export function buildFrames(g: GalleryFile, ctx: BuildContext): FrameResult {
  let imageNumber = 0;
  let number = 0;
  let lines = 0;

  const aspectOf = (ref: Ref) => {
    const info = ctx.image(ref.file);
    return info ? info.img.width / info.img.height : 1;
  };

  const imageItem = (ref: Ref, rect: Rect, fitMode: 'contain' | 'cover'): Item[] => {
    const info = ctx.image(ref.file);
    if (!info) return [];
    imageNumber++;
    // A caption given in the config replaces embedded metadata entirely, so the
    // two sources are never mixed on one image.
    let caption: Caption | undefined;
    if (ref.caption !== undefined) caption = { text: ref.caption };
    else if (ref.details) caption = captionFromDetails(ref.details);
    if (!caption && (info.embedded.title || info.embedded.description)) {
      caption = { title: info.embedded.title, text: info.embedded.description };
    }
    const alt = ref.details?.alt ?? caption?.title ?? caption?.text ?? `${ctx.galleryTitle}, image ${imageNumber}`;
    const border = ref.details?.border ?? ctx.border;
    return [{ rect, caption, content: { kind: 'image', image: info.img, alt, border, fit: fitMode } }];
  };

  const plate = (aspect: number, columnRects: ColumnRect[], items: Item[], splittable: boolean): PlateFrame => {
    const perLine = columnRects.length > 1 ? 40 : 60;
    const columns: Column[] = columnRects.map((c) => {
      const inside = items
        .filter((it) => {
          const mid = it.rect.x + it.rect.w / 2;
          return mid >= c.x && mid <= c.x + c.w;
        })
        .sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x);
      const regions: Region[] = inside.map((it) => ({
        box: [(it.rect.x - c.x) / c.w, it.rect.y, it.rect.w / c.w, it.rect.h],
        content: it.content,
      }));
      const captions = inside.flatMap((it) => (it.caption ? [it.caption] : []));
      lines = Math.max(lines, captions.reduce((n, cap) => n + captionLines(cap, perLine), 0));
      const images = inside.filter((it) => it.content.kind === 'image');
      const above = inside.filter((it) => it.content.kind !== 'fill');
      const captionTop = above.length ? Math.max(...above.map((it) => it.rect.y + it.rect.h)) : 1;
      const captionLeft = images.length ? Math.min(...images.map((it) => (it.rect.x - c.x) / c.w)) : 0;
      return { x: c.x / aspect, w: c.w / aspect, aspect: c.w, page: c.page, regions, captions, captionTop, captionLeft };
    });
    let naturalWidth = Infinity;
    for (const it of items) {
      if (it.content.kind === 'image') {
        const { width, height } = it.content.image;
        naturalWidth = Math.min(naturalWidth, naturalLimit(aspect, it.rect, width, height));
      }
    }
    return {
      kind: 'plate',
      number: ++number,
      aspect,
      columns,
      naturalWidth: Number.isFinite(naturalWidth) ? Math.floor(naturalWidth) : 4000,
      splittable,
    };
  };

  const frames: Frame[] = [];
  if (g.intro) frames.push({ kind: 'text', html: markdown(g.intro) });

  g.images?.forEach((entry, i) => {
    const refs = Array.isArray(entry) ? entry.map((r, j) => toRef(r, ['images', i, j])) : [toRef(entry, ['images', i])];
    const { aspect, columns } = groupColumns(refs.map(aspectOf));
    const items = refs.flatMap((r, k) => imageItem(r, columns[k]!, 'contain'));
    frames.push(plate(aspect, columns, items, refs.length > 1));
  });

  if (g.spreads) {
    const page = parseAspect(g.book?.page) ?? DEFAULT_PAGE_ASPECT;
    const margins = { ...DEFAULT_MARGINS, ...g.book?.margins };

    /** Items of one page, or of the whole spread for side 'spread'. */
    const pageItems = (spec: PageSpec, side: Side, at: Path): Item[] => {
      const area = pageRect(page, side);
      const live = liveArea(page, side, margins);
      const p = classify(spec);
      switch (p.kind) {
        case 'blank':
          return [];
        case 'ref': {
          const ref = toRef(p.ref, at);
          return imageItem(ref, fit(live, aspectOf(ref), undefined, side), 'contain');
        }
        case 'placed': {
          const ref = placedRef(p.spec, at);
          const { scale = 'large', align } = p.spec;
          if (p.spec.at) return imageItem(ref, fit(within(area, p.spec.at), aspectOf(ref), align, side), 'contain');
          if (scale === 'bleed') return imageItem(ref, area, 'cover');
          return imageItem(ref, fit(scaled(live, scale, align, side), aspectOf(ref), align, side), 'contain');
        }
        case 'layout': {
          const slots = ctx.layouts[p.spec.layout];
          if (!slots) {
            ctx.problem([...at, 'layout'], `unknown layout "${p.spec.layout}"; known: ${Object.keys(ctx.layouts).join(', ')}`);
            return [];
          }
          if (p.spec.images.length !== slots.length) {
            ctx.problem([...at, 'images'], `layout "${p.spec.layout}" takes ${slots.length} images, got ${p.spec.images.length}`);
            return [];
          }
          return p.spec.images.flatMap((r, k) => {
            const ref = toRef(r, [...at, 'images', k]);
            const slot = slots[k]!;
            return imageItem(ref, fit(within(live, slot.at), aspectOf(ref), slot.align, side), 'contain');
          });
        }
        case 'fill':
          return [{ rect: area, content: { kind: 'fill', color: p.spec.fill } }];
        case 'text':
          return [{ rect: p.spec.at ? within(area, p.spec.at) : live, content: { kind: 'text', html: markdown(p.spec.text) } }];
        case 'free':
          return p.items.flatMap((item, k): Item[] => {
            const rect = within(area, item.at);
            if ('image' in item) {
              const ref = placedRef(item, [...at, k]);
              return imageItem(ref, fit(rect, aspectOf(ref), item.align, side), 'contain');
            }
            if ('text' in item) return [{ rect, content: { kind: 'text', html: markdown(item.text) } }];
            return [{ rect, content: { kind: 'fill', color: item.fill } }];
          });
      }
    };

    g.spreads.forEach((s, i) => {
      const at: Path = ['spreads', i];
      if (!Array.isArray(s) && 'spread' in s) {
        const items = pageItems(s.spread, 'spread', [...at, 'spread']);
        frames.push(plate(2 * page, [pageRect(page, 'spread')], items, false));
        return;
      }
      const [[lk, left], [rk, right]] = pagesOf(s) as [[string | number, PageSpec], [string | number, PageSpec]];
      const items = [...pageItems(left, 'left', [...at, lk]), ...pageItems(right, 'right', [...at, rk])];
      const columns: ColumnRect[] = [
        { ...pageRect(page, 'left'), page: 'left' },
        { ...pageRect(page, 'right'), page: 'right' },
      ];
      frames.push(plate(2 * page, columns, items, true));
    });
  }

  return { frames, captionLines: lines };
}

export function parseAspect(a: string | number | undefined): number | undefined {
  if (a === undefined) return undefined;
  if (typeof a === 'number') return a;
  const [w, h] = a.split('/').map(Number);
  return w! / h!;
}
