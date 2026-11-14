// Headless browser smoke test: loads the built app, runs a preset, captures screenshots.
// Usage: node tools/ui-test.mjs [presetId] [outDir]
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
const require = createRequire(import.meta.url);
let pw;
try { pw = require('playwright'); } catch { pw = require('/opt/node22/lib/node_modules/playwright'); }
const preset = process.argv[2] || 'saiccs_ha_heated';
const out = process.argv[3] || '/tmp/shots';
fs.mkdirSync(out, { recursive: true });
const browser = await pw.chromium.launch({ args: ['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto('file://' + path.resolve('dist/coatsim.html'));
await page.waitForTimeout(800);
await page.selectOption('#preset', preset);
await page.waitForTimeout(500);
await page.screenshot({ path: `${out}/0-setup.png` });
const t0 = Date.now();
await page.click('#run');
await page.waitForFunction(() => document.querySelector('#run').disabled === false && document.querySelector('.metric'), null, { timeout: 600000 });
console.log('run finished in', ((Date.now() - t0) / 1000).toFixed(1), 's');
// let the animation play a moment, then capture three moments of the process
await page.waitForTimeout(1500);
for (const [n, frac] of [[1, 0.22], [2, 0.3], [3, 0.6], [4, 1]]) {
  await page.evaluate((f) => { const el = document.querySelector('#frame'); el.value = Math.round(el.max * f); el.dispatchEvent(new Event('input')); }, frac);
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${out}/1-anim-${n}.png` });
}
for (const [i, tab] of ['map', 'charts'].entries()) {
  await page.click(`#tabs button[data-tab=${tab}]`); await page.waitForTimeout(500);
  await page.screenshot({ path: `${out}/${i + 2}-${tab}.png` });
}
await page.click('#tabs button[data-tab=v3d]');
await page.click('.stage-head');
await page.waitForTimeout(300);
await page.screenshot({ path: `${out}/5-stage-open.png` });
console.log('errors:', errors.length ? errors : 'none');
await browser.close();
