// Schemas for the files authors write. They describe input shapes only;
// load.ts expands the shorthand forms into the model in model.ts.
import { z } from 'astro/zod';

export const Theme = z.enum(['light', 'dark']);
export const View = z.enum(['sequence', 'grid']);
export const Border = z.enum(['none', 'hairline']);

const Year = z.union([z.string(), z.number().int()]);

export const Slug = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'use lowercase letters, digits and dashes');

/** Per-image details in the `file.jpg: { ... }` form. */
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
export const ImageEntry = z.union([
  z.string(),
  z
    .record(z.string(), z.union([z.string(), Details]))
    .refine((o) => Object.keys(o).length === 1, {
      message: 'an image entry is `file.jpg`, `file.jpg: caption` or `file.jpg: { details }`',
    }),
]);

export const GalleryFile = z.strictObject({
  title: z.string(),
  year: Year.optional(),
  intro: z.string().optional(),
  view: View.optional(),
  theme: Theme.optional(),
  border: Border.optional(),
  cover: z.string().optional(),
  images: z.array(ImageEntry).min(1).optional(),
});

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
});

export type GalleryFile = z.infer<typeof GalleryFile>;
export type SiteFile = z.infer<typeof SiteFile>;
export type Details = z.infer<typeof Details>;
