// CoatSim application controller.
import { PRESETS, getPreset } from '../core/presets.js';
import { SUBSTRATES, COATINGS, contactAngleOWRK, wenzel, resolveCoating, resolveSubstrate } from '../core/materials.js';
import { buildGeometry } from '../core/geometry.js';
import { capillaryLength } from '../core/physics.js';
import { GEOMETRY_SCHEMAS, STAGE_SCHEMAS, COATING_OVERRIDES, SUBSTRATE_OVERRIDES, FIELDS } from './schema.js';
import { STAGE_DEFAULTS } from '../core/processes.js';
import { SERIES, COLORMAPS, gradientCSS, fmt, niceRange } from './colormap.js';
import { LineChart } from './charts.js';
import { Heatmap } from './heatmap.js';
import { View3D } from './view3d.js';

const VERSION = '1.0.0';
const $ = (s) => document.querySelector(s);
const el = (tag, attrs = {}, html = '') => { const e = document.createElement(tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); if (html) e.innerHTML = html; return e; };
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const state = {
  spec: null, result: null, frame: 0, field: 'dry', cmap: 'blue', tab: 'v3d', playing: false,
  openStage: 0, running: false, sweep: null,
};

// ---------------------------------------------------------------- persistence
function saveLocal() { try { localStorage.setItem('coatsim.spec', JSON.stringify(state.spec)); } catch { /* storage unavailable */ } }
function loadLocal() { try { const s = localStorage.getItem('coatsim.spec'); return s ? JSON.parse(s) : null; } catch { return null; } }
function toast(msg, err) { const t = $('#toast'); t.textContent = msg; t.className = 'toast' + (err ? ' err' : ''); t.hidden = false; clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), err ? 6000 : 2600); }

function specFromHash() {
  if (!location.hash.startsWith('#setup=')) return null;
  try { return JSON.parse(decodeURIComponent(escape(atob(location.hash.slice(7))))); } catch { return null; }
}

// ---------------------------------------------------------------- form helpers
function numberRow(def, value, onChange) {
  const row = el('div', { class: def.kind === 'select' ? 'row sel' : 'row' });
  const lab = el('label', { title: def.help || '' }, esc(def.label));
  const inp = el('div', { class: 'inp' });
  let input;
  if (def.kind === 'select') {
    input = el('select');
    for (const [v, t] of def.options) { const o = el('option', { value: v }, esc(t)); if (String(value) === String(v)) o.selected = true; input.append(o); }
    input.addEventListener('change', () => onChange(input.value));
  } else {
    input = el('input', { type: 'number', step: def.step ?? 'any' });
    if (def.min !== undefined) input.min = def.min;
    if (def.max !== undefined && def.max < 1e8) input.max = def.max;
    const big = value !== null && value !== undefined && value >= 1e8;
    input.value = value === null || value === undefined ? '' : big ? '' : value;
    if (big) input.placeholder = 'all';
    if (def.optional) input.placeholder = 'auto';
    input.addEventListener('change', () => {
      if (input.value === '') { onChange(def.optional ? null : (def.key === 'immersionMm' || def.key === 'fillLengthMm' || def.key === 'endMm') ? 1e9 : (def.min ?? 0)); return; }
      let v = Number(input.value);
      if (def.min !== undefined && v < def.min) v = def.min;
      if (def.max !== undefined && v > def.max) v = def.max;
      input.value = v; onChange(v);
    });
  }
  inp.append(input);
  if (def.unit) inp.append(el('span', { class: 'unit' }, esc(def.unit)));
  row.append(lab, inp);
  return row;
}

function segmented(options, value, onChange) {
  const s = el('div', { class: 'seg' });
  for (const [v, t] of options) {
    const b = el('button', { type: 'button' }, esc(t));
    if (v === value) b.classList.add('on');
    b.addEventListener('click', () => onChange(v));
    s.append(b);
  }
  return s;
}

function changed() { saveLocal(); renderMaterialInfo(); updateStageSummaries(); }

// ---------------------------------------------------------------- setup panels
function renderGeometry() {
  const box = $('#geoForm'); box.innerHTML = '';
  const g = state.spec.geometry;
  const typeSel = numberRow({ key: 'type', label: 'Geometry', kind: 'select', options: Object.entries(GEOMETRY_SCHEMAS).map(([k, v]) => [k, v.name]) }, g.type, (v) => {
    state.spec.geometry = { type: v, ...JSON.parse(JSON.stringify(GEOMETRY_SCHEMAS[v].defaults)) };
    if (v === 'coupon') state.spec.surface = 'outer';
    state.spec.metrics = { zone: null };
    renderGeometry(); changed(); previewGeometry();
  });
  box.append(typeSel);
  if (g.type !== 'coupon') {
    const r = el('div', { class: 'row' });
    r.append(el('label', {}, 'Coated surface'));
    r.append(segmented([['outer', 'Outer'], ['inner', 'Inner (lumen)']], state.spec.surface || 'outer', (v) => { state.spec.surface = v; renderGeometry(); changed(); previewGeometry(); }));
    box.append(r);
  }
  const sch = GEOMETRY_SCHEMAS[g.type];
  for (const d of sch.fields) box.append(numberRow(d, g[d.key] ?? sch.defaults[d.key], (v) => { g[d.key] = v; changed(); previewGeometry(); }));
  if (sch.hasPoints) {
    box.append(el('div', { class: 'hint' }, 'Inner profile points, one per line: <code>s, half-width a, half-height b</code> (mm).'));
    const ta = el('textarea', { class: 'pts', rows: 5 });
    ta.value = (g.points || []).map((p) => p.join(', ')).join('\n');
    ta.addEventListener('change', () => {
      const pts = ta.value.split('\n').map((l) => l.split(/[,\s]+/).filter(Boolean).map(Number)).filter((p) => p.length >= 3 && p.every(isFinite));
      if (pts.length >= 2) { g.points = pts; changed(); previewGeometry(); } else toast('Need at least two valid points', true);
    });
    box.append(ta);
  }
  const L = partLength();
  box.append(el('div', { class: 'hint' }, `Axial coordinate s runs 0 → ${fmt(L)} mm${g.type === 'iol_cartridge' ? ' (loading chamber → nozzle tip)' : g.type === 'catheter' && g.tipLength > 0 ? ' (tip at s = L)' : ''}.`));
}

function partLength() {
  try { return buildGeometry({ ...state.spec, grid: { ns: 4, nphi: 8 } }).L * 1e3; } catch { return 0; }
}

function renderMaterials() {
  const box = $('#matForm'); box.innerHTML = '';
  const sp = state.spec;
  box.append(numberRow({ key: 'substrate', label: 'Substrate', kind: 'select', options: Object.entries(SUBSTRATES).map(([k, v]) => [k, v.name]) }, sp.substrate, (v) => { sp.substrate = v; sp.substrateOverrides = {}; renderMaterials(); changed(); }));
  box.append(numberRow({ key: 'coating', label: 'Coating', kind: 'select', options: Object.entries(COATINGS).map(([k, v]) => [k, v.name]) }, sp.coating, (v) => { sp.coating = v; sp.coatingOverrides = {}; renderMaterials(); changed(); }));
  box.append(numberRow({ key: 'roughness', label: 'Roughness ratio r (Wenzel)', min: 1, max: 3, step: 0.01, help: 'True / projected area. Amplifies wetting or non-wetting.' }, sp.roughness || 1, (v) => { sp.roughness = v; changed(); }));
  box.append(el('div', { id: 'matInfo' }));
  const adv = el('details', { class: 'adv' }); adv.append(el('summary', {}, 'Edit coating properties'));
  const c = resolveCoating(sp);
  sp.coatingOverrides = sp.coatingOverrides || {};
  for (const d of COATING_OVERRIDES) adv.append(numberRow(d, sp.coatingOverrides[d.key] ?? c[d.key], (v) => { sp.coatingOverrides[d.key] = v; changed(); }));
  const cureSel = numberRow({ key: 'cure', label: 'Cure chemistry', kind: 'select', options: [['none', 'None (physical drying / oil)'], ['thermal', 'Thermal'], ['uv', 'UV']] }, c.cure.model, (v) => {
    const base = { none: { model: 'none' }, thermal: { model: 'thermal', A1: 4.7e5, Ea1: 60, A2: 0, Ea2: 60, m: 1, n: 1.5, alphaGel: 0.5 }, uv: { model: 'uv', kUV: 0.15, nUV: 1, alphaGel: 0.3 } }[v];
    sp.coatingOverrides.cure = c.cure.model === v ? c.cure : base; changed();
  });
  adv.append(cureSel);
  adv.append(el('button', { class: 'btn small', type: 'button' }, 'Reset to library values')); adv.lastChild.addEventListener('click', () => { sp.coatingOverrides = {}; renderMaterials(); changed(); });
  box.append(adv);
  const adv2 = el('details', { class: 'adv' }); adv2.append(el('summary', {}, 'Edit substrate surface energy'));
  const s = resolveSubstrate(sp);
  sp.substrateOverrides = sp.substrateOverrides || {};
  for (const d of SUBSTRATE_OVERRIDES) adv2.append(numberRow(d, sp.substrateOverrides[d.key] ?? s[d.key], (v) => { sp.substrateOverrides[d.key] = v; changed(); }));
  box.append(adv2);
  renderMaterialInfo();
}

function renderMaterialInfo() {
  const box = $('#matInfo'); if (!box) return;
  const c = resolveCoating(state.spec), s = resolveSubstrate(state.spec);
  const th = (wenzel(contactAngleOWRK(s, c), state.spec.roughness || 1) * 180) / Math.PI;
  const gam = c.d + c.p;
  const lc = capillaryLength(gam * 1e-3, c.rho) * 1e3;
  const note = th < 15 ? 'spreads readily' : th < 45 ? 'wets' : th < 90 ? 'partially wets – dewetting risk' : 'non-wetting – beads up';
  box.innerHTML = `
    <div class="info-line"><span>Equilibrium contact angle (untreated)</span><b>${th.toFixed(0)}° <span class="muted">· ${note}</span></b></div>
    <div class="info-line"><span>Coating surface tension / viscosity</span><b>${gam.toFixed(1)} mN/m · ${fmt(c.mu0 * 1e3)} mPa·s</b></div>
    <div class="info-line"><span>Solids / capillary length</span><b>${(c.solids * 100).toFixed(c.solids < 0.1 ? 1 : 0)} % · ${lc.toFixed(2)} mm</b></div>
    <div class="info-line"><span>Cure chemistry</span><b>${{ none: 'none', thermal: 'thermal', uv: 'UV' }[c.cure.model]}</b></div>`;
}

function stageSummary(st) {
  const s = { ...STAGE_DEFAULTS[st.type], ...st };
  switch (st.type) {
    case 'plasma': return `${s.duration} s, hold ${s.holdMinutes} min`;
    case 'dip': return `${s.speed} mm/s`;
    case 'spray': return `${s.flowMlMin} mL/min × ${s.passes}`;
    case 'drip': return s.mode === 'bead' ? `bead ${s.beadUlS} µL/s` : `${s.count} × ${s.dropUl} µL`;
    case 'vacuum': return `${s.pressureKpa} kPa`;
    case 'airflow': return `${s.nozzleSpeed} m/s, ${s.duration} s`;
    case 'dwell': return `${s.duration} s @ ${s.tempC} °C`;
    case 'cure': return s.mode === 'uv' ? `UV ${s.uvIntensity} mW/cm² × ${s.duration} s` : `${s.tempC} °C × ${s.duration} s`;
    default: return '';
  }
}
function updateStageSummaries() { document.querySelectorAll('.stage').forEach((n, i) => { const st = state.spec.stages[i]; if (st) n.querySelector('.sum').textContent = stageSummary(st); }); }

function renderStages() {
  const box = $('#stageList'); box.innerHTML = '';
  const stages = state.spec.stages;
  if (!stages.length) box.append(el('div', { class: 'hint' }, 'Add at least one stage that applies coating (dip, spray, drip or vacuum).'));
  stages.forEach((st, i) => {
    const sch = STAGE_SCHEMAS[st.type];
    const card = el('div', { class: 'stage' });
    card.style.setProperty('--stc', SERIES[(sch.color - 1) % SERIES.length]);
    const head = el('div', { class: 'stage-head' });
    head.innerHTML = `<span class="num">${i + 1}</span><span class="ttl">${esc(st.label || sch.name)}</span><span class="sum">${esc(stageSummary(st))}</span>`;
    const mk = (t, title, fn) => { const b = el('button', { class: 'btn', type: 'button', title }, t); b.addEventListener('click', (e) => { e.stopPropagation(); fn(); }); return b; };
    head.append(mk('↑', 'Move up', () => { if (i > 0) { [stages[i - 1], stages[i]] = [stages[i], stages[i - 1]]; state.openStage = i - 1; renderStages(); changed(); } }));
    head.append(mk('↓', 'Move down', () => { if (i < stages.length - 1) { [stages[i + 1], stages[i]] = [stages[i], stages[i + 1]]; state.openStage = i + 1; renderStages(); changed(); } }));
    head.append(mk('✕', 'Remove stage', () => { stages.splice(i, 1); state.openStage = -1; renderStages(); changed(); }));
    head.addEventListener('click', () => { state.openStage = state.openStage === i ? -1 : i; renderStages(); });
    card.append(head);
    if (state.openStage === i) {
      const body = el('div', { class: 'stage-body' });
      body.append(el('div', { class: 'hint' }, esc(sch.help)));
      const lr = el('div', { class: 'row' }); lr.append(el('label', {}, 'Label'));
      const li = el('input', { type: 'text' }); li.value = st.label || ''; li.placeholder = sch.name;
      li.addEventListener('change', () => { st.label = li.value; renderStages(); changed(); });
      const lw = el('div', { class: 'inp' }); lw.append(li); lr.append(lw); body.append(lr);
      const vals = { ...STAGE_DEFAULTS[st.type], ...st };
      for (const d of sch.fields) {
        if (st.type === 'drip') {
          if (vals.mode === 'bead' && ['dropUl', 'count', 'interval'].includes(d.key)) continue;
          if (vals.mode !== 'bead' && ['beadUlS', 'needleMmS'].includes(d.key)) continue;
        }
        if (st.type === 'cure' && vals.mode !== 'uv' && ['uvIntensity', 'uvTransmission'].includes(d.key)) continue;
        if (d.key === 'tempC') body.append(el('div', { class: 'hint' }, 'Environment'));
        body.append(numberRow(d, vals[d.key], (v) => { st[d.key] = v; if (d.key === 'mode') renderStages(); changed(); }));
      }
      card.append(body);
    }
    box.append(card);
  });
}

function renderEval() {
  const box = $('#evalForm'); box.innerHTML = '';
  const sp = state.spec;
  sp.metrics = sp.metrics || {};
  const L = partLength();
  const zone = sp.metrics.zone || [0, L];
  const z = el('div', { class: 'row' }); z.append(el('label', { title: 'Region of the part used for statistics and defect checks.' }, 'Evaluation zone'));
  const zi = el('div', { class: 'inp' });
  const a = el('input', { type: 'number', step: 0.5 }), b = el('input', { type: 'number', step: 0.5 });
  a.value = zone[0]; b.value = Math.min(zone[1], L);
  const upd = () => { sp.metrics.zone = [Math.max(0, Number(a.value)), Math.min(L, Number(b.value))]; changed(); };
  a.addEventListener('change', upd); b.addEventListener('change', upd);
  zi.append(a, el('span', { class: 'unit' }, '–'), b, el('span', { class: 'unit' }, 'mm'));
  z.append(zi); box.append(z);
  box.append(numberRow({ key: 'minDryUm', label: 'Coverage threshold (dry)', unit: 'µm', min: 0, max: 1000, step: 0.01, optional: true, help: 'Areas thinner than this count as uncovered. Blank = 25% of the median.' }, sp.metrics.minDryUm ?? null, (v) => { sp.metrics.minDryUm = v ?? undefined; changed(); }));
  const res = el('div', { class: 'row' }); res.append(el('label', { title: 'Grid cells along the axis × around the circumference.' }, 'Resolution'));
  const g = sp.grid || { ns: 120, nphi: 32 };
  const cur = g.ns <= 80 ? 'coarse' : g.ns >= 180 ? 'fine' : 'normal';
  const flat = sp.geometry.type === 'coupon';
  res.append(segmented([['coarse', 'Coarse'], ['normal', 'Normal'], ['fine', 'Fine']], cur, (v) => {
    sp.grid = { coarse: { ns: 70, nphi: flat ? 6 : 20 }, normal: { ns: 120, nphi: flat ? 8 : 32 }, fine: { ns: 200, nphi: flat ? 12 : 48 } }[v];
    renderEval(); changed(); previewGeometry();
  }));
  box.append(res);
  box.append(el('div', { class: 'hint' }, `Grid ${g.ns} × ${g.nphi} cells. Finer grids resolve contact lines and beads better but run longer.`));
}

function renderAll() {
  renderGeometry(); renderMaterials(); renderStages(); renderEval();
  const ps = $('#preset'); ps.value = state.spec.presetId || '';
}

// ---------------------------------------------------------------- geometry preview (before a run)
function previewGeometry(force) {
  if (!force && state.result && state.resultSpecKey === JSON.stringify(state.spec.geometry) + state.spec.surface + JSON.stringify(state.spec.grid)) return;
  try {
    const geo = buildGeometry(state.spec);
    const sg = { Ni: geo.Ni, Nj: geo.Nj, N: geo.N, L: geo.L, ds: geo.ds, surface: geo.surface, flat: geo.flat, periodic: geo.periodic, s: Array.from(geo.s), phi: Array.from(geo.phi), A: Array.from(geo.A), B: Array.from(geo.B), area: geo.area, pos: Float32Array.from(geo.pos), nrm: Float32Array.from(geo.nrm) };
    view3d.setGeometry(sg);
    view3d.tilt = state.spec.stages[0]?.tilt ?? 90;
    const v = new Float32Array(geo.N).fill(0.08);
    view3d.setField(v, [0, 1], state.cmap, null, []);
    $('#empty3d').style.display = state.result ? 'none' : 'flex';
    $('#ovl3d').innerHTML = `<b>Geometry preview</b><br>${geo.surface === 'inner' ? 'Inner (lumen) surface, cut away' : 'Outer surface'} · L = ${fmt(geo.L * 1e3)} mm`;
    if (state.result) { state.result = null; renderResultsPanel(); updateTimeline(); }
  } catch (e) { toast('Geometry error: ' + e.message, true); }
}

// ---------------------------------------------------------------- worker
let worker = null, jobId = 0;
function getWorker() {
  if (worker) return worker;
  /*WORKER_CREATE*/
  return worker;
}
function stopWorker() { if (worker) { worker.terminate(); worker = null; } }

function setRunning(on, msg) {
  state.running = on;
  $('#run').disabled = on; $('#stop').hidden = !on; $('#progress').hidden = !on;
  if (on) { $('#progress .bar i').style.width = '0%'; $('#progress .msg').textContent = msg || 'Starting…'; }
}

function validate(spec) {
  const errs = [];
  const g = spec.geometry;
  if (g.type === 'catheter' && g.id >= g.od) errs.push('Inner diameter must be smaller than the outer diameter.');
  if (!spec.stages.length) errs.push('Add at least one process stage.');
  if (!spec.stages.some((s) => ['dip', 'spray', 'drip', 'vacuum'].includes(s.type))) errs.push('No stage applies coating: add a dip, spray, drip or vacuum stage.');
  return errs;
}

function run() {
  if (state.running) return;
  const errs = validate(state.spec);
  if (errs.length) { toast(errs[0], true); return; }
  const id = ++jobId;
  setRunning(true);
  const w = getWorker();
  const spec = JSON.parse(JSON.stringify(state.spec));
  w.onmessage = (e) => {
    const d = e.data; if (d.id !== id) return;
    if (d.type === 'progress') { $('#progress .bar i').style.width = (d.f * 100).toFixed(1) + '%'; $('#progress .msg').textContent = d.msg; }
    else if (d.type === 'result') { setRunning(false); onResult(d.result, spec); }
    else if (d.type === 'error') { setRunning(false); toast('Simulation failed: ' + d.message, true); }
  };
  w.onerror = (e) => { setRunning(false); toast('Worker error: ' + e.message, true); stopWorker(); };
  w.postMessage({ cmd: 'run', id, spec });
}

function onResult(res, spec) {
  state.result = res;
  state.resultSpecKey = JSON.stringify(spec.geometry) + spec.surface + JSON.stringify(spec.grid);
  state.frame = res.frames.length - 1;
  view3d.setGeometry(res.geometry);
  $('#empty3d').style.display = 'none';
  updateTimeline(); renderResultsPanel(); updateViews(); updateHistory();
  const m = res.metrics;
  toast(`Done in ${res.stats.wallSeconds.toFixed(1)} s — mean dry film ${fmt(m.dry.mean)} µm, coverage ${(m.coverage * 100).toFixed(0)}%`);
}

// ---------------------------------------------------------------- field extraction
function fieldValues(frame, key) {
  const res = state.result, n = frame.h.length, out = new Float32Array(n);
  const hp = (res.spec.precursorUm || 0.05) * 1e-6;
  const sh = resolveCoating(res.spec).shrink || 0;
  for (let k = 0; k < n; k++) {
    const film = frame.h[k] > 4 * hp;
    switch (key) {
      case 'wet': out[k] = Math.max(0, frame.h[k] - hp) * 1e6; break;
      case 'dry': out[k] = film ? frame.m[k] * (1 - sh * frame.alpha[k]) * 1e6 : 0; break;
      case 'phi': out[k] = film ? frame.m[k] / frame.h[k] : 0; break;
      case 'alpha': out[k] = film ? frame.alpha[k] : 0; break;
      case 'theta': out[k] = (res.theta[k] * 180) / Math.PI; break;
      default: out[k] = 0;
    }
  }
  return out;
}

function rangeOf(vals, key) {
  if (key === 'phi' || key === 'alpha') return [0, 1];
  let lo = Infinity, hi = -Infinity;
  for (const v of vals) { if (v < lo) lo = v; if (v > hi) hi = v; }
  if (key === 'dry' || key === 'wet') lo = 0;
  // robust upper bound: ignore the top 0.5% (edge beads would wash out the map)
  if (key === 'dry' || key === 'wet') {
    const s = Float32Array.from(vals).sort();
    const p = s[Math.min(s.length - 1, Math.floor(s.length * 0.995))];
    if (p > 0 && p < hi) hi = p;
  }
  return niceRange(lo, hi);
}

const MARKER_STYLE = { bath: ['Bath level', [0.98, 0.7, 0.1]], nozzle: ['Applicator', [0.95, 0.4, 0.25]], meniscus: ['Meniscus', [0.2, 0.85, 0.6]], front: ['Plug front', [0.6, 0.55, 0.95]] };
function markersOf(frame) {
  const out = [];
  for (const [k, [label, rgb]] of Object.entries(MARKER_STYLE)) {
    const s = frame.aux?.[k];
    if (s !== undefined && s !== null && isFinite(s)) out.push({ s, label, rgb, color: `rgb(${rgb.map((c) => Math.round(c * 255)).join(',')})` });
  }
  return out;
}

function stageOfFrame(fr) { return fr.stage >= 0 ? state.result.spec.stages[fr.stage] : null; }

function updateViews() {
  const res = state.result;
  const fieldDef = FIELDS.find((f) => f.key === state.field);
  if (!res) return;
  const fr = res.frames[state.frame];
  const vals = fieldValues(fr, state.field);
  const range = rangeOf(vals, state.field);
  const st = stageOfFrame(fr);
  $('#cbLo').textContent = (state.tab === 'v3d' && state.field !== 'theta' ? 'bare · ' : '') + fmt(range[0]); $('#cbHi').textContent = fmt(range[1]); $('#cbUnit').textContent = fieldDef.unit;
  $('#cbGrad').style.background = gradientCSS(state.cmap);
  const marks = markersOf(fr);
  const hp = (res.spec.precursorUm || 0.05) * 1e-6;
  const film = new Float32Array(fr.h.length);
  const ex = Number($('#exag').value);
  let hmax = 0; for (let k = 0; k < film.length; k++) { film[k] = Math.max(0, fr.h[k] - hp); hmax = Math.max(hmax, film[k]); }
  // exaggeration slider maps to "max film shown as up to 40% of the radius"
  const rref = Math.max(...res.geometry.A) || res.geometry.L * 0.05;
  view3d.exag = ex > 0 && hmax > 0 ? (ex / 100) * (0.4 * rref) / hmax : 0;
  view3d.cutaway = $('#cutaway').checked;
  view3d.tilt = st ? (st.tilt ?? STAGE_DEFAULTS[st.type].tilt ?? 90) : (res.spec.stages[0]?.tilt ?? 90);
  let bare = null;
  if (state.field !== 'theta') { bare = new Uint8Array(film.length); for (let k = 0; k < film.length; k++) bare[k] = fr.h[k] <= 4 * hp ? 1 : 0; }
  view3d.setField(vals, range, state.cmap, film, marks, bare);
  const t = fr.t;
  $('#ovl3d').innerHTML = `<b>${esc(fr.label)}</b> · t = ${fmt(t)} s<br>${esc(fieldDef.label)}${fieldDef.unit ? ' (' + fieldDef.unit + ')' : ''}<br>`
    + (view3d.radial > 1.01 ? `Radius drawn ×${fmt(view3d.radial)} for visibility<br>` : '')
    + `${res.geometry.surface === 'inner' ? 'Lumen surface' + (view3d.cutaway ? ' (upper half cut away)' : '') : 'Outer surface'}`
    + (st ? ` · tilt ${st.tilt ?? STAGE_DEFAULTS[st.type].tilt}°${(st.rpm ?? 0) > 0 ? `, ${st.rpm} rpm` : ''}` : '')
    + marks.map((m) => `<br><span class="tag" style="background:${m.color}"></span>${m.label} at ${fmt(m.s * 1e3)} mm`).join('')
    + (fr.aux?.speed ? `<br>Meniscus speed ${fmt(fr.aux.speed * 1e3)} mm/s` : '') + (fr.aux?.air ? `<br>Lumen air speed ${fmt(fr.aux.air)} m/s` : '');
  heatmap.set(res.geometry, vals, range, state.cmap, fieldDef.unit, marks);
  // profiles
  const { Ni, Nj } = res.geometry;
  const sx = res.geometry.s.map((v) => v * 1e3);
  const mean = [], lo = [], hi = [];
  for (let i = 0; i < Ni; i++) {
    let a = 0, w = 0, mn = Infinity, mx = -Infinity;
    for (let j = 0; j < Nj; j++) { const k = i * Nj + j, ar = res.geometry.area[k]; a += vals[k] * ar; w += ar; mn = Math.min(mn, vals[k]); mx = Math.max(mx, vals[k]); }
    mean.push(a / w); lo.push(mn); hi.push(mx);
  }
  chAxial.set({ title: `${fieldDef.label} along the part`, xlabel: 's (mm)', ylabel: fieldDef.unit, series: [{ name: 'Circumferential mean', x: sx, y: mean, color: SERIES[0], band: { lo, hi } }], markers: marks.map((m) => ({ x: m.s * 1e3, label: m.label })) });
  if (!res.geometry.flat) {
    const cm = new Array(Nj).fill(0), cw = new Array(Nj).fill(0);
    for (let i = 0; i < Ni; i++) for (let j = 0; j < Nj; j++) { const k = i * Nj + j, ar = res.geometry.area[k]; cm[j] += vals[k] * ar; cw[j] += ar; }
    chCirc.set({ title: `${fieldDef.label} around the circumference (axial mean)`, xlabel: 'φ (°) — 90° top, 270° bottom when horizontal', ylabel: fieldDef.unit, series: [{ name: 'Axial mean', x: res.geometry.phi.map((p) => (p * 180) / Math.PI), y: cm.map((c, j) => c / cw[j]), color: SERIES[1] }] });
  } else {
    const cm = new Array(Nj).fill(0), cw = new Array(Nj).fill(0);
    for (let i = 0; i < Ni; i++) for (let j = 0; j < Nj; j++) { const k = i * Nj + j; cm[j] += vals[k]; cw[j]++; }
    const W = res.spec.geometry.width;
    chCirc.set({ title: `${fieldDef.label} across the width`, xlabel: 'x (mm)', ylabel: fieldDef.unit, series: [{ name: 'Axial mean', x: cm.map((_, j) => -W / 2 + ((j + 0.5) * W) / Nj), y: cm.map((c, j) => c / cw[j]), color: SERIES[1] }] });
  }
  for (const c of [chThick, chCure, chVisc, chSolids]) { c.cursorX = t; c.draw(); }
  $('#tlInfo').textContent = `Frame ${state.frame + 1}/${res.frames.length} · t = ${fmt(t)} s · ${fr.label}`;
}

function updateHistory() {
  const res = state.result; if (!res) return;
  const H = res.history;
  const t = H.map((h) => h.t);
  const markers = res.stageInfo.map((s) => ({ x: s.tStart, label: s.label }));
  chThick.set({ title: 'Mean film thickness (film-covered area)', xlabel: 't (s)', ylabel: 'µm', markers, series: [
    { name: 'Wet', x: t, y: H.map((h) => h.wet * 1e6), color: SERIES[0] },
    { name: 'Dry', x: t, y: H.map((h) => h.dry * 1e6), color: SERIES[1] }] });
  chCure.set({ title: 'Mean degree of cure', xlabel: 't (s)', ylabel: 'α', markers, series: [{ name: 'Cure', x: t, y: H.map((h) => h.alpha), color: SERIES[2] }] });
  chVisc.set({ title: 'Peak viscosity (log scale)', xlabel: 't (s)', ylabel: 'Pa·s', logY: true, markers, series: [{ name: 'Viscosity', x: t, y: H.map((h) => h.muMax), color: SERIES[3] }] });
  chSolids.set({ title: 'Liquid film volume', xlabel: 't (s)', ylabel: 'µL', markers, series: [{ name: 'Volume', x: t, y: H.map((h) => h.volume * 1e9), color: SERIES[6] }] });
}

function updateTimeline() {
  const n = state.result ? state.result.frames.length : 1;
  const f = $('#frame'); f.max = n - 1; f.value = state.frame; f.disabled = !state.result;
  $('#play').disabled = !state.result;
  if (!state.result) $('#tlInfo').textContent = 'No results yet';
}

// ---------------------------------------------------------------- results panel
function renderResultsPanel() {
  const box = $('#results');
  const res = state.result;
  if (!res) { box.innerHTML = '<div class="empty small">Results appear here after a run.</div>'; return; }
  const m = res.metrics;
  const sevOrder = { high: 0, medium: 1, info: 2 };
  const defects = m.defects.slice().sort((a, b) => sevOrder[a.severity] - sevOrder[b.severity]);
  const icon = { high: '⨯', medium: '!', info: 'i' };
  const sevLabel = { high: 'Critical', medium: 'Warning', info: 'Note' };
  const cureOn = resolveCoating(res.spec).cure.model !== 'none';
  box.innerHTML = `
    <div class="metric-grid">
      <div class="metric"><div class="k">Mean dry film</div><div class="v">${fmt(m.dry.mean)}<small>µm</small></div><div class="s">P5–P95 ${fmt(m.dry.p5)}–${fmt(m.dry.p95)} µm</div></div>
      <div class="metric"><div class="k">Uniformity (CoV)</div><div class="v">${(m.dry.cov * 100).toFixed(0)}<small>%</small></div><div class="s">min ${fmt(m.dry.min)} · max ${fmt(m.dry.max)} µm</div></div>
      <div class="metric"><div class="k">Coverage</div><div class="v">${(m.coverage * 100).toFixed(1)}<small>%</small></div><div class="s">zone ${fmt(m.zoneMm[0])}–${fmt(m.zoneMm[1])} mm</div></div>
      <div class="metric"><div class="k">${cureOn ? 'Degree of cure' : 'Wet film (mean)'}</div><div class="v">${cureOn ? (m.cureMean * 100).toFixed(0) + '<small>%</small>' : fmt(m.wet.mean) + '<small>µm</small>'}</div><div class="s">contact angle ${m.groups.contactAngleMean_deg.toFixed(0)}° (${m.groups.contactAngleMin_deg.toFixed(0)}–${m.groups.contactAngleMax_deg.toFixed(0)}°)</div></div>
    </div>
    <h4>Findings</h4>
    ${defects.length ? defects.map((d) => `<div class="defect"><div class="t"><span class="badge ${d.severity}">${icon[d.severity]} ${sevLabel[d.severity]}</span>${esc(d.title)}</div><div class="d">${esc(d.detail)}</div>${d.fix ? `<div class="f">→ ${esc(d.fix)}</div>` : ''}</div>`).join('') : '<div class="defect"><div class="t"><span class="badge ok">✓ OK</span>No defects detected</div><div class="d">Film is continuous and reasonably uniform in the evaluation zone.</div></div>'}
    ${m.predictions.length ? `<h4>Analytic checks</h4>${m.predictions.map((p) => `<div class="hint">• <b>${esc(p.stage)}:</b> ${esc(p.text)}</div>`).join('')}` : ''}
    <h4>Physical groups</h4>
    <table class="kv">
      <tr><td>Surface tension</td><td>${fmt(m.groups.surfaceTension_mNm)} mN/m</td></tr>
      <tr><td>Viscosity (as applied)</td><td>${fmt(m.groups.viscosity_mPas)} mPa·s</td></tr>
      <tr><td>Capillary length</td><td>${fmt(m.groups.capillaryLength_mm)} mm</td></tr>
      ${m.groups.bond !== null ? `<tr><td>Bond number (ρgR²/γ)</td><td>${fmt(m.groups.bond)}</td></tr>` : ''}
      ${m.groups.jurinHeight_mm !== undefined ? `<tr><td>Capillary rise in lumen</td><td>${fmt(m.groups.jurinHeight_mm)} mm</td></tr>` : ''}
    </table>
    <h4>Mass balance</h4>
    <table class="kv">
      <tr><td>Applied by spray / drip</td><td>${fmt(m.massBalance.deposited_uL)} µL</td></tr>
      <tr><td>Solvent evaporated</td><td>${fmt(m.massBalance.evaporated_uL)} µL</td></tr>
      <tr><td>Dripped off ends</td><td>${fmt(m.massBalance.dripped_uL)} µL</td></tr>
      <tr><td>Remaining film (liquid + solids)</td><td>${fmt(m.massBalance.film_uL)} µL</td></tr>
      <tr><td>Solids in film</td><td>${fmt(m.massBalance.solids_uL)} µL</td></tr>
    </table>
    <h4>Stages</h4>
    <table class="kv">${res.stageInfo.map((s) => `<tr><td>${esc(s.label)}</td><td>${fmt(s.tStart)} → ${fmt(s.tEnd)} s</td></tr>`).join('')}</table>
    <div class="hint" style="margin-top:10px">Solved in ${res.stats.wallSeconds.toFixed(1)} s · ${res.stats.steps.toLocaleString()} time steps · grid ${res.geometry.Ni}×${res.geometry.Nj}</div>`;
}

// ---------------------------------------------------------------- sweep
const SWEEP_PARAMS = () => {
  const out = [];
  const sp = state.spec;
  sp.stages.forEach((st, i) => {
    for (const d of STAGE_SCHEMAS[st.type].fields) if (d.kind !== 'select' && !d.optional) out.push({ id: `stage:${i}:${d.key}`, label: `Stage ${i + 1} (${st.label || STAGE_SCHEMAS[st.type].name}) — ${d.label}`, unit: d.unit, get: (s) => ({ ...STAGE_DEFAULTS[s.stages[i].type], ...s.stages[i] })[d.key], set: (s, v) => { s.stages[i][d.key] = v; } });
  });
  for (const d of COATING_OVERRIDES) out.push({ id: `coat:${d.key}`, label: `Coating — ${d.label}`, unit: d.unit, get: (s) => resolveCoating(s)[d.key], set: (s, v) => { s.coatingOverrides = { ...(s.coatingOverrides || {}), [d.key]: v }; } });
  const gs = GEOMETRY_SCHEMAS[sp.geometry.type];
  for (const d of gs.fields) out.push({ id: `geo:${d.key}`, label: `Part — ${d.label}`, unit: d.unit, get: (s) => s.geometry[d.key], set: (s, v) => { s.geometry[d.key] = v; } });
  out.push({ id: 'rough', label: 'Substrate — roughness ratio', unit: '', get: (s) => s.roughness || 1, set: (s, v) => { s.roughness = v; } });
  return out;
};

function renderSweepForm() {
  const box = $('#sweepForm'); box.innerHTML = '';
  const params = SWEEP_PARAMS();
  const ps = el('select'); for (const p of params) ps.append(el('option', { value: p.id }, esc(p.label + (p.unit ? ` (${p.unit})` : ''))));
  const prev = state.sweepParam && params.find((p) => p.id === state.sweepParam);
  if (prev) ps.value = prev.id;
  const cur = () => params.find((p) => p.id === ps.value);
  const from = el('input', { type: 'number', step: 'any' }), to = el('input', { type: 'number', step: 'any' }), n = el('input', { type: 'number', min: 2, max: 16, step: 1 });
  const setDefaults = () => { const v = Number(cur()?.get(state.spec)) || 1; from.value = +(v * 0.5).toPrecision(3); to.value = +(v * 2).toPrecision(3); };
  setDefaults(); n.value = 6;
  ps.addEventListener('change', () => { state.sweepParam = ps.value; setDefaults(); });
  const lbl = (t, e) => { const l = el('label'); l.append(t, e); return l; };
  const go = el('button', { class: 'btn primary', type: 'button' }, 'Run sweep');
  const logc = el('input', { type: 'checkbox' }); const ll = el('label', { class: 'chk' }); ll.style.flexDirection = 'row'; ll.append(logc, ' log spacing');
  go.addEventListener('click', () => {
    const p = cur(); const a = Number(from.value), b = Number(to.value), k = Math.max(2, Math.min(16, Math.round(Number(n.value))));
    if (!(isFinite(a) && isFinite(b))) return toast('Enter a valid range', true);
    if (logc.checked && (a <= 0 || b <= 0)) return toast('Log spacing needs positive values', true);
    const values = Array.from({ length: k }, (_, i) => logc.checked ? a * Math.pow(b / a, i / (k - 1)) : a + ((b - a) * i) / (k - 1));
    runSweep(p, values);
  });
  box.append(lbl('Parameter', ps), lbl('From', from), lbl('To', to), lbl('Runs', n), ll, go);
  box.append(el('div', { class: 'hint', style: 'flex-basis:100%' }, 'Each run uses the full process sequence with one parameter changed. Use a coarse grid for quick sweeps.'));
}

function runSweep(param, values) {
  if (state.running) return;
  const errs = validate(state.spec); if (errs.length) return toast(errs[0], true);
  const specs = values.map((v) => { const s = JSON.parse(JSON.stringify(state.spec)); param.set(s, v); return s; });
  const id = ++jobId;
  state.sweep = { param, values, items: [] };
  setRunning(true, 'Sweep starting…');
  const w = getWorker();
  w.onmessage = (e) => {
    const d = e.data; if (d.id !== id) return;
    if (d.type === 'progress') { $('#progress .bar i').style.width = (d.f * 100).toFixed(1) + '%'; $('#progress .msg').textContent = d.msg; }
    else if (d.type === 'sweepItem') { state.sweep.items[d.n] = d.item; renderSweepResults(); }
    else if (d.type === 'sweepDone') { setRunning(false); toast('Sweep complete'); }
  };
  w.postMessage({ cmd: 'sweep', id, specs, values });
}

function renderSweepResults() {
  const sw = state.sweep; if (!sw) return;
  const ok = sw.items.filter((x) => x && x.ok);
  const x = ok.map((i) => i.value);
  const xl = `${sw.param.label.replace(/^.*— /, '')}${sw.param.unit ? ' (' + sw.param.unit + ')' : ''}`;
  swA.set({ title: 'Mean dry film thickness', xlabel: xl, ylabel: 'µm', series: [{ name: 'Mean', x, y: ok.map((i) => i.dry.mean), color: SERIES[0], points: true, band: { lo: ok.map((i) => i.dry.p5), hi: ok.map((i) => i.dry.p95) } }] });
  swB.set({ title: 'Non-uniformity (CoV)', xlabel: xl, ylabel: '%', series: [{ name: 'CoV', x, y: ok.map((i) => i.dry.cov * 100), color: SERIES[1], points: true }] });
  swC.set({ title: 'Coverage', xlabel: xl, ylabel: '%', series: [{ name: 'Coverage', x, y: ok.map((i) => i.coverage * 100), color: SERIES[2], points: true }] });
  $('#sweepTable').innerHTML = `<table class="data"><tr><th>${esc(xl)}</th><th>Mean dry (µm)</th><th>P5–P95 (µm)</th><th>CoV</th><th>Coverage</th><th>Cure</th><th>Findings</th></tr>${sw.items.map((i) => !i ? '' : i.ok ? `<tr><td>${fmt(i.value)}</td><td>${fmt(i.dry.mean)}</td><td>${fmt(i.dry.p5)}–${fmt(i.dry.p95)}</td><td>${(i.dry.cov * 100).toFixed(0)}%</td><td>${(i.coverage * 100).toFixed(1)}%</td><td>${(i.cure * 100).toFixed(0)}%</td><td style="text-align:left">${esc(i.defects.filter((d) => d !== 'Process note').join(', ') || '—')}</td></tr>` : `<tr><td>${fmt(i.value)}</td><td colspan="6" style="text-align:left">Failed: ${esc(i.error)}</td></tr>`).join('')}</table>`;
}

// ---------------------------------------------------------------- exports
function download(name, text, type = 'application/json') {
  const a = el('a'); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
function menuAction(act) {
  const res = state.result;
  const need = () => { if (!res) { toast('Run a simulation first', true); return false; } return true; };
  if (act === 'save') download('coatsim-setup.json', JSON.stringify(state.spec, null, 2));
  if (act === 'load') $('#fileIn').click();
  if (act === 'link') {
    const url = location.href.split('#')[0] + '#setup=' + btoa(unescape(encodeURIComponent(JSON.stringify(state.spec))));
    navigator.clipboard?.writeText(url).then(() => toast('Link copied to clipboard'), () => { prompt('Copy this link:', url); });
  }
  if (act === 'results' && need()) {
    const m = { ...res.metrics }; delete m.dryField;
    download('coatsim-results.json', JSON.stringify({ version: VERSION, spec: res.spec, metrics: m, history: res.history, stages: res.stageInfo, warnings: res.warnings }, null, 2));
  }
  if (act === 'csv' && need()) {
    const fr = res.frames[res.frames.length - 1];
    const wet = fieldValues(fr, 'wet'), dry = fieldValues(fr, 'dry'), al = fieldValues(fr, 'alpha'), th = fieldValues(fr, 'theta');
    const g = res.geometry; const rows = ['s_mm,phi_deg,x_mm,y_mm,wet_um,dry_um,cure,contact_angle_deg'];
    for (let i = 0; i < g.Ni; i++) for (let j = 0; j < g.Nj; j++) { const k = i * g.Nj + j; rows.push([g.s[i] * 1e3, (g.phi[j] * 180) / Math.PI, g.pos[3 * k] * 1e3, g.pos[3 * k + 1] * 1e3, wet[k], dry[k], al[k], th[k]].map((v) => +v.toPrecision(6)).join(',')); }
    download('coatsim-field.csv', rows.join('\n'), 'text/csv');
  }
  if (act === 'profile' && need()) {
    const a = res.metrics.axial; const rows = ['s_mm,dry_mean_um,dry_min_um,dry_max_um,wet_mean_um'];
    for (let i = 0; i < a.s.length; i++) rows.push([a.s[i], a.mean[i], a.min[i], a.max[i], a.wetMean[i]].map((v) => +v.toPrecision(6)).join(','));
    download('coatsim-axial-profile.csv', rows.join('\n'), 'text/csv');
  }
  if (act === 'png' && need()) { const a = el('a'); a.href = view3d.snapshot(); a.download = 'coatsim-3d.png'; a.click(); }
  if (act === 'help') $('#help').showModal();
}

// ---------------------------------------------------------------- init
let view3d, heatmap, chAxial, chCirc, chThick, chCure, chVisc, chSolids, swA, swB, swC;

function setSpec(spec) {
  state.spec = spec;
  state.spec.stages = state.spec.stages || [];
  state.openStage = -1;
  state.result = null; state.sweep = null;
  renderAll(); renderResultsPanel(); updateTimeline(); previewGeometry(); renderSweepForm();
  $('#sweepTable').innerHTML = ''; for (const c of [swA, swB, swC]) c.set({ series: [] });
  saveLocal();
}

function init() {
  $('#ver').textContent = VERSION;
  view3d = new View3D($('#v3d'));
  heatmap = new Heatmap($('#mapInner'));
  chAxial = new LineChart($('#chAxial')); chCirc = new LineChart($('#chCirc'));
  chThick = new LineChart($('#chThick')); chCure = new LineChart($('#chCure')); chVisc = new LineChart($('#chVisc')); chSolids = new LineChart($('#chSolids'));
  swA = new LineChart($('#swA')); swB = new LineChart($('#swB')); swC = new LineChart($('#swC'));
  const ps = $('#preset');
  ps.append(el('option', { value: '' }, '— custom setup —'));
  for (const p of PRESETS) ps.append(el('option', { value: p.id, title: p.description }, esc(p.name)));
  ps.addEventListener('change', () => { if (!ps.value) return; const s = getPreset(ps.value); s.presetId = ps.value; setSpec(s); toast(PRESETS.find((p) => p.id === ps.value).description); });
  for (const f of FIELDS) $('#field').append(el('option', { value: f.key }, esc(f.label)));
  for (const c of COLORMAPS) $('#cmap').append(el('option', { value: c }, { blue: 'Blue (sequential)', viridis: 'Viridis', cure: 'Copper' }[c] || c));
  $('#field').addEventListener('change', (e) => { state.field = e.target.value; updateViews(); });
  $('#cmap').addEventListener('change', (e) => { state.cmap = e.target.value; updateViews(); });
  $('#exag').addEventListener('input', updateViews);
  $('#cutaway').addEventListener('change', () => { view3d.cutaway = $('#cutaway').checked; view3d.render(); });
  $('#radial').addEventListener('change', () => { view3d.radialMode = $('#radial').value; if (state.result) { view3d.setGeometry(state.result.geometry); updateViews(); } else previewGeometry(true); });
  $('#resetView').addEventListener('click', () => view3d.resetView());
  $('#frame').addEventListener('input', (e) => { state.frame = Number(e.target.value); updateViews(); });
  $('#play').addEventListener('click', togglePlay);
  $('#run').addEventListener('click', run);
  $('#stop').addEventListener('click', () => { stopWorker(); setRunning(false); toast('Stopped'); });
  const typeSel = $('#addStageType');
  for (const [k, v] of Object.entries(STAGE_SCHEMAS)) typeSel.append(el('option', { value: k }, esc(v.name)));
  $('#addStage').addEventListener('click', () => {
    const t = typeSel.value; const prev = state.spec.stages[state.spec.stages.length - 1];
    const st = { type: t };
    if (prev && prev.tilt !== undefined) st.tilt = prev.tilt;
    state.spec.stages.push(st); state.openStage = state.spec.stages.length - 1; renderStages(); changed(); renderSweepForm();
  });
  $('#tabs').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    document.querySelectorAll('#tabs button').forEach((x) => x.classList.toggle('active', x === b));
    document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === b.dataset.tab));
    state.tab = b.dataset.tab;
    document.querySelectorAll('.v3only').forEach((x) => (x.style.display = state.tab === 'v3d' ? '' : 'none'));
    $('#viewbar').style.display = state.tab === 'sweep' || state.tab === 'hist' ? 'none' : '';
    if (state.tab === 'sweep') renderSweepForm();
    requestAnimationFrame(() => { view3d.render(); heatmap.draw(); [chAxial, chCirc, chThick, chCure, chVisc, chSolids, swA, swB, swC].forEach((c) => c.draw()); });
  });
  $('#menuBtn').addEventListener('click', (e) => { e.stopPropagation(); $('#menuList').hidden = !$('#menuList').hidden; });
  document.addEventListener('click', () => { $('#menuList').hidden = true; });
  $('#menuList').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) menuAction(b.dataset.act); });
  $('#fileIn').addEventListener('change', async (e) => {
    const f = e.target.files[0]; if (!f) return;
    try { const s = JSON.parse(await f.text()); if (!s.geometry || !s.stages) throw new Error('not a CoatSim setup'); setSpec(s.spec && s.metrics ? s.spec : s); toast('Setup loaded'); } catch (err) { toast('Could not load: ' + err.message, true); }
    e.target.value = '';
  });
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); run(); }
    if (e.key === ' ' && !['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON'].includes(document.activeElement.tagName)) { e.preventDefault(); togglePlay(); }
  });
  const fromHash = specFromHash();
  setSpec(fromHash || loadLocal() || Object.assign(getPreset(PRESETS[0].id), { presetId: PRESETS[0].id }));
  if (fromHash) history.replaceState(null, '', location.pathname);
}

function togglePlay() {
  if (!state.result) return;
  state.playing = !state.playing;
  $('#play').textContent = state.playing ? '❚❚' : '▶';
  if (state.playing && state.frame >= state.result.frames.length - 1) state.frame = 0;
  const tick = () => {
    if (!state.playing || !state.result) return;
    state.frame++;
    if (state.frame >= state.result.frames.length) { state.frame = state.result.frames.length - 1; state.playing = false; $('#play').textContent = '▶'; }
    $('#frame').value = state.frame; updateViews();
    if (state.playing) setTimeout(tick, 110);
  };
  if (state.playing) tick();
}

window.addEventListener('DOMContentLoaded', init);
