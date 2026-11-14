// Runs every preset headlessly and prints a summary (used for review/regression).
import { PRESETS, getPreset } from '../src/core/presets.js';
import { simulate } from '../src/core/processes.js';

const only = process.argv[2];
for (const p of PRESETS) {
  if (only && !p.id.includes(only)) continue;
  const spec = getPreset(p.id);
  const t0 = Date.now();
  try {
    const r = simulate(spec);
    const m = r.metrics;
    console.log(`\n== ${p.id}  (${((Date.now() - t0) / 1000).toFixed(1)} s wall, ${r.stats.steps} steps, ${r.stats.rejected} rej, ${r.frames.length} frames)`);
    console.log(`   dry mean ${m.dry.mean.toFixed(3)} µm  CoV ${(m.dry.cov * 100).toFixed(0)}%  min ${m.dry.min.toFixed(3)} max ${m.dry.max.toFixed(3)}  coverage ${(m.coverage * 100).toFixed(1)}%  cure ${(m.cureMean * 100).toFixed(0)}%  θ ${m.groups.contactAngleMean_deg.toFixed(0)}°`);
    console.log(`   wet mean ${m.wet.mean.toFixed(2)} µm; mass µL: ${Object.entries(m.massBalance).map(([k, v]) => k + '=' + v.toFixed(3)).join(' ')}`);
    for (const d of m.defects) console.log(`   [${d.severity}] ${d.title}: ${d.detail}`);
    for (const pr of m.predictions) console.log(`   ~ ${pr.text}`);
  } catch (e) {
    console.log(`\n== ${p.id} FAILED after ${((Date.now() - t0) / 1000).toFixed(1)} s: ${e.stack}`);
  }
}
