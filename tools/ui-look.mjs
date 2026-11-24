// Graphics look check: runs a preset and captures the 3D view only (no panels) at a few moments
// from an oblique angle and side-on at the tip, plus the time a render takes (animation smoothness).
// Usage: node tools/ui-look.mjs [presetId] [outDir]   → look-*.png
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
await page.goto('file://' + path.resolve(process.env.COATSIM_HTML || 'dist/coatsim.html'));
await page.waitForTimeout(800);
await page.selectOption('#preset', preset);
await page.waitForTimeout(400);
await page.click('#run');
await page.waitForFunction(() => document.querySelector('#run').disabled === false && document.querySelector('.metric'), null, { timeout: 600000 });
await page.evaluate(() => { const b = document.querySelector('#play'); if (b && /❚❚|pause/i.test(b.textContent)) b.click(); });
// moments: mid-fill, a plug leaving the tip, the largest tip pool, the end
const moments = await page.evaluate(() => {
  const fr = window.coatsimState.result.frames, n = fr.length - 1;
  let plug = null, pool = 0, pv = -1;
  for (let i = 0; i <= n; i++) {
    const a = fr[i].aux || {};
    if (a.held && a.held.kind === 'plug') plug = i;
    const p = a.pool ? a.pool[1] : 0; if (p > pv) { pv = p; pool = i; }
  }
  const fill = fr.findIndex((f) => f.aux && f.aux.held && f.aux.held.kind === 'fill');
  return { n, at: { fill: fill >= 0 ? fill : Math.round(0.3 * n), plug, pool: pv > 0 ? pool : null, end: n } };
});
const view = await page.$('#v3d');
let k = 0;
// hide the help card and toasts so the shots show only the part
await page.addStyleTag({ content: '#navhelp, #toast { display: none !important; }' });
for (const [name, i] of Object.entries(moments.at)) {
  if (i == null) continue;
  // oblique / tip: cut open at the tip; closed: the uncut part seen through its wall (whole part
  // and the tip), as with "Cut open" switched off
  for (const mode of ['oblique', 'tip', 'closed', 'closedtip']) {
    await page.evaluate(([v, mode]) => {
      const el = document.querySelector('#frame'); el.value = Math.round((v / (window.coatsimState.result.frames.length - 1)) * el.max); el.dispatchEvent(new Event('input'));
      const V = window.coatsimView, closed = mode.startsWith('closed');
      V.cutaway = !closed;
      if (mode === 'closed') V.resetView(); else V.tipView();
      if (mode === 'oblique' || mode === 'closedtip') { V.yaw -= 0.6; V.pitch = 0.35; }
      V.render();
    }, [i, mode]);
    await page.waitForTimeout(250);
    await view.screenshot({ path: `${out}/look-${k++}-${name}-${mode}.png` });
  }
}
await page.evaluate(() => { const c = document.querySelector('#cutaway'); window.coatsimView.cutaway = c ? c.checked : true; });
const ms = await page.evaluate(() => { const V = window.coatsimView, t0 = performance.now(); const px = new Uint8Array(4); for (let i = 0; i < 20; i++) { V.render(); V.gl.readPixels(0, 0, 1, 1, V.gl.RGBA, V.gl.UNSIGNED_BYTE, px); } return (performance.now() - t0) / 20; });
console.log('moments', JSON.stringify(moments), `render ${ms.toFixed(1)} ms/frame (software GL)`);
console.log('errors:', errors.length ? errors.join('\n') : 'none');
await browser.close();
process.exit(errors.length ? 1 : 0);
