// Browser checks against a built site (npm run build first). Steps through every
// image of every gallery at a range of viewports and checks the layout rules:
// image and caption fully visible, sequence bar visible below them, no
// horizontal overflow, no upscaling.
//
// Set CHROMIUM to a browser binary to use instead of Playwright's own.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright';
import { serve } from './serve.mjs';

const DIST = new URL('../dist/', import.meta.url).pathname;
const VIEWPORTS = [
  [375, 667, true], [390, 844, true], [844, 390, true], [768, 1024, true],
  [1366, 768, false], [1440, 900, false], [1920, 1080, false], [2560, 1440, false], [3440, 1440, false],
];

const skip = !existsSync(`${DIST}index.html`) && 'dist/ not built';
let server, base, browser;

before(async () => {
  if (skip) return;
  server = await serve(DIST);
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
});

after(async () => {
  await browser?.close();
  server?.close();
});

async function galleries(page) {
  await page.goto(`${base}/`);
  return page.$$eval('.contents a', (as) => as.map((a) => new URL(a.href).pathname));
}

/** Step count and the index of the current step, as the sequence script sees them. */
function stepState() {
  const isStep = (el) => {
    const cs = getComputedStyle(el);
    return cs.display !== 'contents' && cs.display !== 'none' && cs.scrollSnapAlign !== 'none';
  };
  const steps = [...document.querySelectorAll('.track .frame, .track .column')].filter(isStep);
  return { count: steps.length, index: steps.findIndex((s) => s.hasAttribute('data-current')) };
}

/** Geometry of the current step: images, visible captions and page numbers, and its boxes. */
function measure() {
  const step = document.querySelector('.track [data-current]');
  const shown = (el) => getComputedStyle(el).display !== 'none' && el.getClientRects().length > 0;
  const rect = (el) => {
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
  };
  const boxes = [...step.querySelectorAll('.box')].filter(shown).map(rect);
  return {
    label: step.getAttribute('aria-label') ?? `column of ${step.dataset.number}`,
    images: [...step.querySelectorAll('img')].map((img) => ({
      ...rect(img),
      cover: img.classList.contains('cover'),
      source: Number(img.dataset.sourceWidth),
    })),
    text: [...step.querySelectorAll('.cap, .folio')].filter(shown).map(rect),
    bar: rect(document.querySelector('.sequence-bar')),
    box: boxes.length && {
      width: Math.max(...boxes.map((b) => b.right)) - Math.min(...boxes.map((b) => b.left)),
      height: Math.max(...boxes.map((b) => b.bottom)) - Math.min(...boxes.map((b) => b.top)),
    },
    vw: innerWidth,
    vh: innerHeight,
    overflow: document.documentElement.scrollWidth > innerWidth,
  };
}

test('sequence layout at every viewport', { skip }, async () => {
  const page0 = await browser.newPage();
  const paths = await galleries(page0);
  await page0.close();
  assert.ok(paths.length > 0);

  for (const [width, height, touch] of VIEWPORTS) {
    const ctx = await browser.newContext({ viewport: { width, height }, hasTouch: touch, isMobile: touch });
    const page = await ctx.newPage();
    for (const p of paths) {
      await page.goto(`${base}${p}`, { waitUntil: 'networkidle' });
      if (!(await page.$('.sequence'))) continue; // grid-first gallery
      const { count } = await page.evaluate(stepState);
      for (let i = 0; i < count; i++) {
        await page.waitForFunction(() => document.querySelectorAll('.track [data-current]').length === 1);
        const state = await page.evaluate(stepState);
        assert.equal(state.index, i, `${p} at ${width}x${height}: expected step ${i}, at ${state.index}`);
        const m = await page.evaluate(measure);
        const where = `${p} step ${i} (${m.label}) at ${width}x${height}`;
        const eps = 1;
        const inside = (r) => r.left >= -eps && r.top >= -eps && r.right <= m.vw + eps && r.bottom <= m.vh + eps;
        assert.ok(!m.overflow, `horizontal overflow: ${where}`);
        for (const img of m.images) {
          assert.ok(inside(img), `image outside the viewport: ${where}`);
          if (!img.cover) assert.ok(img.width <= img.source + eps, `image upscaled: ${where}`);
        }
        for (const t of m.text) assert.ok(inside(t), `caption or page number cut off: ${where}`);
        assert.ok(inside(m.bar), `sequence bar cut off: ${where}`);
        for (const r of [...m.images, ...m.text]) {
          assert.ok(r.bottom <= m.bar.top + eps, `image or caption overlaps the sequence bar: ${where}`);
        }
        if (m.box) {
          const usesSpace = m.box.width >= 0.45 * m.vw || m.box.height >= 0.45 * m.vh;
          assert.ok(usesSpace, `frame implausibly small (${Math.round(m.box.width)}x${Math.round(m.box.height)}): ${where}`);
        }
        if (i < count - 1) {
          await page.keyboard.press('ArrowRight');
          await page.waitForFunction((i) => {
            const isStep = (el) => {
              const cs = getComputedStyle(el);
              return cs.display !== 'contents' && cs.display !== 'none' && cs.scrollSnapAlign !== 'none';
            };
            const steps = [...document.querySelectorAll('.track .frame, .track .column')].filter(isStep);
            return steps.findIndex((s) => s.hasAttribute('data-current')) === i + 1;
          }, i);
        }
      }
    }
    await ctx.close();
  }
});

test('grid and start page have no horizontal overflow', { skip }, async () => {
  for (const [width, height] of VIEWPORTS) {
    const page = await browser.newPage({ viewport: { width, height } });
    await page.goto(`${base}/`);
    const paths = ['/', ...(await galleries(page)).map((p) => `${p}grid/`)];
    for (const p of paths) {
      await page.goto(`${base}${p}`);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
      assert.ok(!overflow, `horizontal overflow: ${p} at ${width}x${height}`);
    }
    await page.close();
  }
});

test('grid links open the sequence at the clicked image', { skip }, async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const [p] = await galleries(page);
  await page.goto(`${base}${p}grid/`);
  await page.locator('.grid a').nth(2).click();
  await page.waitForFunction(() => location.hash === '#3');
  const label = await page.evaluate(() => document.querySelector('.track [data-current]').getAttribute('aria-label'));
  assert.match(label, /^3 of /);
  await page.keyboard.press('ArrowLeft');
  await page.waitForFunction(() => location.hash === '#2');
  await page.close();
});

test('unknown paths get the 404 page', { skip }, async () => {
  const res = await fetch(`${base}/does-not-exist/`);
  assert.equal(res.status, 404);
  assert.match(await res.text(), /Not found/);
});
