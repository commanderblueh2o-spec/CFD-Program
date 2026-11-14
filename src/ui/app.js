// CoatSim application controller.
import { PRESETS, getPreset } from '../core/presets.js';
import { SUBSTRATES, COATINGS, contactAngleOWRK, wenzel, resolveCoating, resolveSubstrate } from '../core/materials.js';
import { buildGeometry } from '../core/geometry.js';
import { capillaryLength } from '../core/physics.js';
import { GEOMETRY_SCHEMAS, STAGE_SCHEMAS, SUBSTRATE_OVERRIDES, FIELDS } from './schema.js';
import { STAGE_DEFAULTS } from '../core/processes.js';
import { SERIES, COLORMAPS, gradientCSS, fmt, niceRange } from './colormap.js';
import { LineChart } from './charts.js';
import { Heatmap } from './heatmap.js';
import { View3D } from './view3d.js';

const VERSION = '1.0.0';
const $ = (s) => document.querySelector(s);
const el = (tag, attrs = {}, html = '') => { const e = document.createElement(tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); if (html) e.innerHTML = html; return e; };
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const LN10 = Math.log(10), R_GAS = 8.314;
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

const state = {
  spec: null, result: null, p: 0, playing: false, speed: 1, field: 'state', cmap: 'blue', tab: 'v3d',
  openStage: -1, running: false, sweep: null, live: false,
};

// ---------------------------------------------------------------- persistence & helpers
function saveLocal() { try { localStorage.setItem('coatsim.spec', JSON.stringify(state.spec)); } catch { /* storage unavailable */ } }
function loadLocal() { try { const s = localStorage.getItem('coatsim.spec'); return s ? JSON.parse(s) : null; } catch { return null; } }
function toast(msg, err) { const t = $('#toast'); t.textContent = msg; t.className = 'toast' + (err ? ' err' : ''); t.hidden = false; clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), err ? 6000 : 2800); }
function specFromHash() {
  if (!location.hash.startsWith('#setup=')) return null;
  try { return JSON.parse(decodeURIComponent(escape(atob(location.hash.slice(7))))); } catch { return null; }
}

// ---------------------------------------------------------------- controls
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
    input.value = value === null || value === undefined || big ? '' : value;
    if (big) input.placeholder = 'all';
    if (def.optional) input.placeholder = 'auto';
    input.addEventListener('change', () => {
      if (input.value === '') { onChange(def.optional ? null : ['immersionMm', 'fillLengthMm', 'endMm'].includes(def.key) ? 1e9 : (def.min ?? 0)); return; }
      const v = clamp(Number(input.value), def.min ?? -Infinity, def.max ?? Infinity);
      input.value = v; onChange(v);
    });
  }
  inp.append(input);
  if (def.unit) inp.append(el('span', { class: 'unit' }, esc(def.unit)));
  row.append(lab, inp);
  return row;
}

// Slider row: label + editable value on one line, slider underneath.
function sliderRow(def, value, onChange) {
  const [lo, hi, scale] = def.sl || [def.min, def.max, 'lin'];
  const log = scale === 'log' && lo > 0;
  const toPos = (v) => clamp((log ? (Math.log(Math.max(v, lo)) - Math.log(lo)) / (Math.log(hi) - Math.log(lo)) : (v - lo) / (hi - lo)), 0, 1) * 1000;
  const fromPos = (p) => { const t = p / 1000; return log ? Math.exp(Math.log(lo) + t * (Math.log(hi) - Math.log(lo))) : lo + t * (hi - lo); };
  const nice = (v) => { if (def.step >= 1) return Math.round(v); if (v === 0) return 0; const d = Math.max(0, 2 - Math.floor(Math.log10(Math.abs(v)))); return +v.toFixed(Math.min(d, 4)); };
  const row = el('div', { class: 'srow' });
  const top = el('div', { class: 'stop' });
  top.append(el('label', { title: def.help || '' }, esc(def.label)));
  const box = el('div', { class: 'sval' });
  const num = el('input', { type: 'number', step: 'any' }); num.value = nice(Number(value) || 0);
  box.append(num); if (def.unit) box.append(el('span', { class: 'unit' }, esc(def.unit)));
  top.append(box);
  const rng = el('input', { type: 'range', min: 0, max: 1000, step: 1 }); rng.value = toPos(Number(value) || 0);
  if (def.disabled) { rng.disabled = true; num.disabled = true; row.classList.add('disabled'); }
  rng.addEventListener('input', () => { const v = nice(fromPos(Number(rng.value))); num.value = v; onChange(v, true); });
  rng.addEventListener('change', () => onChange(Number(num.value), false));
  num.addEventListener('change', () => { const v = clamp(Number(num.value), def.min ?? -Infinity, def.max ?? Infinity); num.value = v; rng.value = toPos(v); onChange(v, false); });
  row.append(top, rng);
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

function changed(dragging) { saveLocal(); renderMaterialInfo(); updateStageSummaries(); if (!dragging) scheduleLive(); }

// ---------------------------------------------------------------- Part
function renderGeometry() {
  const box = $('#geoForm'); box.innerHTML = '';
  const g = state.spec.geometry;
  box.append(numberRow({ key: 'type', label: 'Part', kind: 'select', options: Object.entries(GEOMETRY_SCHEMAS).map(([k, v]) => [k, v.name]) }, g.type, (v) => {
    state.spec.geometry = { type: v, ...JSON.parse(JSON.stringify(GEOMETRY_SCHEMAS[v].defaults)) };
    if (v === 'coupon') state.spec.surface = 'outer';
    state.spec.metrics = { zone: null };
    renderGeometry(); renderAdvanced(); changed(); previewGeometry();
  }));
  if (g.type !== 'coupon') {
    const r = el('div', { class: 'row sel' });
    r.append(el('label', {}, 'Coated surface'));
    r.append(segmented([['outer', 'Outside'], ['inner', 'Inside (bore)']], state.spec.surface || 'outer', (v) => { state.spec.surface = v; renderGeometry(); changed(); previewGeometry(); }));
    box.append(r);
  }
  const sch = GEOMETRY_SCHEMAS[g.type];
  const dims = el('details', { class: 'adv' }); dims.append(el('summary', {}, 'Dimensions'));
  for (const d of sch.fields) dims.append(numberRow(d, g[d.key] ?? sch.defaults[d.key], (v) => { g[d.key] = v; changed(); previewGeometry(); }));
  if (sch.hasPoints) {
    dims.append(el('div', { class: 'hint' }, 'Bore profile, one point per line: <code>s, half-width, half-height</code> (mm).'));
    const ta = el('textarea', { class: 'pts', rows: 5 });
    ta.value = (g.points || []).map((p) => p.join(', ')).join('\n');
    ta.addEventListener('change', () => {
      const pts = ta.value.split('\n').map((l) => l.split(/[,\s]+/).filter(Boolean).map(Number)).filter((p) => p.length >= 3 && p.every(isFinite));
      if (pts.length >= 2) { g.points = pts; changed(); previewGeometry(); } else toast('Need at least two valid points', true);
    });
    dims.append(ta);
  }
  box.append(dims);
}

function partLength() { try { return buildGeometry({ ...state.spec, grid: { ns: 4, nphi: 8 } }).L * 1e3; } catch { return 0; } }

// ---------------------------------------------------------------- Coating
function coatingSliders() {
  const sp = state.spec, c = resolveCoating(sp);
  const ov = () => (sp.coatingOverrides = sp.coatingOverrides || {});
  const out = [
    { id: 'mu', def: { label: 'Viscosity', unit: 'mPa·s', min: 0.3, max: 1e5, sl: [1, 5000, 'log'], help: 'As applied, at 25 °C.' }, get: () => c.mu0 * 1e3, set: (v) => { ov().mu0 = v / 1e3; } },
    { id: 'gamma', def: { label: 'Surface tension', unit: 'mN/m', min: 10, max: 80, step: 0.1, sl: [18, 73, 'lin'], help: 'Lower tension wets better.' }, get: () => c.d + c.p, set: (v) => { const r = c.d / (c.d + c.p); ov().d = v * r; ov().p = v * (1 - r); } },
    { id: 'solids', def: { label: 'Solids content', unit: '%', min: 0.1, max: 100, sl: [0.5, 100, 'log'], help: 'Volume % of non-volatile material. Dry film ≈ wet film × solids.' }, get: () => c.solids * 100, set: (v) => { ov().solids = v / 100; if (v / 100 > c.phiMax) ov().phiMax = Math.min(1, v / 100); } },
    { id: 'evap', def: { label: 'Drying rate', unit: 'µm/s', min: 0, max: 20, sl: [0.005, 3, 'log'], help: 'Solvent evaporation of a flat film at 25 °C in still air.', disabled: c.solids >= c.phiMax }, get: () => c.evap0, set: (v) => { ov().evap0 = v; } },
  ];
  if (c.cure.model === 'thermal') {
    const Tref = (c.cure.refC ?? 110) + 273.15;
    const k = (cu) => cu.A1 * Math.exp(-(cu.Ea1 * 1000) / (R_GAS * Tref));
    out.push({ id: 'cure', def: { label: `Cure time at ${c.cure.refC ?? 110} °C (90%)`, unit: 'min', min: 0.05, max: 2000, sl: [0.5, 240, 'log'], help: 'Sets the crosslinking rate; the temperature dependence follows the activation energy.' },
      get: () => LN10 / k(c.cure) / 60, set: (v) => { const cu = { ...c.cure, ...(ov().cure || {}) }; cu.A1 = (LN10 / (v * 60)) * Math.exp((cu.Ea1 * 1000) / (R_GAS * Tref)); ov().cure = cu; } });
    out.push({ id: 'ea', def: { label: 'Cure activation energy', unit: 'kJ/mol', min: 20, max: 200, step: 1, sl: [30, 150, 'lin'], help: 'Higher = more sensitive to temperature.' },
      get: () => c.cure.Ea1, set: (v) => { const cu = { ...c.cure, ...(ov().cure || {}) }; const kref = cu.A1 * Math.exp(-(cu.Ea1 * 1000) / (R_GAS * Tref)); cu.Ea1 = v; cu.A1 = kref * Math.exp((v * 1000) / (R_GAS * Tref)); ov().cure = cu; } });
  } else if (c.cure.model === 'uv') {
    out.push({ id: 'cure', def: { label: 'UV dose for 90% cure', unit: 'mJ/cm²', min: 10, max: 1e5, sl: [100, 20000, 'log'] }, get: () => (100 * LN10) / c.cure.kUV, set: (v) => { ov().cure = { ...c.cure, kUV: (100 * LN10) / v }; } });
  }
  return out;
}

function renderMaterials() {
  const box = $('#matForm'); box.innerHTML = '';
  const sp = state.spec;
  box.append(numberRow({ key: 'coating', label: 'Coating', kind: 'select', options: Object.entries(COATINGS).map(([k, v]) => [k, v.name]) }, sp.coating, (v) => { sp.coating = v; sp.coatingOverrides = {}; renderMaterials(); changed(); }));
  box.append(numberRow({ key: 'substrate', label: 'Part material', kind: 'select', options: Object.entries(SUBSTRATES).map(([k, v]) => [k, v.name]) }, sp.substrate, (v) => { sp.substrate = v; sp.substrateOverrides = {}; renderMaterials(); renderAdvanced(); changed(); }));
  box.append(el('div', { id: 'matInfo' }));
  for (const s of coatingSliders()) box.append(sliderRow(s.def, s.get(), (v, dragging) => { s.set(v); changed(dragging); }));
  const reset = el('button', { class: 'linkbtn', type: 'button' }, 'Reset coating to library values');
  reset.addEventListener('click', () => { sp.coatingOverrides = {}; renderMaterials(); changed(); });
  box.append(reset);
  renderMaterialInfo();
}

function renderMaterialInfo() {
  const box = $('#matInfo'); if (!box) return;
  const c = resolveCoating(state.spec), s = resolveSubstrate(state.spec);
  const th = (wenzel(contactAngleOWRK(s, c), state.spec.roughness || 1) * 180) / Math.PI;
  const lc = capillaryLength((c.d + c.p) * 1e-3, c.rho) * 1e3;
  const cls = th < 20 ? 'good' : th < 60 ? 'ok' : 'bad';
  const note = th < 20 ? 'spreads well' : th < 60 ? 'wets' : th < 90 ? 'poor wetting — plasma recommended' : 'beads up — plasma needed';
  const plasma = state.spec.stages.some((x) => x.type === 'plasma');
  box.innerHTML = `<div class="wet-chip ${cls}"><b>${th.toFixed(0)}°</b> contact angle on untreated ${esc(s.name.replace(/ \(.*\)/, ''))} — ${note}${plasma ? ' <span class="muted">(the plasma stage lowers it)</span>' : ''}</div>
    <div class="hint">${c.cure.model === 'thermal' ? 'Heat-cured' : c.cure.model === 'uv' ? 'UV-cured' : 'Non-curing'} · capillary length ${lc.toFixed(1)} mm</div>`;
}

// ---------------------------------------------------------------- Process stages
function stageSummary(st) {
  const s = { ...STAGE_DEFAULTS[st.type], ...st };
  switch (st.type) {
    case 'plasma': return `${s.duration} s`;
    case 'dip': return `${s.speed} mm/s`;
    case 'spray': return `${s.flowMlMin} mL/min × ${s.passes}`;
    case 'drip': return s.mode === 'pump' ? `${s.pumpVolumeUl} µL @ ${s.pumpUlS} µL/s` : s.mode === 'bead' ? `${s.lines > 1 ? s.lines + ' × ' : ''}${s.beadUlS} µL/s` : `${s.count} × ${s.dropUl} µL`;
    case 'vacuum': return `${s.pressureKpa} kPa`;
    case 'fill': return `dwell ${s.dwellS} s · out ${s.withdrawUlS} µL/s`;
    case 'airflow': return [s.airFlowScfh > 0 ? `${s.airFlowScfh} SCFH${s.airTempC > 30 ? ' @ ' + s.airTempC + ' °C' : ''}` : s.nozzleSpeed > 0 ? `${s.nozzleSpeed} m/s${s.airTempC > 30 ? ' @ ' + s.airTempC + ' °C' : ''}` : '', s.crossJetSpeed > 0 && s.crossJetEnd !== 'none' ? `blow-off ${s.crossJetSpeed} m/s` : '', `${s.duration} s`].filter(Boolean).join(' · ');
    case 'dwell': return `${s.duration} s`;
    case 'cure': return s.mode === 'uv' ? `UV ${s.uvIntensity} mW/cm² · ${s.duration} s` : `${s.tempC} °C · ${fmt(s.duration / 60)} min`;
    default: return '';
  }
}
function updateStageSummaries() { document.querySelectorAll('.stage').forEach((n, i) => { const st = state.spec.stages[i]; if (st) n.querySelector('.sum').textContent = stageSummary(st); }); }

function fieldVisible(st, d) {
  const vals = { ...STAGE_DEFAULTS[st.type], ...st };
  if (d.mode && vals.mode !== d.mode) return false;
  if (d.modes && !d.modes.includes(vals.mode)) return false;
  if (d.cure && vals.mode !== d.cure) return false;
  return true;
}
const isMain = (d) => !!d.sl || (d.kind === 'select' && d.key === 'mode');

function renderStages() {
  const box = $('#stageList'); box.innerHTML = '';
  const stages = state.spec.stages;
  if (!stages.length) box.append(el('div', { class: 'hint' }, 'Add a stage that applies coating (dip, spray, drip or vacuum).'));
  stages.forEach((st, i) => {
    const sch = STAGE_SCHEMAS[st.type];
    const card = el('div', { class: 'stage' + (state.openStage === i ? ' open' : '') });
    card.style.setProperty('--stc', SERIES[(sch.color - 1) % SERIES.length]);
    const head = el('div', { class: 'stage-head' });
    head.innerHTML = `<span class="num">${i + 1}</span><span class="ttl">${esc(st.label || sch.name)}</span><span class="sum">${esc(stageSummary(st))}</span>`;
    const mk = (t, title, fn) => { const b = el('button', { class: 'ibtn', type: 'button', title }, t); b.addEventListener('click', (e) => { e.stopPropagation(); fn(); }); return b; };
    const tools = el('span', { class: 'tools' });
    tools.append(mk('↑', 'Move up', () => { if (i > 0) { [stages[i - 1], stages[i]] = [stages[i], stages[i - 1]]; state.openStage = i - 1; renderStages(); changed(); } }));
    tools.append(mk('↓', 'Move down', () => { if (i < stages.length - 1) { [stages[i + 1], stages[i]] = [stages[i], stages[i + 1]]; state.openStage = i + 1; renderStages(); changed(); } }));
    tools.append(mk('✕', 'Remove stage', () => { stages.splice(i, 1); state.openStage = -1; renderStages(); changed(); }));
    head.append(tools);
    head.addEventListener('click', () => { state.openStage = state.openStage === i ? -1 : i; renderStages(); });
    card.append(head);
    if (state.openStage === i) {
      const body = el('div', { class: 'stage-body' });
      body.append(el('div', { class: 'hint' }, esc(sch.help)));
      const vals = { ...STAGE_DEFAULTS[st.type], ...st };
      const set = (d) => (v, dragging) => { st[d.key] = v; if (d.key === 'mode') renderStages(); changed(dragging); };
      for (const d of sch.fields) {
        if (!fieldVisible(st, d) || !isMain(d)) continue;
        body.append(d.kind === 'select' ? numberRow(d, vals[d.key], set(d)) : sliderRow(d, vals[d.key], set(d)));
      }
      const more = el('details', { class: 'adv' }); more.append(el('summary', {}, 'More settings'));
      const lr = el('div', { class: 'row' }); lr.append(el('label', {}, 'Label'));
      const li = el('input', { type: 'text' }); li.value = st.label || ''; li.placeholder = sch.name;
      li.addEventListener('change', () => { st.label = li.value; renderStages(); changed(); });
      const lw = el('div', { class: 'inp' }); lw.append(li); lr.append(lw); more.append(lr);
      for (const d of sch.fields) if (fieldVisible(st, d) && !isMain(d)) more.append(numberRow(d, vals[d.key], set(d)));
      body.append(more);
      card.append(body);
    }
    box.append(card);
  });
}

// ---------------------------------------------------------------- Advanced
function renderAdvanced() {
  const box = $('#advForm'); box.innerHTML = '';
  const sp = state.spec;
  sp.metrics = sp.metrics || {};
  const s = resolveSubstrate(sp);
  sp.substrateOverrides = sp.substrateOverrides || {};
  for (const d of SUBSTRATE_OVERRIDES) box.append(sliderRow({ ...d, sl: [0, 70, 'lin'] }, sp.substrateOverrides[d.key] ?? s[d.key], (v, dr) => { sp.substrateOverrides[d.key] = v; changed(dr); }));
  box.append(sliderRow({ label: 'Surface roughness ratio', unit: '', min: 1, max: 3, step: 0.01, sl: [1, 2, 'lin'], help: 'True/projected area (Wenzel). Amplifies wetting or non-wetting.' }, sp.roughness || 1, (v, dr) => { sp.roughness = v; changed(dr); }));
  box.append(sliderRow({ label: 'Part heat-up time constant', unit: 's', min: 1, max: 1000, step: 1, sl: [2, 300, 'log'], help: 'How quickly the part follows the oven or air temperature (thin plastic ≈ 20–40 s).' }, sp.heatUpSeconds || 30, (v, dr) => { sp.heatUpSeconds = v; changed(dr); }));
  const L = partLength();
  const zone = sp.metrics.zone || [0, L];
  const z = el('div', { class: 'row' }); z.append(el('label', { title: 'Region used for statistics and findings.' }, 'Evaluation zone'));
  const zi = el('div', { class: 'inp' });
  const a = el('input', { type: 'number', step: 0.5 }), b = el('input', { type: 'number', step: 0.5 });
  a.value = zone[0]; b.value = Math.min(zone[1], L);
  const upd = () => { sp.metrics.zone = [Math.max(0, Number(a.value)), Math.min(L, Number(b.value))]; changed(); };
  a.addEventListener('change', upd); b.addEventListener('change', upd);
  zi.append(a, el('span', { class: 'unit' }, '–'), b, el('span', { class: 'unit' }, 'mm'));
  z.append(zi); box.append(z);
  box.append(numberRow({ key: 'minDryUm', label: 'Coverage threshold (dry)', unit: 'µm', min: 0, max: 1000, step: 0.01, optional: true, help: 'Areas thinner than this count as uncovered. Blank = 25% of the median.' }, sp.metrics.minDryUm ?? null, (v) => { sp.metrics.minDryUm = v ?? undefined; changed(); }));
  const res = el('div', { class: 'row sel' }); res.append(el('label', { title: 'Grid cells along × around the part.' }, 'Resolution'));
  const g = sp.grid || { ns: 120, nphi: 32 };
  const cur = g.ns <= 80 ? 'coarse' : g.ns >= 180 ? 'fine' : 'normal';
  const flat = sp.geometry.type === 'coupon';
  res.append(segmented([['coarse', 'Fast'], ['normal', 'Normal'], ['fine', 'Fine']], cur, (v) => {
    sp.grid = { coarse: { ns: 70, nphi: flat ? 6 : 20 }, normal: { ns: 120, nphi: flat ? 8 : 32 }, fine: { ns: 200, nphi: flat ? 12 : 48 } }[v];
    renderAdvanced(); changed(); previewGeometry();
  }));
  box.append(res);
}

function renderAll() { renderGeometry(); renderMaterials(); renderStages(); renderAdvanced(); $('#preset').value = state.spec.presetId || ''; }

// ---------------------------------------------------------------- geometry preview
const specKey = (s) => JSON.stringify(s.geometry) + s.surface + JSON.stringify(s.grid);
function previewGeometry(force) {
  if (!force && state.result && state.resultSpecKey === specKey(state.spec)) return;
  try {
    const geo = buildGeometry(state.spec);
    const sg = { Ni: geo.Ni, Nj: geo.Nj, N: geo.N, L: geo.L, ds: geo.ds, surface: geo.surface, flat: geo.flat, periodic: geo.periodic, s: Array.from(geo.s), phi: Array.from(geo.phi), A: Array.from(geo.A), B: Array.from(geo.B), area: geo.area, pos: Float32Array.from(geo.pos), nrm: Float32Array.from(geo.nrm), voidMask: geo.voidMask };
    view3d.setGeometry(sg);
    const st0 = state.spec.stages[0];
    view3d.tilt = st0 ? st0.tilt ?? STAGE_DEFAULTS[st0.type].tilt ?? 90 : 90;
    view3d.setEffects([]);
    view3d.setField(new Float32Array(geo.N), [0, 1], state.cmap, null, [], new Uint8Array(geo.N).fill(1));
    $('#empty3d').style.display = state.result ? 'none' : 'flex';
    $('#ovl3d').innerHTML = `<div class="ov-stage">Ready</div><div>${geo.surface === 'inner' ? 'Inside of the bore (cut open to show it)' : 'Outer surface'} · ${fmt(geo.L * 1e3)} mm long</div>`;
    $('#v3d').className = 'view' + (state.tab === 'v3d' ? ' active' : '');
    if (state.result) { state.result = null; renderResultsPanel(); updateTimeline(); }
  } catch (e) { toast('Geometry error: ' + e.message, true); }
}

// ---------------------------------------------------------------- worker / running
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
  if (!spec.stages.some((s) => ['dip', 'spray', 'drip', 'fill', 'vacuum'].includes(s.type))) errs.push('No stage applies coating: add a dip, spray, drip, fill or vacuum stage.');
  return errs;
}

let liveTimer = null;
function scheduleLive() {
  if (!state.live) return;
  clearTimeout(liveTimer);
  liveTimer = setTimeout(() => { if (state.running) { stopWorker(); setRunning(false); } run({ live: true }); }, 700);
}

function run(opts = {}) {
  if (state.running) return;
  const errs = validate(state.spec);
  if (errs.length) { if (!opts.live) toast(errs[0], true); return; }
  const id = ++jobId;
  setPlaying(false);
  setRunning(true);
  const w = getWorker();
  const spec = JSON.parse(JSON.stringify(state.spec));
  if (opts.live) spec.grid = { ns: 64, nphi: spec.geometry.type === 'coupon' ? 6 : 20 };
  w.onmessage = (e) => {
    const d = e.data; if (d.id !== id) return;
    if (d.type === 'progress') { $('#progress .bar i').style.width = (d.f * 100).toFixed(1) + '%'; $('#progress .msg').textContent = d.msg; }
    else if (d.type === 'result') { setRunning(false); onResult(d.result, spec, opts); }
    else if (d.type === 'error') { setRunning(false); toast('Simulation failed: ' + d.message, true); }
  };
  w.onerror = (e) => { setRunning(false); toast('Worker error: ' + e.message, true); stopWorker(); };
  w.postMessage({ cmd: 'run', id, spec });
}

function onResult(res, spec, opts) {
  state.result = res;
  state.resultSpecKey = specKey(spec);
  prepareResult(res);
  view3d.setGeometry(res.geometry);
  $('#empty3d').style.display = 'none';
  renderResultsPanel(); updateTimeline(); updateHistory();
  if (opts.live) { state.p = res.frames.length - 1; updateViews(); return; }
  state.p = 0; updateViews();
  setPlaying(true);
  const m = res.metrics;
  toast(`Done in ${res.stats.wallSeconds.toFixed(1)} s — dry film ${fmt(m.dry.mean)} µm, coverage ${(m.coverage * 100).toFixed(0)}%. Playing the process…`);
}

// ---------------------------------------------------------------- frames, interpolation & fields
function prepareResult(res) {
  res._coat = resolveCoating(res.spec);
  res._hp = (res.spec.precursorUm || 0.05) * 1e-6;
  const n = res.frames[0].h.length;
  res._buf = { h: new Float32Array(n), m: new Float32Array(n), alpha: new Float32Array(n), T: new Float32Array(n) };
  const vals = [];
  for (const fr of res.frames) for (let k = 0; k < n; k += 3) { const w = fr.h[k] - res._hp; if (w > 4 * res._hp) vals.push(w); }
  vals.sort((a, b) => a - b);
  res._wetRef = vals.length ? vals[Math.floor(vals.length / 2)] : 10e-6;
  res._stageColor = (si) => (si >= 0 ? SERIES[(STAGE_SCHEMAS[res.spec.stages[si].type].color - 1) % SERIES.length] : '#888');
}

function frameAt(p) {
  const res = state.result, F = res.frames;
  const i0 = clamp(Math.floor(p), 0, F.length - 1), i1 = Math.min(F.length - 1, i0 + 1), f = clamp(p - i0, 0, 1);
  const a = F[i0], b = F[i1], B = res._buf;
  for (const key of ['h', 'm', 'alpha', 'T']) { const A0 = a[key], A1 = b[key], O = B[key]; for (let k = 0; k < O.length; k++) O[k] = A0[k] + (A1[k] - A0[k]) * f; }
  const near = f < 0.5 ? a : b;
  return { h: B.h, m: B.m, alpha: B.alpha, T: B.T, mask: near.mask, t: a.t + (b.t - a.t) * f, label: near.label, stage: near.stage, aux: near.aux };
}

function fieldValues(fr, key) {
  const res = state.result, n = fr.h.length, out = new Float32Array(n);
  const hp = res._hp, sh = res._coat.shrink || 0;
  for (let k = 0; k < n; k++) {
    const film = fr.h[k] > 4 * hp;
    switch (key) {
      case 'wet': out[k] = Math.max(0, fr.h[k] - hp) * 1e6; break;
      case 'dry': case 'state': out[k] = film ? fr.m[k] * (1 - sh * fr.alpha[k]) * 1e6 : 0; break;
      case 'phi': out[k] = film ? fr.m[k] / fr.h[k] : 0; break;
      case 'alpha': out[k] = film ? fr.alpha[k] : 0; break;
      case 'temp': out[k] = fr.T ? fr.T[k] - 273.15 : 25; break;
      case 'theta': out[k] = (res.theta[k] * 180) / Math.PI; break;
      default: out[k] = 0;
    }
  }
  return out;
}

// Animation colours: glossy liquid (light → deep blue with thickness) → matte dry film (sand) → cured (amber)
const C_THIN = [0.62, 0.86, 1.0], C_THICK = [0.10, 0.36, 0.86], C_DRY = [0.90, 0.80, 0.58], C_CURED = [0.82, 0.50, 0.20];
function stateColors(fr) {
  const res = state.result, c = res._coat, n = fr.h.length, hp = res._hp;
  const rgb = new Float32Array(3 * n), gloss = new Float32Array(n);
  const canDry = c.solids < c.phiMax, curing = c.cure.model !== 'none';
  for (let k = 0; k < n; k++) {
    if (fr.mask && fr.mask[k] === 1) { rgb[3 * k] = 0.08; rgb[3 * k + 1] = 0.30; rgb[3 * k + 2] = 0.80; gloss[k] = 1; continue; } // flooded / bath / plug
    const w = fr.h[k] - hp;
    if (w <= 3 * hp) continue;
    const t = clamp(0.5 + 0.45 * Math.log10(w / res._wetRef), 0, 1);
    let r = C_THIN[0] + (C_THICK[0] - C_THIN[0]) * t, g = C_THIN[1] + (C_THICK[1] - C_THIN[1]) * t, b = C_THIN[2] + (C_THICK[2] - C_THIN[2]) * t;
    const phi = fr.m[k] / fr.h[k];
    const dd = canDry ? Math.pow(clamp((phi - c.solids) / (c.phiMax - c.solids), 0, 1), 0.6) : 0;
    r += (C_DRY[0] - r) * dd; g += (C_DRY[1] - g) * dd; b += (C_DRY[2] - b) * dd;
    const a = curing ? clamp(fr.alpha[k], 0, 1) : 0;
    r += (C_CURED[0] - r) * a; g += (C_CURED[1] - g) * a; b += (C_CURED[2] - b) * a;
    rgb[3 * k] = r; rgb[3 * k + 1] = g; rgb[3 * k + 2] = b;
    gloss[k] = (1 - dd) * (1 - a);
  }
  return { rgb, gloss };
}

function rangeOf(vals, key) {
  if (key === 'phi' || key === 'alpha') return [0, 1];
  let lo = Infinity, hi = -Infinity;
  for (const v of vals) { if (v < lo) lo = v; if (v > hi) hi = v; }
  if (key === 'dry' || key === 'wet') {
    lo = 0;
    const s = Float32Array.from(vals).sort();
    const p = s[Math.min(s.length - 1, Math.floor(s.length * 0.995))];
    if (p > 0 && p < hi) hi = p;
  }
  if (key === 'temp') { lo = Math.min(lo, 20); hi = Math.max(hi, lo + 5); }
  return niceRange(lo, hi);
}

const MARKER_STYLE = { bath: ['Bath level', [0.3, 0.75, 1.0]], nozzle: ['Applicator', [0.95, 0.45, 0.25]], meniscus: ['Meniscus', [0.2, 0.85, 0.6]], front: ['Liquid front', [0.6, 0.55, 0.95]] };
function markersOf(fr) {
  const out = [];
  for (const [k, [label, rgb]] of Object.entries(MARKER_STYLE)) {
    const s = fr.aux?.[k];
    if (s !== undefined && s !== null && isFinite(s)) out.push({ s, label, rgb, color: `rgb(${rgb.map((c) => Math.round(c * 255)).join(',')})` });
  }
  return out;
}

function stageOf(fr) { return fr.stage >= 0 ? { ...STAGE_DEFAULTS[state.result.spec.stages[fr.stage].type], ...state.result.spec.stages[fr.stage] } : null; }

// What is happening, in plain words, plus the visual effects for the 3D view
function activityOf(fr, st) {
  const fx = [], bits = [];
  let bg = '';
  if (!st) return { fx, text: 'Before coating', bg };
  const inner = state.result.geometry.surface === 'inner';
  const ended = / \(end\)$/.test(fr.label);
  switch (st.type) {
    case 'plasma': bg = 'fx-plasma'; bits.push(`Plasma treating ${inner ? 'the bore' : 'the surface'}`); break;
    case 'dip': if (fr.aux.bath !== undefined && !ended) { fx.push({ kind: 'bath', s: fr.aux.bath }); bits.push(`Withdrawing from the bath at ${st.speed} mm/s`); } else bits.push('Draining after dipping'); break;
    case 'spray': if (fr.aux.nozzle !== null && fr.aux.nozzle !== undefined) { fx.push({ kind: 'spray', s: fr.aux.nozzle }); bits.push(`Spraying ${st.flowMlMin} mL/min`); } else bits.push('Spray settling'); break;
    case 'drip': if (fr.aux.nozzle !== undefined && !ended) { fx.push({ kind: 'needle', s: fr.aux.nozzle, fromEnd: st.mode === 'pump' ? 'start' : st.endMm > st.startMm ? 'end' : 'start' }); bits.push(st.mode === 'pump' ? `Pumping coating in at ${st.pumpUlS} µL/s` : st.mode === 'bead' ? `Needle laying ${st.lines > 1 ? st.lines + ' beads' : 'a bead'} (${st.beadUlS} µL/s)` : 'Dispensing drops'); } else bits.push('Coating spreading and draining'); break;
    case 'fill': {
      const F = fr.aux || {};
      const tl = fr.t - (state.result.stageInfo[fr.stage]?.tStart ?? 0);
      if (ended || F.filling === undefined) { bits.push('Cartridge emptied — film left on the bore'); break; }
      if (F.nozzle !== undefined) fx.push({ kind: 'needle', s: F.nozzle, fromEnd: st.fillFrom === 'end' ? 'end' : 'start' });
      if (tl < (st.primeS || 0)) bits.push('Priming: coating pumped in and pulled through the tip by the withdraw pump');
      else if (F.nozzle !== undefined) bits.push('Withdraw pump stopped — cartridge filling');
      else if (!F.speed) bits.push(`Dwell: cartridge full, held by back-pressure (${st.dwellS} s)`);
      else bits.push(`Withdrawing at ${st.withdrawUlS} µL/s — meniscus ${fmt(F.speed * 1e3)} mm/s`);
      break;
    }
    case 'vacuum': if (fr.aux.air) { fx.push({ kind: 'air', speed: fr.aux.air, dir: st.direction === 'back' ? -1 : 1, hot: false }); bits.push(`Vacuum drawing air through (${fmt(fr.aux.air)} m/s)`); } else bits.push(`Vacuum pulling the liquid out${fr.aux.speed ? ` at ${fmt(fr.aux.speed * 1e3)} mm/s` : ''}`); break;
    case 'airflow':
      if (st.nozzleSpeed > 0 || st.airFlowScfh > 0) { const hot = st.airTempC > 40; fx.push({ kind: 'air', speed: st.airFlowScfh > 0 ? st.airFlowScfh / 4 : st.nozzleSpeed, dir: st.fromEnd === 'end' ? -1 : 1, hot }); bits.push(`${hot ? `Heated air ${st.airTempC} °C` : 'Air'} ${st.airFlowScfh > 0 ? st.airFlowScfh + ' SCFH' : st.nozzleSpeed + ' m/s'} ${inner ? 'down the bore' : 'over the part'}`); if (hot) bg = 'fx-warm'; }
      if (st.crossJetSpeed > 0 && st.crossJetEnd !== 'none') { fx.push({ kind: 'cross', end: st.crossJetEnd }); bits.push(`horizontal jets clearing the ${st.crossJetEnd === 'end' ? 'tip bevel' : 'top opening'}`); }
      if (fr.aux && fr.aux.meniscus !== undefined && fr.aux.front !== undefined) bits.push('liquid plug in the bore');
      break;
    case 'dwell': bits.push(`Resting at ${st.tempC} °C — levelling, draining and drying`); break;
    case 'cure': if (st.mode === 'uv') { bg = 'fx-uv'; bits.push(`UV exposure ${st.uvIntensity} mW/cm²`); } else { bg = 'fx-oven'; bits.push(`Oven at ${st.tempC} °C`); } break;
    default: break;
  }
  return { fx: ended ? [] : fx, text: bits.join(' · '), bg: ended ? '' : bg };
}

function fmtTime(t) { if (t < 120) return t.toFixed(t < 10 ? 1 : 0) + ' s'; const m = Math.floor(t / 60), s = Math.round(t % 60); return `${m}:${String(s).padStart(2, '0')} min`; }

function updateViews() {
  const res = state.result; if (!res) return;
  const fieldDef = FIELDS.find((f) => f.key === state.field);
  const fr = frameAt(state.p);
  const st = stageOf(fr);
  const vals = fieldValues(fr, state.field);
  const range = rangeOf(vals, state.field === 'state' ? 'dry' : state.field);
  const marks = markersOf(fr);
  const hp = res._hp;
  if (state.field === 'state') {
    $('#legend').innerHTML = `<span class="lg"><i style="background:linear-gradient(90deg,rgb(158,219,255),rgb(26,92,219))"></i>liquid (thin → thick)</span><span class="lg"><i style="background:rgb(230,204,148)"></i>dry</span>${res._coat.cure.model !== 'none' ? '<span class="lg"><i style="background:rgb(209,128,51)"></i>cured</span>' : ''}<span class="lg"><i style="background:#80858f"></i>bare</span>`;
  } else {
    $('#legend').innerHTML = `<span class="lg-num">${state.field !== 'temp' && state.field !== 'theta' ? 'bare · ' : ''}${fmt(range[0])}</span><i class="lg-grad" style="background:${gradientCSS(state.cmap)}"></i><span class="lg-num">${fmt(range[1])} ${fieldDef.unit}</span>`;
  }
  const film = new Float32Array(fr.h.length);
  let hmax = 0; for (let k = 0; k < film.length; k++) { film[k] = Math.max(0, fr.h[k] - hp); if (!(fr.mask && fr.mask[k] === 1)) hmax = Math.max(hmax, film[k]); }
  const ex = Number($('#exag').value);
  const rref = Math.max(...res.geometry.A) || res.geometry.L * 0.05;
  view3d.exag = ex > 0 ? (ex / 100) * (0.35 * rref) / Math.max(hmax, 4 * res._wetRef) : 0;
  view3d.cutaway = $('#cutaway').checked;
  view3d.tilt = st ? st.tilt ?? 90 : (res.spec.stages[0]?.tilt ?? STAGE_DEFAULTS[res.spec.stages[0]?.type]?.tilt ?? 90);
  let bare = null;
  if (state.field !== 'theta' && state.field !== 'temp') { bare = new Uint8Array(film.length); for (let k = 0; k < film.length; k++) bare[k] = fr.h[k] <= 4 * hp && !(fr.mask && fr.mask[k] === 1) ? 1 : 0; }
  const act = activityOf(fr, st);
  if (state.field === 'state') { const sc = stateColors(fr); view3d.setField(vals, range, state.cmap, film, marks, bare, sc.rgb, sc.gloss); }
  else view3d.setField(vals, range, state.cmap, film, marks, bare);
  view3d.setEffects(state.tab === 'v3d' ? act.fx : []);
  $('#v3d').className = 'view' + (state.tab === 'v3d' ? ' active' : '') + (act.bg ? ' ' + act.bg : '');
  let Tm = 0; for (const v of fr.T) Tm += v; Tm = Tm / fr.T.length - 273.15;
  $('#ovl3d').innerHTML = `<div class="ov-stage" style="border-color:${st ? res._stageColor(fr.stage) : '#888'}">${esc(fr.label.replace(/ \(end\)$/, ''))}</div>`
    + `<div>${esc(act.text)}</div><div class="muted">t = ${fmtTime(fr.t)} · part ${Tm.toFixed(0)} °C</div>`
    + (view3d.radial > 1.01 ? `<div class="muted">Radius drawn ×${fmt(view3d.radial)} for visibility</div>` : '');
  heatmap.set(res.geometry, vals, range, state.cmap, state.field === 'state' ? 'µm dry' : fieldDef.unit, marks);
  $('#tlInfo').textContent = `${fmtTime(fr.t)} / ${fmtTime(res.frames[res.frames.length - 1].t)}`;
  $('#frame').value = Math.round(state.p * 100);
  if (state.tab === 'charts') updateProfiles(vals, fieldDef, marks);
  for (const c of [chThick, chCure, chTemp, chVisc]) { c.cursorX = fr.t; if (state.tab === 'charts') c.draw(); }
}

function updateProfiles(vals, fieldDef, marks) {
  const res = state.result;
  const { Ni, Nj } = res.geometry;
  const label = state.field === 'state' ? 'Dry film thickness' : fieldDef.label, unit = state.field === 'state' ? 'µm' : fieldDef.unit;
  const sx = res.geometry.s.map((v) => v * 1e3);
  const mean = [], lo = [], hi = [];
  for (let i = 0; i < Ni; i++) {
    let a = 0, w = 0, mn = Infinity, mx = -Infinity;
    for (let j = 0; j < Nj; j++) { const k = i * Nj + j, ar = res.geometry.area[k]; a += vals[k] * ar; w += ar; mn = Math.min(mn, vals[k]); mx = Math.max(mx, vals[k]); }
    mean.push(a / w); lo.push(mn); hi.push(mx);
  }
  chAxial.set({ title: `${label} along the part (band = min–max around)`, xlabel: 's (mm)', ylabel: unit, series: [{ name: 'Mean around the part', x: sx, y: mean, color: SERIES[0], band: { lo, hi } }], markers: marks.map((m) => ({ x: m.s * 1e3, label: m.label })) });
  const cm = new Array(Nj).fill(0), cw = new Array(Nj).fill(0);
  for (let i = 0; i < Ni; i++) for (let j = 0; j < Nj; j++) { const k = i * Nj + j, ar = res.geometry.area[k]; cm[j] += vals[k] * ar; cw[j] += ar; }
  if (!res.geometry.flat) chCirc.set({ title: `${label} around the circumference`, xlabel: 'angle φ (°)', ylabel: unit, series: [{ name: 'Mean along the part', x: res.geometry.phi.map((p) => (p * 180) / Math.PI), y: cm.map((c, j) => c / cw[j]), color: SERIES[1] }] });
  else { const W = res.spec.geometry.width; chCirc.set({ title: `${label} across the width`, xlabel: 'x (mm)', ylabel: unit, series: [{ name: 'Mean', x: cm.map((_, j) => -W / 2 + ((j + 0.5) * W) / Nj), y: cm.map((c, j) => c / cw[j]), color: SERIES[1] }] }); }
}

function updateHistory() {
  const res = state.result; if (!res) return;
  const H = res.history, t = H.map((h) => h.t);
  const markers = res.stageInfo.map((s) => ({ x: s.tStart, label: s.label }));
  chThick.set({ title: 'Average film thickness', xlabel: 't (s)', ylabel: 'µm', markers, series: [
    { name: 'Wet', x: t, y: H.map((h) => h.wet * 1e6), color: SERIES[0] },
    { name: 'Dry', x: t, y: H.map((h) => h.dry * 1e6), color: SERIES[1] }] });
  chCure.set({ title: 'Degree of cure', xlabel: 't (s)', ylabel: 'α', markers, series: [{ name: 'Cure', x: t, y: H.map((h) => h.alpha), color: SERIES[2] }] });
  chTemp.set({ title: 'Part temperature (average)', xlabel: 't (s)', ylabel: '°C', markers, series: [{ name: 'Part', x: t, y: H.map((h) => h.Tpart ?? h.T), color: SERIES[3] }] });
  chVisc.set({ title: 'Peak viscosity — film setting (log)', xlabel: 't (s)', ylabel: 'Pa·s', logY: true, markers, series: [{ name: 'Viscosity', x: t, y: H.map((h) => h.muMax), color: SERIES[6] }] });
}

// ---------------------------------------------------------------- timeline & playback
function updateTimeline() {
  const res = state.result;
  const f = $('#frame');
  f.max = res ? (res.frames.length - 1) * 100 : 0; f.value = Math.round(state.p * 100); f.disabled = !res;
  $('#play').disabled = !res; $('#rec').disabled = !res;
  const bar = $('#stagebar'); bar.innerHTML = '';
  if (!res) { $('#tlInfo').textContent = 'No results yet'; return; }
  const n = res.frames.length - 1;
  let start = 0;
  res.spec.stages.forEach((st, si) => {
    let last = start;
    for (let i = start; i <= n; i++) if (res.frames[i].stage === si) last = i;
    const seg = el('div', { class: 'seg-st', title: `${st.label || STAGE_SCHEMAS[st.type].name} — click to jump` });
    seg.style.width = (((last - start) / n) * 100) + '%'; seg.style.background = res._stageColor(si);
    seg.textContent = st.label || STAGE_SCHEMAS[st.type].name;
    const s0 = start;
    seg.addEventListener('click', () => { setPlaying(false); state.p = s0; updateViews(); });
    bar.append(seg);
    start = last;
  });
}

let raf = null, lastTick = 0;
function setPlaying(on) {
  if (!state.result) { state.playing = false; return; }
  state.playing = on;
  $('#play').innerHTML = on ? '❚❚' : '▶';
  if (on && state.p >= state.result.frames.length - 1.001) state.p = 0;
  cancelAnimationFrame(raf);
  if (!on) return;
  lastTick = performance.now();
  const tick = (now) => {
    if (!state.playing || !state.result) return;
    const dt = Math.min(0.1, (now - lastTick) / 1000); lastTick = now;
    state.p += dt * 8 * state.speed;
    if (state.p >= state.result.frames.length - 1) { state.p = state.result.frames.length - 1; updateViews(); setPlaying(false); if (recorder) stopRecording(); return; }
    updateViews();
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
}

let recorder = null, chunks = [];
function startRecording() {
  if (!state.result) return;
  const cv = view3d.canvas;
  if (!cv.captureStream || typeof MediaRecorder === 'undefined') { toast('Video recording is not supported in this browser', true); return; }
  document.querySelector('#tabs button[data-tab=v3d]').click();
  const type = ['video/webm;codecs=vp9', 'video/webm'].find((t) => MediaRecorder.isTypeSupported(t)) || '';
  recorder = new MediaRecorder(cv.captureStream(30), type ? { mimeType: type, videoBitsPerSecond: 6e6 } : {});
  chunks = [];
  recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  recorder.onstop = () => { const a = el('a'); a.href = URL.createObjectURL(new Blob(chunks, { type: 'video/webm' })); a.download = 'coatsim-process.webm'; a.click(); recorder = null; $('#rec').classList.remove('on'); toast('Animation saved (coatsim-process.webm)'); };
  recorder.start();
  $('#rec').classList.add('on');
  state.p = 0; setPlaying(true);
}
function stopRecording() { if (recorder && recorder.state !== 'inactive') recorder.stop(); }

// ---------------------------------------------------------------- results panel
function renderResultsPanel() {
  const box = $('#results');
  const res = state.result;
  if (!res) { box.innerHTML = '<div class="empty small">Press <b>Run</b> to simulate the process.<br>Results and findings appear here.</div>'; return; }
  const m = res.metrics;
  const sevOrder = { high: 0, medium: 1, info: 2 };
  const defects = m.defects.slice().sort((a, b) => sevOrder[a.severity] - sevOrder[b.severity]);
  const icon = { high: '⨯', medium: '!', info: 'i' };
  const sevLabel = { high: 'Critical', medium: 'Warning', info: 'Note' };
  const cureOn = res._coat.cure.model !== 'none';
  const card = (k, v, u, s) => `<div class="metric"><div class="k">${k}</div><div class="v">${v}<small>${u}</small></div><div class="s">${s}</div></div>`;
  const def = (d) => `<div class="defect"><div class="t"><span class="badge ${d.severity}">${icon[d.severity]} ${sevLabel[d.severity]}</span>${esc(d.title)}</div><div class="d">${esc(d.detail)}</div>${d.fix ? `<div class="f">→ ${esc(d.fix)}</div>` : ''}</div>`;
  box.innerHTML = `
    <div class="metric-grid">
      ${card('Dry film (mean)', fmt(m.dry.mean), 'µm', `range ${fmt(m.dry.p5)}–${fmt(m.dry.p95)} µm`)}
      ${card('Coverage', (m.coverage * 100).toFixed(m.coverage > 0.995 ? 0 : 1), '%', 'of the evaluated surface')}
      ${card('Uniformity', (m.dry.cov * 100).toFixed(0), '% CoV', m.dry.cov < 0.15 ? 'even' : m.dry.cov < 0.35 ? 'moderate' : 'uneven')}
      ${cureOn ? card('Cured', (m.cureMean * 100).toFixed(0), '%', m.cureMean > 0.9 ? 'fully cured' : 'under-cured') : card('Wet film (mean)', fmt(m.wet.mean), 'µm', 'non-curing coating')}
    </div>
    <h4>Findings</h4>
    ${defects.length ? defects.slice(0, 4).map(def).join('') : '<div class="defect"><div class="t"><span class="badge ok">✓ OK</span>No problems found</div><div class="d">The film is continuous and reasonably even.</div></div>'}
    ${defects.length > 4 ? `<details class="adv"><summary>${defects.length - 4} more finding${defects.length > 5 ? 's' : ''}</summary>${defects.slice(4).map(def).join('')}</details>` : ''}
    <details class="adv"><summary>Details: physics checks, mass balance, stages</summary>
      ${m.predictions.length ? `<h4>Analytic checks</h4>${m.predictions.map((p) => `<div class="hint">• <b>${esc(p.stage)}:</b> ${esc(p.text)}</div>`).join('')}` : ''}
      <h4>Physical groups</h4>
      <table class="kv">
        <tr><td>Contact angle (mean, range)</td><td>${m.groups.contactAngleMean_deg.toFixed(0)}° (${m.groups.contactAngleMin_deg.toFixed(0)}–${m.groups.contactAngleMax_deg.toFixed(0)}°)</td></tr>
        <tr><td>Surface tension / viscosity</td><td>${fmt(m.groups.surfaceTension_mNm)} mN/m · ${fmt(m.groups.viscosity_mPas)} mPa·s</td></tr>
        <tr><td>Capillary length</td><td>${fmt(m.groups.capillaryLength_mm)} mm</td></tr>
        ${m.groups.bond !== null ? `<tr><td>Bond number ρgR²/γ</td><td>${fmt(m.groups.bond)}</td></tr>` : ''}
        ${m.groups.jurinHeight_mm !== undefined ? `<tr><td>Capillary rise in the bore</td><td>${fmt(m.groups.jurinHeight_mm)} mm</td></tr>` : ''}
      </table>
      <h4>Mass balance</h4>
      <table class="kv">
        <tr><td>Dispensed / sprayed</td><td>${fmt(m.massBalance.deposited_uL)} µL</td></tr>
        <tr><td>Solvent evaporated</td><td>${fmt(m.massBalance.evaporated_uL)} µL</td></tr>
        <tr><td>Dripped / blown off / withdrawn</td><td>${fmt(m.massBalance.dripped_uL)} µL</td></tr>
        <tr><td>Left on the part (solids)</td><td>${fmt(m.massBalance.film_uL)} (${fmt(m.massBalance.solids_uL)}) µL</td></tr>
      </table>
      <h4>Stages</h4>
      <table class="kv">${res.stageInfo.map((s) => `<tr><td>${esc(s.label)}</td><td>${fmtTime(s.tStart)} → ${fmtTime(s.tEnd)}</td></tr>`).join('')}</table>
      <div class="hint" style="margin-top:8px">Solved in ${res.stats.wallSeconds.toFixed(1)} s · ${res.stats.steps.toLocaleString()} steps · grid ${res.geometry.Ni}×${res.geometry.Nj}</div>
    </details>`;
}

// ---------------------------------------------------------------- sweep
function sweepParams() {
  const out = [];
  const sp = state.spec;
  sp.stages.forEach((st, i) => {
    for (const d of STAGE_SCHEMAS[st.type].fields) if (d.kind !== 'select' && !d.optional && fieldVisible(st, d)) out.push({ id: `stage:${i}:${d.key}`, label: `${st.label || STAGE_SCHEMAS[st.type].name} — ${d.label}`, unit: d.unit, get: (s) => ({ ...STAGE_DEFAULTS[s.stages[i].type], ...s.stages[i] })[d.key], set: (s, v) => { s.stages[i][d.key] = v; } });
  });
  for (const c of coatingSliders()) {
    out.push({ id: `coat:${c.id}`, label: `Coating — ${c.def.label}`, unit: c.def.unit, get: () => c.get(), set: (s, v) => { const saved = state.spec; state.spec = s; coatingSliders().find((x) => x.id === c.id).set(v); state.spec = saved; } });
  }
  for (const d of GEOMETRY_SCHEMAS[sp.geometry.type].fields) out.push({ id: `geo:${d.key}`, label: `Part — ${d.label}`, unit: d.unit, get: (s) => s.geometry[d.key], set: (s, v) => { s.geometry[d.key] = v; } });
  return out;
}

function renderSweepForm() {
  const box = $('#sweepForm'); box.innerHTML = '';
  const params = sweepParams();
  const ps = el('select'); for (const p of params) ps.append(el('option', { value: p.id }, esc(p.label + (p.unit ? ` (${p.unit})` : ''))));
  if (state.sweepParam && params.some((p) => p.id === state.sweepParam)) ps.value = state.sweepParam;
  const cur = () => params.find((p) => p.id === ps.value);
  const from = el('input', { type: 'number', step: 'any' }), to = el('input', { type: 'number', step: 'any' }), n = el('input', { type: 'number', min: 2, max: 16, step: 1 });
  const setDefaults = () => { const v = Number(cur()?.get(state.spec)) || 1; from.value = +(v * 0.5).toPrecision(3); to.value = +(v * 2).toPrecision(3); };
  setDefaults(); n.value = 6;
  ps.addEventListener('change', () => { state.sweepParam = ps.value; setDefaults(); });
  const lbl = (t, e) => { const l = el('label'); l.append(t, e); return l; };
  const go = el('button', { class: 'btn primary', type: 'button' }, 'Run sweep');
  const logc = el('input', { type: 'checkbox' }); const ll = el('label', { class: 'chk' }); ll.style.flexDirection = 'row'; ll.append(logc, ' log spacing');
  go.addEventListener('click', () => {
    const p = cur(); const a = Number(from.value), b = Number(to.value), k = clamp(Math.round(Number(n.value)), 2, 16);
    if (!(isFinite(a) && isFinite(b))) return toast('Enter a valid range', true);
    if (logc.checked && (a <= 0 || b <= 0)) return toast('Log spacing needs positive values', true);
    const values = Array.from({ length: k }, (_, i) => (logc.checked ? a * Math.pow(b / a, i / (k - 1)) : a + ((b - a) * i) / (k - 1)));
    runSweep(p, values);
  });
  box.append(lbl('Parameter', ps), lbl('From', from), lbl('To', to), lbl('Runs', n), ll, go);
  box.append(el('div', { class: 'hint', style: 'flex-basis:100%' }, 'Each run uses the whole process with one setting changed. Choose "Fast" resolution under Advanced for quick sweeps.'));
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
  $('#sweepTable').innerHTML = `<table class="data"><tr><th>${esc(xl)}</th><th>Mean dry (µm)</th><th>P5–P95 (µm)</th><th>CoV</th><th>Coverage</th><th>Cure</th><th>Findings</th></tr>${sw.items.map((i) => (!i ? '' : i.ok ? `<tr><td>${fmt(i.value)}</td><td>${fmt(i.dry.mean)}</td><td>${fmt(i.dry.p5)}–${fmt(i.dry.p95)}</td><td>${(i.dry.cov * 100).toFixed(0)}%</td><td>${(i.coverage * 100).toFixed(1)}%</td><td>${(i.cure * 100).toFixed(0)}%</td><td style="text-align:left">${esc(i.defects.filter((d) => d !== 'Process note').join(', ') || '—')}</td></tr>` : `<tr><td>${fmt(i.value)}</td><td colspan="6" style="text-align:left">Failed: ${esc(i.error)}</td></tr>`)).join('')}</table>`;
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
  if (act === 'results' && need()) { const m = { ...res.metrics }; delete m.dryField; download('coatsim-results.json', JSON.stringify({ version: VERSION, spec: res.spec, metrics: m, history: res.history, stages: res.stageInfo, warnings: res.warnings }, null, 2)); }
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
  if (act === 'video' && need()) startRecording();
  if (act === 'help') $('#help').showModal();
}

// ---------------------------------------------------------------- init
let view3d, heatmap, chAxial, chCirc, chThick, chCure, chTemp, chVisc, swA, swB, swC;

function setSpec(spec) {
  setPlaying(false);
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
  chThick = new LineChart($('#chThick')); chCure = new LineChart($('#chCure')); chTemp = new LineChart($('#chTemp')); chVisc = new LineChart($('#chVisc'));
  swA = new LineChart($('#swA')); swB = new LineChart($('#swB')); swC = new LineChart($('#swC'));
  const ps = $('#preset');
  ps.append(el('option', { value: '' }, '— custom setup —'));
  for (const p of PRESETS) ps.append(el('option', { value: p.id, title: p.description }, esc(p.name)));
  ps.addEventListener('change', () => { if (!ps.value) return; const s = getPreset(ps.value); s.presetId = ps.value; setSpec(s); toast(PRESETS.find((p) => p.id === ps.value).description); });
  for (const f of FIELDS) $('#field').append(el('option', { value: f.key }, esc(f.label)));
  for (const c of COLORMAPS) $('#cmap').append(el('option', { value: c }, { blue: 'Blue', viridis: 'Viridis', cure: 'Copper' }[c] || c));
  $('#field').addEventListener('change', (e) => { state.field = e.target.value; updateViews(); });
  $('#cmap').addEventListener('change', (e) => { state.cmap = e.target.value; updateViews(); });
  $('#exag').addEventListener('input', updateViews);
  $('#cutaway').addEventListener('change', () => { view3d.cutaway = $('#cutaway').checked; view3d.render(); });
  $('#radial').addEventListener('change', () => { view3d.radialMode = $('#radial').value; if (state.result) { view3d.setGeometry(state.result.geometry); updateViews(); } else previewGeometry(true); });
  $('#resetView').addEventListener('click', () => view3d.resetView());
  $('#viewOpts').addEventListener('click', (e) => { e.stopPropagation(); $('#viewPanel').hidden = !$('#viewPanel').hidden; });
  $('#viewPanel').addEventListener('click', (e) => e.stopPropagation());
  $('#frame').addEventListener('input', (e) => { setPlaying(false); state.p = Number(e.target.value) / 100; updateViews(); });
  $('#play').addEventListener('click', () => setPlaying(!state.playing));
  $('#speed').addEventListener('change', (e) => { state.speed = Number(e.target.value); });
  $('#rec').addEventListener('click', () => (recorder ? (setPlaying(false), stopRecording()) : startRecording()));
  $('#run').addEventListener('click', () => run());
  $('#live').addEventListener('change', (e) => { state.live = e.target.checked; if (state.live) { toast('Live mode: changes re-run automatically on a fast grid'); scheduleLive(); } });
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
    state.tab = b.dataset.tab;
    document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === state.tab));
    document.querySelectorAll('.v3only').forEach((x) => (x.style.display = state.tab === 'v3d' ? '' : 'none'));
    $('#viewbar').style.display = state.tab === 'sweep' ? 'none' : '';
    $('#timeline').style.display = state.tab === 'sweep' ? 'none' : '';
    if (state.tab === 'sweep') renderSweepForm();
    if (state.result) updateViews(); else view3d.setEffects([]);
    requestAnimationFrame(() => { view3d.render(); heatmap.draw(); [chAxial, chCirc, chThick, chCure, chTemp, chVisc, swA, swB, swC].forEach((c) => c.draw()); });
  });
  $('#menuBtn').addEventListener('click', (e) => { e.stopPropagation(); $('#menuList').hidden = !$('#menuList').hidden; });
  document.addEventListener('click', () => { $('#menuList').hidden = true; $('#viewPanel').hidden = true; });
  $('#menuList').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) menuAction(b.dataset.act); });
  $('#fileIn').addEventListener('change', async (e) => {
    const f = e.target.files[0]; if (!f) return;
    try { const s = JSON.parse(await f.text()); const sp = s.spec && s.metrics ? s.spec : s; if (!sp.geometry || !sp.stages) throw new Error('not a CoatSim setup'); setSpec(sp); toast('Setup loaded'); } catch (err) { toast('Could not load: ' + err.message, true); }
    e.target.value = '';
  });
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); run(); }
    if (e.key === ' ' && !['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON'].includes(document.activeElement.tagName)) { e.preventDefault(); setPlaying(!state.playing); }
  });
  const fromHash = specFromHash();
  let initial = fromHash || loadLocal();
  if (initial && initial.stages && initial.stages.some((s) => !STAGE_SCHEMAS[s.type])) initial = null;
  setSpec(initial || Object.assign(getPreset(PRESETS[0].id), { presetId: PRESETS[0].id }));
  if (fromHash) history.replaceState(null, '', location.pathname);
}

window.addEventListener('DOMContentLoaded', init);
