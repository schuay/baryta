// Image analysis and derivative generation, cached on disk by content hash.
//
// Cache layout under CACHE_DIR:
//   hashes/<sha1(path)>.json  stat key -> content hash, avoids rehashing
//   meta/<id>.json            dimensions, neutrality, embedded caption
//   img/<id>-<edge>.{jpg,avif} derivatives, served under IMG_PREFIX
import sharp from 'sharp';
import exifr from 'exifr';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, stat, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import type { Img, Variant } from './model.ts';
import { CACHE_DIR, IMG_PREFIX } from './env.ts';

/** Bump when encoding changes so stale derivatives are not reused. */
const PIPELINE = '1';

/** Long-edge sizes of the derivative ladder, in pixels. */
const LONG_EDGES = [480, 800, 1200, 1600, 2000, 2560, 3200, 4000, 5000, 6000, 8000];

/**
 * 99th-percentile per-pixel chroma (max - min of R, G, B, 8-bit) at or below
 * which an image counts as neutral. Neutral scans measure 0-2; scans of toned
 * prints measure 20 and up.
 */
const NEUTRAL_P99 = 3;

export interface Embedded {
  title?: string;
  description?: string;
}

interface Analysis {
  width: number;
  height: number;
  neutral: boolean;
  embedded: Embedded;
}

export interface ProcessedImage {
  img: Img;
  embedded: Embedded;
  /** Derivative file names relative to the img cache directory. */
  files: string[];
}

const imgDir = path.join(CACHE_DIR, 'img');

async function exists(p: string) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function writeAtomic(dest: string, data: Buffer | string) {
  const tmp = `${dest}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, dest);
}

async function readJson<T>(p: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(p, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

async function contentHash(file: string): Promise<string> {
  const st = await stat(file);
  const key = createHash('sha1').update(file).digest('hex');
  const record = path.join(CACHE_DIR, 'hashes', `${key}.json`);
  const cached = await readJson<{ size: number; mtimeMs: number; hash: string }>(record);
  if (cached && cached.size === st.size && cached.mtimeMs === st.mtimeMs) return cached.hash;
  const hash = createHash('sha256').update(await readFile(file)).digest('hex');
  await mkdir(path.dirname(record), { recursive: true });
  await writeAtomic(record, JSON.stringify({ size: st.size, mtimeMs: st.mtimeMs, hash }));
  return hash;
}

/** XMP lang-alt values arrive as {lang, value}, arrays of those, or strings. */
function text(v: unknown): string | undefined {
  if (typeof v === 'string') return v.trim() || undefined;
  if (Array.isArray(v)) return text(v[0]);
  if (v && typeof v === 'object' && 'value' in v) return text((v as { value: unknown }).value);
  return undefined;
}

async function readEmbedded(buf: Buffer): Promise<Embedded> {
  // EXIF ImageDescription is deliberately ignored: scanners and cameras fill it
  // with file paths and model names. XMP and IPTC title/description are what
  // photo managers write.
  const m = await exifr
    .parse(buf, { xmp: true, iptc: true, tiff: false, exif: false, gps: false, ifd1: false })
    .catch(() => undefined);
  if (!m) return {};
  return {
    title: text(m.title) ?? text(m.ObjectName),
    description: text(m.description) ?? text(m.Caption),
  };
}

async function analyze(buf: Buffer): Promise<Analysis> {
  const meta = await sharp(buf).metadata();
  const { data, info } = await sharp(buf)
    .resize(256, 256, { fit: 'inside' })
    .toColourspace('srgb')
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let neutral = true;
  if (info.channels >= 3) {
    const histogram = new Uint32Array(256);
    for (let i = 0; i < data.length; i += info.channels) {
      const r = data[i]!, g = data[i + 1]!, b = data[i + 2]!;
      histogram[Math.max(r, g, b) - Math.min(r, g, b)]!++;
    }
    const pixels = data.length / info.channels;
    let seen = 0;
    let p99 = 0;
    for (; p99 < 256; p99++) {
      seen += histogram[p99]!;
      if (seen >= pixels * 0.99) break;
    }
    neutral = p99 <= NEUTRAL_P99;
  }
  const { width, height } = meta.autoOrient ?? meta;
  if (!width || !height) throw new Error('cannot read image dimensions');
  return { width, height, neutral, embedded: await readEmbedded(buf) };
}

function ladder(width: number, height: number, max: number): number[] {
  const top = Math.min(Math.max(width, height), max);
  const edges = LONG_EDGES.filter((e) => e < top);
  edges.push(top);
  return edges;
}

async function encode(buf: Buffer, edge: number, a: Analysis, id: string): Promise<string[]> {
  const scale = edge / Math.max(a.width, a.height);
  const width = Math.round(a.width * scale);
  const base = sharp(buf).rotate().resize({ width });
  const out = a.neutral ? base.toColourspace('b-w') : base.withIccProfile('srgb');
  const jpg = `${id}-${edge}.jpg`;
  const avif = `${id}-${edge}.avif`;
  if (!(await exists(path.join(imgDir, jpg)))) {
    const data = await out.clone().jpeg({ quality: 86, mozjpeg: true, chromaSubsampling: '4:4:4' }).toBuffer();
    await writeAtomic(path.join(imgDir, jpg), data);
  }
  if (!(await exists(path.join(imgDir, avif)))) {
    const data = await out.clone().avif({ quality: 64, effort: 2, chromaSubsampling: '4:4:4' }).toBuffer();
    await writeAtomic(path.join(imgDir, avif), data);
  }
  return [jpg, avif];
}

// Bounds concurrent encodes; libvips already parallelizes within one image.
const SLOTS = 2;
let active = 0;
const waiting: (() => void)[] = [];
async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= SLOTS) await new Promise<void>((r) => waiting.push(r));
  active++;
  try {
    return await fn();
  } finally {
    active--;
    waiting.shift()?.();
  }
}

const pending = new Map<string, Promise<ProcessedImage>>();

/** Analyzes `file` and ensures all derivatives exist. */
export function processImage(file: string, max: number): Promise<ProcessedImage> {
  const key = `${file}\0${max}`;
  let p = pending.get(key);
  if (!p) {
    p = doProcess(file, max).finally(() => pending.delete(key));
    pending.set(key, p);
  }
  return p;
}

async function doProcess(file: string, max: number): Promise<ProcessedImage> {
  const hash = await contentHash(file);
  const id = createHash('sha256').update(`${hash}:${PIPELINE}`).digest('hex').slice(0, 16);
  const metaFile = path.join(CACHE_DIR, 'meta', `${id}.json`);
  let a = await readJson<Analysis>(metaFile);
  const edges = a ? ladder(a.width, a.height, max) : [];
  const complete =
    a !== undefined &&
    (await Promise.all(edges.flatMap((e) => [`${id}-${e}.jpg`, `${id}-${e}.avif`].map((f) => exists(path.join(imgDir, f)))))).every(Boolean);

  let files: string[];
  if (a && complete) {
    files = edges.flatMap((e) => [`${id}-${e}.jpg`, `${id}-${e}.avif`]);
  } else {
    files = await withSlot(async () => {
      const buf = await readFile(file);
      if (!a) {
        a = await analyze(buf);
        await mkdir(path.dirname(metaFile), { recursive: true });
        await writeAtomic(metaFile, JSON.stringify(a));
      }
      await mkdir(imgDir, { recursive: true });
      const out: string[] = [];
      for (const e of ladder(a.width, a.height, max)) out.push(...(await encode(buf, e, a, id)));
      return out;
    });
  }

  const analysis = a!;
  const variants: Variant[] = ladder(analysis.width, analysis.height, max).map((e) => {
    const scale = e / Math.max(analysis.width, analysis.height);
    return {
      width: Math.round(analysis.width * scale),
      height: Math.round(analysis.height * scale),
      jpeg: `${IMG_PREFIX}${id}-${e}.jpg`,
      avif: `${IMG_PREFIX}${id}-${e}.avif`,
    };
  });
  return {
    img: { id, width: analysis.width, height: analysis.height, neutral: analysis.neutral, variants },
    embedded: analysis.embedded,
    files,
  };
}

export const IMG_CACHE_DIR = imgDir;
