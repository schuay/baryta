// The normalized site model. Every config form is expanded into these types;
// templates only consume this model.

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

export interface ImageFrame {
  kind: 'image';
  /** 1-based position among the gallery's images. */
  number: number;
  image: Img;
  caption?: Caption;
  alt: string;
  border: Border;
}

export interface TextFrame {
  kind: 'text';
  html: string;
}

/** Fixed-aspect page or spread with placed regions. Not produced yet. */
export interface CanvasFrame {
  kind: 'canvas';
  aspect: number;
  pages: 1 | 2;
  regions: Region[];
}

export interface Region {
  /** Fractions of the frame: x, y, width, height. */
  box: [number, number, number, number];
  content: { image: Img; fit: 'contain' | 'cover' } | { fill: string } | { html: string };
}

export type Frame = ImageFrame | TextFrame | CanvasFrame;

export interface Gallery {
  slug: string;
  title: string;
  year?: string;
  introHtml?: string;
  view: View;
  theme: Theme;
  cover: Img;
  frames: Frame[];
  imageCount: number;
  /** Caption block height in lines, the maximum over all frames. */
  captionLines: number;
  draft: boolean;
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
  /** Listed galleries in nav order, followed by drafts when drafts are enabled. */
  galleries: Gallery[];
  pages: Page[];
  warnings: string[];
}
