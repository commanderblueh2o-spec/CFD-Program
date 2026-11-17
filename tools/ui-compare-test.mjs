// A/B comparison smoke test: run a preset, pin it as reference A, change the coating viscosity,
// run again and check the comparison table, settings diff, difference map and persistence.
// Usage: node tools/ui-compare-test.mjs [presetId] [outDir]
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
const require = createRequire(import.meta.url);
let pw; try { pw = require('playwright'); } catch { pw = require('/opt/node22/lib/node_modules/playwright'); }
const preset = process.argv[2] || 'saiccs_ha_heated';
const out = process.argv[3] || '/tmp/shots';
fs.mkdirSync(out, { recursive: true });
const browser = await pw.chromium.launch({ args: ['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto('file://' + path.resolve('dist/coatsim.html'));
await page.evaluate(() => localStorage.removeItem('coatsim.ref'));
await page.selectOption('#preset', preset);
const runAndWait = async () => {
  await page.click('#run');
  await page.waitForFunction(() => document.querySelector('#run').disabled === false && document.querySelector('.metric'), null, { timeout: 600000 });
  await page.waitForTimeout(300);
};
const fails = [];
const check = (ok, msg) => { console.log(`${ok ? 'OK  ' : 'FAIL'} ${msg}`); if (!ok) fails.push(msg); };

await runAndWait();
check(await page.locator('.refbar [data-cmp=pin]').count() === 1, 'pin button shown before a reference exists');
check(!(await page.$$eval('#field option', (o) => o.map((x) => x.value))).includes('diff'), 'no difference field without a reference');
await page.click('.refbar [data-cmp=pin]');
check((await page.textContent('.refbar')).includes('This run is reference A'), 'run marked as reference A');

// change the viscosity (first coating slider) and run again
await page.$eval('#matForm .srow input[type=range]', (el) => { el.value = Number(el.value) * 0.8; el.dispatchEvent(new Event('input')); el.dispatchEvent(new Event('change')); });
await runAndWait();
const cmp = await page.textContent('.cmp');
check(cmp.includes('Compared with reference A') && cmp.includes('Dry film, µm'), 'comparison table shown');
check(/Coating — Viscosity/.test(cmp), 'settings diff names the viscosity change');
const deltaText = (await page.locator('.cmp-t tr').nth(1).locator('td').nth(3).textContent()).trim();
check(/^−0\.\d+.*%$/.test(deltaText), `thinner film from lower viscosity shown as a negative delta (${deltaText})`);
console.log('difference summary:', (await page.locator('.cmp > .hint').nth(2).textContent()).trim());
await page.screenshot({ path: `${out}/cmp-1-results.png` });

await page.click('[data-cmp=map]');
await page.waitForTimeout(400);
check(await page.$eval('#field', (s) => s.value) === 'diff', 'difference map selected');
const box = await page.locator('#mapInner canvas').first().boundingBox();
await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
await page.waitForTimeout(150);
const tip = (await page.locator('#mapInner .chart-tip').textContent()).trim();
check(/vs A/.test(tip), `difference map hover: ${tip}`);
await page.screenshot({ path: `${out}/cmp-2-diffmap.png` });
await page.click('#tabs button[data-tab=v3d]'); await page.waitForTimeout(400);
await page.screenshot({ path: `${out}/cmp-3-diff3d.png` });
await page.selectOption('#field', 'dry');
await page.evaluate(() => { const f = document.querySelector('#frame'); f.value = f.max; f.dispatchEvent(new Event('input')); });
await page.click('#tabs button[data-tab=charts]'); await page.waitForTimeout(400);
check((await page.textContent('#chAxial .chart-legend')).includes('Reference A'), 'axial chart overlays reference A');
await page.screenshot({ path: `${out}/cmp-4-charts.png` });

// the reference survives a reload; clearing it removes the difference field
await page.reload();
await page.waitForTimeout(500);
check((await page.$$eval('#field option', (o) => o.map((x) => x.value))).includes('diff'), 'reference persists across reload');
await runAndWait();
check(await page.locator('.cmp').count() === 1, 'comparison after reload');
await page.click('[data-cmp=clear]');
check(!(await page.$$eval('#field option', (o) => o.map((x) => x.value))).includes('diff') && await page.locator('.refbar [data-cmp=pin]').count() === 1, 'clear removes the reference');

console.log('errors:', errors.length ? errors : 'none');
await browser.close();
if (fails.length || errors.length) process.exit(1);
