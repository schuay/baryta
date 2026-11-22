// The normalized site model. Every config form is expanded into these types;
// templates only consume this model.
//
// Single images, groups and book spreads all become a PlateFrame: a box of
// fixed aspect ratio divided into columns (the images of a group, the pages of
// a spread), each holding regions placed in fractions of the column.

export type Theme = 'light' | 'dark';
export type View = 'sequence' | 'grid';
export type Border = 'none' | 'hairline';

export interface Variant {
  width: number;
  height: number;
  jpeg: string;
  avif: string;
}

export interface Img {
  /** Content hash of the source file plus pipeline version. */
  id: string;
  width: number;
  height: number;
  /** True if the source has no visible chroma; derivatives are then greyscale. */
  neutral: boolean;
  /** Ascending by width. */
  variants: Variant[];
}

export interface Caption {
  title?: string;
  year?: string;
  medium?: string;
  size?: string;
  text?: string;
}

/** x, y, width, height as fractions of the containing box. */
export type Box = [number, number, number, number];

export type Content =
  | {
      kind: 'image';
      image: Img;
      alt: string;
      border: Border;
      /** cover crops the image to the region (bleed); contain shows all of it. */
      fit: 'contain' | 'cover';
    }
  | { kind: 'fill'; color: string }
  | { kind: 'text'; html: string };

export interface Region {
  /** Relative to the column. */
  box: Box;
  content: Content;
}

export interface Column {
  /** Horizontal extent as fractions of the frame width. */
  x: number;
  w: number;
  /** Width/height of the column. */
  aspect: number;
  /** Set for the pages of a spread. */
  page?: 'left' | 'right';
  regions: Region[];
  /** Captions of the images in this column, in reading order. */
  captions: Caption[];
  /**
   * Where captions start: below the lowest image or text, as a fraction of the
   * column height, and at the left edge of the leftmost image, as a fraction of
   * its width.
   */
  captionTop: number;
  captionLeft: number;
}

export interface PlateFrame {
  kind: 'plate';
  /** 1-based position among the gallery's plates. */
  number: number;
  /** Width/height of the whole frame. */
  aspect: number;
  columns: Column[];
  /**
   * Widest the frame may be drawn, in CSS pixels, without upscaling any of its
   * images beyond their source resolution.
   */
  naturalWidth: number;
  /** On portrait screens, show the columns one at a time. */
  splittable: boolean;
}

export interface TextFrame {
  kind: 'text';
  html: string;
}

export type Frame = PlateFrame | TextFrame;

/** public: listed in the navigation; private: only at its secret path; draft: dev server only. */
export type Visibility = 'public' | 'private' | 'draft';

export interface Gallery {
  slug: string;
  visibility: Visibility;
  /** URL path of the primary view, with trailing slash. */
  path: string;
  title: string;
  year?: string;
  introHtml?: string;
  view: View;
  theme: Theme;
  /** Draw book pages as paper. */
  paper: boolean;
  cover: Img;
  frames: Frame[];
  plateCount: number;
  imageCount: number;
  /** Caption block height in lines, the maximum over all columns. */
  captionLines: number;
}

export interface Page {
  slug: string;
  title: string;
  html: string;
}

export interface Site {
  title: string;
  description?: string;
  footer?: string;
  theme: Theme;
  /** Public galleries in nav order, then private ones, then drafts when enabled. */
  galleries: Gallery[];
  pages: Page[];
  warnings: string[];
}
