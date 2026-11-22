// Downloads the public-domain sample photos used by example/ from Wikimedia
// Commons. Photos are not checked in; the gallery.yaml files are.
//
// Some files get an XMP title and description written into them, the way a
// photo manager would, to show captions read from the image files.
import { copyFile, link, mkdir, readFile, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'example', 'galleries');
const UA = 'baryta-example-fetch/0.1';
const MAX_WIDTH = 3000;

// Gallery -> local file name -> Commons file title, or { title, xmp }.
const galleries = {
  worthington: {
    '01-stoop.jpg': {
      title: 'Street scene, Worthington, Ohio, August 1938 - Stoop Sitters crop.jpg',
      xmp: { title: 'Street scene, Worthington, Ohio', description: 'Ben Shahn, August 1938' },
    },
    '02-crank.jpg': {
      title: 'Automobile with crank used to get the motor started, Worthington, Ohio August 1938 crop.jpg',
      xmp: { title: 'Automobile with crank used to get the motor started', description: 'Ben Shahn, August 1938' },
    },
    '03-cranking.jpg': {
      title: 'Cranking car to get it started, the old way, Worthington, Ohio August 1938 crop.jpg',
      xmp: { title: 'Cranking car to get it started, the old way', description: 'Ben Shahn, August 1938' },
    },
    '04-model-t.jpg': {
      title: 'Cranking Model "T" Ford from before the days of the self-starter, Worthington, Ohio 1938 crop.jpg',
      xmp: { title: 'Cranking Model "T" Ford from before the days of the self-starter', description: 'Ben Shahn, 1938' },
    },
    '05-getting-crank.jpg': {
      title: 'Getting crank out of car to get the motor started, Worthington, Ohio, 1938 crop.jpg',
      xmp: { title: 'Getting crank out of car to get the motor started', description: 'Ben Shahn, 1938' },
    },
  },
  'china-1946': {
    'junk.jpg': 'Arthur Rothstein - Chinese junk on river ppmsca.07797.jpg',
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
    'edwards.jpg': 'Edwards, Mississippi - 1936.jpg',
    'havana.jpg': 'Plaza del Vapor Havana, Cuba Walker Evans.jpg',
    'times-square.jpg': 'Times Square on a Rainy Day 1943 John Vachon.jpg',
    'bootleggers.jpg': "Jack Delano, The day's output & Bootleggers, Schuylkill County, Pennsylvania, ca. 1938.jpg",
    'cemetery.jpg': 'Cemetery at Pointe a la Hache, Louisiana, October 1935, by Ben Shahn - crop.jpg',
  },
  'plant-forms': {
    'blumenbachia.jpg': 'Blumenbachia hieronymi MET DP153196.jpg',
    'acanthus.jpg': 'Karl Blossfeldt. Acanthus mollis, 1928.jpg',
    'cucurbita.jpg': 'Karl Blossfeldt. Cucurbita, 1928.jpg',
    'papaver.jpg': 'Karl Blossfeldt. Papaver orientalis, 1928 - 1932.jpg',
    'nigella.jpg': 'Nigella Damascena Spinnenkopf MET DP324361 (cropped).jpg',
  },
  // Galleries reusing photos from the ones above; files are linked, not downloaded again.
  'main-street': [
    'worthington/01-stoop.jpg', 'worthington/02-crank.jpg', 'worthington/03-cranking.jpg', 'worthington/04-model-t.jpg',
    'american-photographs/bootleggers.jpg', 'american-photographs/shack-town.jpg', 'american-photographs/broke.jpg',
    'american-photographs/boardwalk.jpg', 'american-photographs/cotton-hoers.jpg', 'american-photographs/edwards.jpg',
    'american-photographs/cemetery.jpg', 'american-photographs/times-square.jpg',
    'china-1946/junk.jpg', 'china-1946/troops.jpg', 'china-1946/mother.jpg', 'china-1946/rice.jpg',
    'plant-forms/acanthus.jpg', 'plant-forms/papaver.jpg',
  ],
  pairs: [
    'worthington/02-crank.jpg', 'worthington/03-cranking.jpg', 'worthington/05-getting-crank.jpg',
    'american-photographs/havana.jpg', 'american-photographs/shack-town.jpg', 'american-photographs/weedpatch.jpg',
    'plant-forms/acanthus.jpg', 'plant-forms/papaver.jpg', 'china-1946/mother.jpg', 'china-1946/rice.jpg',
  ],
  'work-in-progress': ['plant-forms/blumenbachia.jpg', 'plant-forms/cucurbita.jpg', 'plant-forms/nigella.jpg'],
  // Not listed in site.yaml: visible in the dev server only.
  'colour-slides': {
    'coal.jpg': 'Loading coal into a lake freighter at the Pennsylvania Railroad docks, Sandusky, Ohio LCCN2017878195.jpg',
    'headlines.jpg': 'Men and a woman reading headlines posted in street-corner window of Brockton Enterprise newspaper office on Christmas Eve, Brockton, Mass. LCCN2017877372.jpg',
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

const XMP_NS = Buffer.from('http://ns.adobe.com/xap/1.0/\0', 'latin1');

function escapeXml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function xmpPacket({ title, description }) {
  const alt = (v) => `<rdf:Alt><rdf:li xml:lang="x-default">${escapeXml(v)}</rdf:li></rdf:Alt>`;
  return (
    '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">' +
    '<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/">' +
    `<dc:title>${alt(title)}</dc:title><dc:description>${alt(description)}</dc:description>` +
    '</rdf:Description></rdf:RDF></x:xmpmeta>'
  );
}

/**
 * Inserts an XMP APP1 segment after the leading APP0/APP1 segments, without
 * re-encoding the image. Returns undefined if the file already has XMP.
 */
function withXmp(jpeg, meta) {
  if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) throw new Error('not a JPEG');
  let at = 2;
  while (jpeg[at] === 0xff && (jpeg[at + 1] === 0xe0 || jpeg[at + 1] === 0xe1)) {
    const len = jpeg.readUInt16BE(at + 2);
    if (jpeg.subarray(at + 4, at + 4 + XMP_NS.length).equals(XMP_NS)) return undefined;
    at += 2 + len;
  }
  const payload = Buffer.concat([XMP_NS, Buffer.from(xmpPacket(meta), 'utf8')]);
  const header = Buffer.from([0xff, 0xe1, 0, 0]);
  header.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([jpeg.subarray(0, at), header, payload, jpeg.subarray(at)]);
}

for (const [slug, files] of Object.entries(galleries)) {
  const dir = path.join(root, slug);
  await mkdir(dir, { recursive: true });
  if (Array.isArray(files)) {
    for (const src of files) {
      const dest = path.join(dir, path.basename(src));
      if (await exists(dest)) continue;
      await link(path.join(root, src), dest).catch(() => copyFile(path.join(root, src), dest));
      console.log(`${slug}/${path.basename(src)}`);
    }
    continue;
  }
  for (const [name, spec] of Object.entries(files)) {
    const { title, xmp } = typeof spec === 'string' ? { title: spec } : spec;
    const dest = path.join(dir, name);
    if (!(await exists(dest))) {
      const url = await imageUrl(title);
      const res = await get(url);
      if (!res.ok) throw new Error(`${title}: download ${res.status}`);
      await writeFile(dest, Buffer.from(await res.arrayBuffer()));
      console.log(`${slug}/${name}`);
      await sleep(1000);
    }
    if (xmp) {
      const tagged = withXmp(await readFile(dest), xmp);
      if (tagged) {
        await writeFile(dest, tagged);
        console.log(`${slug}/${name}: wrote XMP caption`);
      }
    }
  }
}
