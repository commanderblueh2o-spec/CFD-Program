// Headless check of the parameter-sweep tool.
import { createRequire } from 'node:module';
import path from 'node:path';
const require = createRequire(import.meta.url);
let pw; try { pw = require('playwright'); } catch { pw = require('/opt/node22/lib/node_modules/playwright'); }
const out = process.argv[2] || '/tmp/shots';
const browser = await pw.chromium.launch({ args: ['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e))); page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto('file://' + path.resolve('dist/coatsim.html'));
await page.selectOption('#preset', 'catheter_dip_hydrophilic');
await page.click('#tabs button[data-tab=sweep]');
await page.waitForTimeout(300);
const sel = page.locator('#sweepForm select');
await sel.selectOption('stage:0:speed');
const inputs = page.locator('#sweepForm input[type=number]');
await inputs.nth(0).fill('0.5'); await inputs.nth(1).fill('8'); await inputs.nth(2).fill('5');
await page.locator('#sweepForm input[type=checkbox]').check();
await page.click('#sweepForm button.btn.primary');
await page.waitForFunction(() => !document.querySelector('#run').disabled && document.querySelectorAll('#sweepTable tr').length >= 6, null, { timeout: 300000 });
await page.waitForTimeout(500);
await page.screenshot({ path: `${out}/sweep.png` });
console.log(await page.locator('#sweepTable').innerText());
console.log('errors:', errors.length ? errors : 'none');
await browser.close();
