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
  if (tab === 'map') {
    // hover the middle of the map: the tooltip should describe the coating state there
    const box = await page.locator('#mapInner canvas').first().boundingBox();
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
    await page.waitForTimeout(150);
    console.log('map hover:', (await page.locator('#mapInner .chart-tip').textContent()).trim());
  }
}
await page.click('#tabs button[data-tab=v3d]');
await page.click('.stage-head');
await page.waitForTimeout(300);
await page.screenshot({ path: `${out}/5-stage-open.png` });

// Tip pool: the drawn meniscus body must hold the solver's pool (plus the film it covers)
const poolCheck = await page.evaluate(() => {
  const st = window.coatsimState, fr = st.result.frames, el = document.querySelector('#frame');
  let best = -1, bv = 0;
  fr.forEach((f, q) => { const v = f.aux && f.aux.pool ? f.aux.pool[1] : 0; if (v > bv) { bv = v; best = q; } });
  if (best < 0) return null;
  el.value = Math.round((best / (fr.length - 1)) * el.max); el.dispatchEvent(new Event('input'));
  const info = window.coatsimView.poolInfo;
  return info && { frame: best, pool: bv, ...info };
});
if (poolCheck) {
  const err = Math.abs(poolCheck.V - poolCheck.Vpool - poolCheck.Vfilm) / poolCheck.V;
  console.log(`tip pool: solver ${(poolCheck.pool * 1e9).toFixed(3)} µL, drawn body ${(poolCheck.V * 1e9).toFixed(3)} µL (pool ${(poolCheck.Vpool * 1e9).toFixed(3)} + covered film ${(poolCheck.Vfilm * 1e9).toFixed(3)}), ${(poolCheck.height * 1e3).toFixed(2)} mm tall, err ${(err * 100).toFixed(2)}%`);
  if (Math.abs(poolCheck.Vpool - poolCheck.pool) > 1e-6 * poolCheck.pool || err > 0.01) errors.push('drawn tip pool volume does not match the solver');
  await page.waitForTimeout(300);
  await page.evaluate(() => window.coatsimView.tipView()); await page.waitForTimeout(300);
  await page.screenshot({ path: `${out}/6-tip-pool.png` });
} else console.log('tip pool: none held during this run');
// Whole coating: at every slider position the liquid drawn at true scale (film layer, tip pool,
// bore-filling liquid with its menisci) must hold the solver's liquid volume
const volCheck = await page.evaluate(() => {
  const el = document.querySelector('#frame'), out = { n: 0, worst: 0, at: null, heldAt: null };
  const step = Math.max(1, Math.round(Number(el.max) / 300));
  for (let v = 0; v <= Number(el.max); v += step) {
    el.value = v; el.dispatchEvent(new Event('input'));
    const c = window.coatsimView.liquidCheck; if (!c || !(c.expected > 1e-11)) continue;
    out.n++;
    const e = (c.drawn - c.expected) / c.expected;
    if (Math.abs(e) > Math.abs(out.worst)) { out.worst = e; out.at = { v, ...c }; }
    if (c.heldKind === 'plug' && c.held > 0.05 * c.expected) out.heldAt = v; // last frame with a sizeable plug
  }
  return out;
});
console.log(`drawn volume: ${volCheck.n} frames, worst ${(volCheck.worst * 100).toFixed(2)}%` + (volCheck.at ? ` (solver ${(volCheck.at.expected * 1e9).toFixed(3)} µL, drawn ${(volCheck.at.drawn * 1e9).toFixed(3)} µL${volCheck.at.heldKind ? ', ' + volCheck.at.heldKind : ''})` : ''));
if (Math.abs(volCheck.worst) > 0.015) errors.push('drawn coating volume differs from the solver by more than 1.5%');
if (volCheck.heldAt !== null) {
  // a plug draining out of the tip: its upper meniscus is drawn curved
  await page.evaluate((v) => { const el = document.querySelector('#frame'); el.value = v; el.dispatchEvent(new Event('input')); window.coatsimView.tipView(); }, volCheck.heldAt);
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${out}/7-plug-meniscus.png` });
}
console.log('errors:', errors.length ? errors : 'none');
await browser.close();
