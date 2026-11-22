// Downloads the public-domain sample photos used by example/ from Wikimedia
// Commons. Photos are not checked in; the gallery.yaml files are.
import { mkdir, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'example', 'galleries');
const UA = 'folio-example-fetch/0.1';
const MAX_WIDTH = 3000;

const galleries = {
  worthington: {
    '01-stoop.jpg': 'Street scene, Worthington, Ohio, August 1938 - Stoop Sitters crop.jpg',
    '02-crank.jpg': 'Automobile with crank used to get the motor started, Worthington, Ohio August 1938 crop.jpg',
    '03-cranking.jpg': 'Cranking car to get it started, the old way, Worthington, Ohio August 1938 crop.jpg',
    '04-model-t.jpg': 'Cranking Model "T" Ford from before the days of the self-starter, Worthington, Ohio 1938 crop.jpg',
    '05-getting-crank.jpg': 'Getting crank out of car to get the motor started, Worthington, Ohio, 1938 crop.jpg',
  },
  'china-1946': {
    'junk.jpg': 'Arthur Rothstein - Chinese junk on river ppmsca.07797.jpg',
    'boat.jpg': 'A Boat On A River With Rolling Hills In The Background In The Kiangsu Province Or Yunnan Province In China (1946) Arthur Rothstein (RESTORED) (4094285750).jpg',
    'mother.jpg': 'Arthur Rothstein - Chinese mother with children ppmsca.07798.jpg',
    'rice.jpg': 'Arthur Rothstein - Rice distribution during Chinese famine ppmsca.07586.jpg',
    'troops.jpg': 'Arthur Rothstein - marching Chinese troops ppmsca.07799.jpg',
  },
  'american-photographs': {
    'shack-town.jpg': 'Child in Shack Town by Dorothea Lange, 1936, 8b38490a.jpg',
    'broke.jpg': 'Broke, baby sick, and car trouble! - Dorothea Langes photo of a Missouri family of five in the vicinity of Tracy, California.jpg',
    'cotton-hoers.jpg': 'Dorothea Lange "These cotton hoers work from 6 a.m. to 7 p.m. for $1.00 near Clarksdale, Mississippi, June-July 1937.".jpg',
    'weedpatch.jpg': 'Children Living in a Camp Between Weedpatch and Lamont, Kern County, California (3679502846).jpg',
    'boardwalk.jpg': 'Walker Evans Boardwalk.jpg',
    'havana.jpg': 'Plaza del Vapor Havana, Cuba Walker Evans.jpg',
    'times-square.jpg': 'Times Square on a Rainy Day 1943 John Vachon.jpg',
    'bootleggers.jpg': "Jack Delano, The day's output & Bootleggers, Schuylkill County, Pennsylvania, ca. 1938.jpg",
    'coal.jpg': 'Loading coal into a lake freighter at the Pennsylvania Railroad docks, Sandusky, Ohio LCCN2017878195.jpg',
    'headlines.jpg': 'Men and a woman reading headlines posted in street-corner window of Brockton Enterprise newspaper office on Christmas Eve, Brockton, Mass. LCCN2017877372.jpg',
    'cemetery.jpg': 'Cemetery at Pointe a la Hache, Louisiana, October 1935, by Ben Shahn - crop.jpg',
  },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Commons rate-limits bursts; back off on 429.
async function get(url) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers: { 'User-Agent': UA } });
    if (res.status !== 429 || attempt === 5) return res;
    await sleep(2000 * 2 ** attempt);
  }
}

async function exists(p) {
  try { await access(p); return true; } catch { return false; }
}

async function imageUrl(title) {
  const api = new URL('https://commons.wikimedia.org/w/api.php');
  api.search = new URLSearchParams({
    action: 'query', titles: `File:${title}`, prop: 'imageinfo',
    iiprop: 'url|size', iiurlwidth: String(MAX_WIDTH), format: 'json',
  });
  const res = await get(api);
  if (!res.ok) throw new Error(`${title}: API ${res.status}`);
  const page = Object.values((await res.json()).query.pages)[0];
  const info = page.imageinfo?.[0];
  if (!info) throw new Error(`${title}: not found`);
  return info.width > MAX_WIDTH ? info.thumburl : info.url;
}

for (const [slug, files] of Object.entries(galleries)) {
  const dir = path.join(root, slug);
  await mkdir(dir, { recursive: true });
  for (const [name, title] of Object.entries(files)) {
    const dest = path.join(dir, name);
    if (await exists(dest)) continue;
    const url = await imageUrl(title);
    const res = await get(url);
    if (!res.ok) throw new Error(`${title}: download ${res.status}`);
    await writeFile(dest, Buffer.from(await res.arrayBuffer()));
    console.log(`${slug}/${name}`);
    await sleep(1000);
  }
}
