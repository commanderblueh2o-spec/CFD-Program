// Checks that sliders write to the intended parameters (stage + coating).
import { createRequire } from 'node:module';
import path from 'node:path';
const require = createRequire(import.meta.url);
let pw; try { pw = require('playwright'); } catch { pw = require('/opt/node22/lib/node_modules/playwright'); }
const b = await pw.chromium.launch(); const p = await b.newPage();
const errors = []; p.on('pageerror', (e) => errors.push(e.message));
await p.goto('file://' + path.resolve('dist/coatsim.html'));
await p.selectOption('#preset', 'catheter_dip_hydrophilic');
await p.click('.stage-head');
const setSlider = async (sel, v) => p.$eval(sel, (el, val) => { el.value = val; el.dispatchEvent(new Event('input')); el.dispatchEvent(new Event('change')); }, v);
await setSlider('.stage-body .srow input[type=range]', 900);
await setSlider('#matForm .srow input[type=range]', 100);
const spec = await p.evaluate(() => JSON.parse(localStorage.getItem('coatsim.spec')));
const ok1 = spec.stages[0].speed > 10 && !('true' in spec.stages[0]);
const ok2 = spec.coatingOverrides && spec.coatingOverrides.mu0 < 0.01;
console.log(`stage speed -> ${spec.stages[0].speed} mm/s ${ok1 ? 'OK' : 'FAIL'}; coating viscosity -> ${spec.coatingOverrides?.mu0} Pa·s ${ok2 ? 'OK' : 'FAIL'}`);
console.log('errors:', errors.length ? errors : 'none');
await b.close();
if (!ok1 || !ok2 || errors.length) process.exit(1);
