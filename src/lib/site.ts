import { loadSite } from './load.ts';
import { CONTENT_DIR } from './env.ts';
import type { Gallery, Site } from './model.ts';

let built: Promise<Site> | undefined;
const reported = new Set<string>();

function report(site: Site) {
  for (const w of site.warnings) {
    if (reported.has(w)) continue;
    reported.add(w);
    console.warn(`[folio] ${w}`);
  }
  return site;
}

/**
 * The dev server reloads content on every request and shows unlisted
 * galleries as drafts; a build loads once and publishes listed galleries only.
 */
export function getSite(): Promise<Site> {
  if (import.meta.env.DEV) return loadSite({ contentDir: CONTENT_DIR, drafts: true }).then(report);
  built ??= loadSite({ contentDir: CONTENT_DIR, drafts: false }).then(report);
  return built;
}

export function listedGalleries(site: Site): Gallery[] {
  return site.galleries.filter((g) => !g.draft);
}
