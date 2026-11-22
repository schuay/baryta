// Geometry for multi-image frames. Pure functions, no I/O.
//
// Positions are computed in frame units: the frame is 1 high and `aspect`
// wide. A spread of two pages with page aspect p is 2p wide; the left page
// spans x in [0, p], the right page [p, 2p].
import type { Align, Scale, Slot } from './schema.ts';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type Side = 'left' | 'right' | 'spread';

export interface Margins {
  top: number;
  bottom: number;
  inner: number;
  outer: number;
}

/** Fractions of the page width. The heavier bottom margin lifts the live area above the optical centre. */
export const DEFAULT_MARGINS: Margins = { top: 0.09, bottom: 0.13, inner: 0.08, outer: 0.09 };
export const DEFAULT_PAGE_ASPECT = 4 / 5;

/** Gap between the images of a group, as a fraction of their common height. */
export const GROUP_GAP = 0.05;

const SCALE_FACTOR: Record<Exclude<Scale, 'bleed'>, number> = { large: 1, medium: 0.7, small: 0.42 };

/** Built-in layouts; slots are relative to the live area, in the same form as `layouts:` in site.yaml. */
export const BUILTIN_LAYOUTS: Record<string, Slot[]> = {
  pair: [
    { at: [0, 0, 0.47, 1], align: 'right' },
    { at: [0.53, 0, 0.47, 1], align: 'left' },
  ],
  'stack-2': [
    { at: [0, 0, 1, 0.47], align: 'bottom' },
    { at: [0, 0.53, 1, 0.47], align: 'top' },
  ],
  'stack-3': [
    { at: [0, 0, 1, 0.3], align: 'bottom' },
    { at: [0, 0.35, 1, 0.3] },
    { at: [0, 0.7, 1, 0.3], align: 'top' },
  ],
  'grid-2x2': [
    { at: [0, 0, 0.47, 0.47], align: 'bottom' },
    { at: [0.53, 0, 0.47, 0.47], align: 'bottom' },
    { at: [0, 0.53, 0.47, 0.47], align: 'top' },
    { at: [0.53, 0.53, 0.47, 0.47], align: 'top' },
  ],
};

/** Columns of a group shown side by side at equal height. */
export function groupColumns(aspects: number[], gap = GROUP_GAP): { aspect: number; columns: Rect[] } {
  const columns: Rect[] = [];
  let x = 0;
  for (const a of aspects) {
    columns.push({ x, y: 0, w: a, h: 1 });
    x += a + gap;
  }
  return { aspect: x - gap, columns };
}

export function pageRect(page: number, side: Side): Rect {
  if (side === 'spread') return { x: 0, y: 0, w: 2 * page, h: 1 };
  return { x: side === 'left' ? 0 : page, y: 0, w: page, h: 1 };
}

/** The page (or spread) minus its margins. */
export function liveArea(page: number, side: Side, m: Margins): Rect {
  const r = pageRect(page, side);
  const left = side === 'right' ? m.inner : m.outer;
  const right = side === 'left' ? m.inner : m.outer;
  const top = m.top * page;
  const bottom = m.bottom * page;
  return { x: r.x + left * page, y: top, w: r.w - (left + right) * page, h: 1 - top - bottom };
}

/** Maps fractions of `area` to a rectangle in frame units. */
export function within(area: Rect, [x, y, w, h]: readonly [number, number, number, number]): Rect {
  return { x: area.x + x * area.w, y: area.y + y * area.h, w: w * area.w, h: h * area.h };
}

/**
 * Sub-rectangle of the live area for a scale, placed by `align` (centred by
 * default). Bleed is handled by the caller.
 */
export function scaled(live: Rect, scale: Exclude<Scale, 'bleed'>, align: Align | undefined, side: Side): Rect {
  const f = SCALE_FACTOR[scale];
  const freeX = live.w * (1 - f);
  const freeY = live.h * (1 - f);
  const horizontal = resolveAlign(align, side);
  const x = live.x + (horizontal === 'left' ? 0 : horizontal === 'right' ? freeX : freeX / 2);
  const y = live.y + (align === 'top' ? 0 : align === 'bottom' ? freeY : freeY / 2);
  return { x, y, w: live.w * f, h: live.h * f };
}

/** Largest rectangle of aspect `ar` inside `slot`, positioned by `align`. */
export function fit(slot: Rect, ar: number, align: Align | undefined, side: Side): Rect {
  const horizontal = resolveAlign(align, side);
  if (ar > slot.w / slot.h) {
    const h = slot.w / ar;
    const free = slot.h - h;
    const y = slot.y + (align === 'top' ? 0 : align === 'bottom' ? free : free / 2);
    return { x: slot.x, y, w: slot.w, h };
  }
  const w = slot.h * ar;
  const free = slot.w - w;
  const x = slot.x + (horizontal === 'left' ? 0 : horizontal === 'right' ? free : free / 2);
  return { x, y: slot.y, w, h: slot.h };
}

function resolveAlign(align: Align | undefined, side: Side): 'left' | 'right' | 'center' {
  if (align === 'left' || align === 'right') return align;
  if (side === 'spread' || (align !== 'inner' && align !== 'outer')) return 'center';
  const towardsGutter = side === 'left' ? 'right' : 'left';
  return align === 'inner' ? towardsGutter : towardsGutter === 'left' ? 'right' : 'left';
}

/**
 * Widest the frame can be drawn, in pixels, before an image of `width` x
 * `height` pixels shown in `r` would be upscaled.
 */
export function naturalLimit(aspect: number, r: Rect, width: number, height: number): number {
  return aspect * Math.min(width / r.w, height / r.h);
}
