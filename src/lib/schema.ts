// Schemas for the files authors write. They describe input shapes only;
// load.ts expands the shorthand forms into the model in model.ts.
import { z } from 'astro/zod';

export const Theme = z.enum(['light', 'dark']);
export const View = z.enum(['sequence', 'grid']);
export const Border = z.enum(['none', 'hairline']);

const Year = z.union([z.string(), z.number().int()]);
const IMAGE_FILE = /\.(jpe?g|png|tiff?|webp|avif)$/i;

export const Slug = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'use lowercase letters, digits and dashes');

const Fraction = z.number().min(0).max(1);

/** x, y, width, height as fractions of the containing area. */
export const Rect = z
  .tuple([Fraction, Fraction, Fraction, Fraction])
  .refine(([x, y, w, h]) => x + w <= 1.0001 && y + h <= 1.0001, 'rectangle extends outside the area');

/** Width/height as `4/5` or a number. */
export const Aspect = z.union([
  z.number().positive(),
  z.string().regex(/^\d+(\.\d+)?\/\d+(\.\d+)?$/, 'expected a ratio like 4/5'),
]);

/** Where an image sits in a slot it does not fill. inner/outer refer to the gutter. */
export const Align = z.enum(['center', 'top', 'bottom', 'left', 'right', 'inner', 'outer']);

/** Scale of a single image on a page or spread; bleed fills it edge to edge. */
export const Scale = z.enum(['small', 'medium', 'large', 'bleed']);

/** Caption and display details of one image. */
export const Details = z.strictObject({
  title: z.string().optional(),
  year: Year.optional(),
  medium: z.string().optional(),
  size: z.string().optional(),
  caption: z.string().optional(),
  alt: z.string().optional(),
  border: Border.optional(),
});

/** `file.jpg`, `file.jpg: caption` or `file.jpg: { details }`. */
export const ImageRef = z.union(
  [
    z.string().regex(IMAGE_FILE, 'expected an image file name'),
    z
      .record(z.string().regex(IMAGE_FILE, 'expected an image file name'), z.union([z.string(), Details]))
      .refine((o) => Object.keys(o).length === 1, 'one image per entry'),
  ],
  { error: 'expected `file.jpg`, `file.jpg: caption` or `file.jpg: { details }`' },
);

/** An entry of `images:`: one image, or a list of images shown side by side. */
export const ImageEntry = z.union([ImageRef, z.array(ImageRef).min(2).max(6)], {
  error: 'expected an image, or a list of 2 to 6 images shown together',
});

/** One slot of a named layout, relative to the page's live area. */
export const Slot = z.strictObject({ at: Rect, align: Align.optional() });

/** A single placed image; caption fields as in Details. */
export const PlacedImage = Details.extend({
  image: z.string().regex(IMAGE_FILE, 'expected an image file name'),
  scale: Scale.optional(),
  align: Align.optional(),
  at: Rect.optional(),
});

export const LayoutUse = z.strictObject({ layout: z.string(), images: z.array(ImageRef).min(1) });
export const Fill = z.strictObject({ fill: z.string().regex(/^#[0-9a-fA-F]{3,8}$/, 'expected a colour like #e3b649') });
export const Text = z.strictObject({ text: z.string(), at: Rect.optional() });

/** Free placement: a list of items, each with `at`. */
export const Placed = z.array(
  z.union([PlacedImage.required({ at: true }), Text.required({ at: true }), Fill.extend({ at: Rect })], {
    error: 'expected `{ image: ..., at: [...] }`, `{ text: ..., at: [...] }` or `{ fill: ..., at: [...] }`',
  }),
);

/** The content of one page, or of a whole spread. */
export const PageSpec = z.union(
  [z.null(), ImageRef, PlacedImage, LayoutUse, Fill, Text, Placed],
  { error: 'expected a page: `~`, an image, `{ image: ... }`, `{ layout: ..., images: [...] }`, `{ fill: ... }`, `{ text: ... }` or a list of placed items' },
);

export const SpreadSpec = z.union(
  [
    z.tuple([PageSpec, PageSpec]),
    z.strictObject({ left: PageSpec.optional(), right: PageSpec.optional() }),
    z.strictObject({ spread: PageSpec }),
  ],
  { error: 'expected `[left, right]`, `{ left: ..., right: ... }` or `{ spread: ... }`' },
);

export const Book = z.strictObject({
  page: Aspect.optional(),
  /** Page margins as fractions of the page width. */
  margins: z
    .strictObject({ top: Fraction, bottom: Fraction, inner: Fraction, outer: Fraction })
    .partial()
    .optional(),
  /** Draw the pages as paper on a darker ground. */
  paper: z.boolean().optional(),
});

export const GalleryFile = z
  .strictObject({
    title: z.string(),
    year: Year.optional(),
    intro: z.string().optional(),
    view: View.optional(),
    theme: Theme.optional(),
    border: Border.optional(),
    cover: z.string().optional(),
    images: z.array(ImageEntry).min(1).optional(),
    book: Book.optional(),
    spreads: z.array(SpreadSpec).min(1).optional(),
  })
  .refine((g) => !(g.images && g.spreads), {
    message: 'a gallery has either `images` or `spreads`, not both',
    path: ['spreads'],
  })
  .refine((g) => !g.book || g.spreads, { message: '`book` settings need `spreads`', path: ['book'] });

export const SiteFile = z.strictObject({
  title: z.string(),
  description: z.string().optional(),
  galleries: z.array(Slug).min(1),
  pages: z.array(z.string().regex(/^[a-z0-9][a-z0-9-]*\.md$/, 'expected a file name like about.md')).optional(),
  footer: z.string().optional(),
  defaults: z
    .strictObject({ theme: Theme, view: View, border: Border })
    .partial()
    .optional(),
  images: z
    .strictObject({
      /** Longest edge of the largest published derivative, in pixels. */
      max: z.number().int().min(640).max(8000),
    })
    .partial()
    .optional(),
  /** Named page layouts, added to the built-in ones. */
  layouts: z.record(Slug, z.array(Slot).min(1)).optional(),
  /**
   * Galleries published only under /p/<key>/, linked from nowhere. The key is
   * the only secret: keep site.yaml private.
   */
  private: z
    .record(
      Slug,
      z.string().regex(/^[A-Za-z0-9_-]{22,}$/, 'use a random key of at least 22 letters, digits, - or _; `npm run new-key` makes one'),
    )
    .optional(),
});

export type GalleryFile = z.infer<typeof GalleryFile>;
export type SiteFile = z.infer<typeof SiteFile>;
export type Details = z.infer<typeof Details>;
export type ImageRef = z.infer<typeof ImageRef>;
export type PageSpec = z.infer<typeof PageSpec>;
export type SpreadSpec = z.infer<typeof SpreadSpec>;
export type Slot = z.infer<typeof Slot>;
export type Align = z.infer<typeof Align>;
export type Scale = z.infer<typeof Scale>;
export type Book = z.infer<typeof Book>;
export type PlacedImage = z.infer<typeof PlacedImage>;
export type LayoutUse = z.infer<typeof LayoutUse>;
export type Fill = z.infer<typeof Fill>;
export type Text = z.infer<typeof Text>;
export type Placed = z.infer<typeof Placed>;
