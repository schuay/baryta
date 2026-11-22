// Browser checks against a built site (npm run build first). Steps through every
// image of every gallery at a range of viewports and checks the layout rules:
// image and caption fully visible, no horizontal overflow, no upscaling.
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

test('sequence layout at every viewport', { skip }, async () => {
  const page0 = await browser.newPage();
  const paths = await galleries(page0);
  await page0.close();
  assert.ok(paths.length > 0);

  for (const [width, height, touch] of VIEWPORTS) {
    const ctx = await browser.newContext({ viewport: { width, height }, hasTouch: touch, isMobile: touch });
    const page = await ctx.newPage();
    for (const p of paths) {
      await page.goto(`${base}${p}#1`, { waitUntil: 'networkidle' });
      const count = await page.$$eval('.frame[data-number]', (fs) => fs.length);
      if (count === 0) continue; // grid-first gallery
      for (let n = 1; n <= count; n++) {
        const where = `${p}#${n} at ${width}x${height}`;
        await page.waitForFunction((n) => location.hash === `#${n}`, n);
        const m = await page.evaluate(() => {
          const frame = [...document.querySelectorAll('.frame')].find((f) => !f.inert);
          const img = frame.querySelector('img');
          const r = img.getBoundingClientRect();
          const c = frame.querySelector('figcaption').getBoundingClientRect();
          const natural = Number(getComputedStyle(frame.querySelector('.plate')).getPropertyValue('--natural').replace('px', ''));
          return {
            img: { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width },
            caption: { bottom: c.bottom, right: c.right },
            vw: innerWidth, vh: innerHeight, natural,
            overflow: document.documentElement.scrollWidth > innerWidth,
          };
        });
        const eps = 1;
        assert.ok(!m.overflow, `horizontal overflow: ${where}`);
        assert.ok(m.img.left >= -eps && m.img.right <= m.vw + eps, `image outside viewport horizontally: ${where}`);
        assert.ok(m.img.top >= -eps && m.img.bottom <= m.vh + eps, `image outside viewport vertically: ${where}`);
        assert.ok(m.caption.bottom <= m.vh + eps, `caption cut off: ${where}`);
        assert.ok(m.img.width <= m.natural + eps, `image upscaled: ${where}`);
        assert.ok(m.img.width >= Math.min(200, m.vw / 3), `image implausibly small (${m.img.width}px): ${where}`);
        if (n < count) await page.keyboard.press('ArrowRight');
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
  const label = await page.evaluate(() => [...document.querySelectorAll('.frame')].find((f) => !f.inert).getAttribute('aria-label'));
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
