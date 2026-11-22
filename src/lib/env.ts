import path from 'node:path';

/** Directory holding site.yaml, pages and galleries/. */
export const CONTENT_DIR = path.resolve(process.env.FOLIO_CONTENT ?? 'example');

/** Persistent cache for image analysis and derivatives. */
export const CACHE_DIR = path.resolve(process.env.FOLIO_CACHE ?? '.cache');

/** URL prefix under which image derivatives are served. */
export const IMG_PREFIX = '/_img/';
