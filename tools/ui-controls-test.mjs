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
// Bore profile CSV import on a SAICCS cartridge: switches to a custom profile, keeps bevel + evaluation zone
await p.selectOption('#preset', 'saiccs_ha_heated');
await p.locator('.profio input[type=file]').setInputFiles({ name: 'bore.csv', mimeType: 'text/csv', buffer: Buffer.from('# descending positions, inches\nz (in),ID (in)\n1.4,0.06\n1.0,0.08\n0.5,0.2\n0,0.22\n') });
await p.waitForTimeout(300);
const g = await p.evaluate(() => JSON.parse(localStorage.getItem('coatsim.spec')));
const pts = g.geometry.points || [];
const ok3 = g.geometry.type === 'custom' && pts.length === 4 && Math.abs(pts[0][1] - 2.794) < 1e-6 && Math.abs(pts[3][0] - 35.56) < 1e-6
  && g.geometry.tipBevelDeg === 45 && g.metrics.zone && g.metrics.zone[1] <= 35.56;
console.log(`profile import -> ${g.geometry.type}, ${pts.length} pts, r0 ${pts[0]?.[1]} mm, L ${pts[pts.length - 1]?.[0]} mm, zone ${g.metrics.zone} ${ok3 ? 'OK' : 'FAIL'}`);
// Bad file: rejected with an error toast, geometry unchanged
await p.locator('.profio input[type=file]').setInputFiles({ name: 'bad.csv', mimeType: 'text/csv', buffer: Buffer.from('s,d\n0,1\n') });
await p.waitForTimeout(300);
const ok4 = (await p.textContent('#toast')).includes('Could not import') && (await p.evaluate(() => JSON.parse(localStorage.getItem('coatsim.spec')).geometry.points.length)) === 4;
console.log(`bad profile rejected ${ok4 ? 'OK' : 'FAIL'}`);
console.log('errors:', errors.length ? errors : 'none');
await b.close();
if (!ok1 || !ok2 || !ok3 || !ok4 || errors.length) process.exit(1);
