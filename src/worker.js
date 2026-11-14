// Web Worker entry: runs simulations off the UI thread.
import { simulate } from './core/processes.js';

self.onmessage = (e) => {
  const { cmd, id } = e.data;
  if (cmd === 'run') {
    let last = 0;
    try {
      const res = simulate(e.data.spec, {
        onProgress: (f, msg) => { const now = Date.now(); if (now - last > 120) { last = now; self.postMessage({ type: 'progress', id, f, msg }); } },
      });
      const transfer = [];
      for (const fr of res.frames) transfer.push(fr.h.buffer, fr.m.buffer, fr.alpha.buffer, fr.mask.buffer, fr.T.buffer);
      self.postMessage({ type: 'result', id, result: res }, transfer);
    } catch (err) {
      self.postMessage({ type: 'error', id, message: err.message || String(err) });
    }
  } else if (cmd === 'sweep') {
    const out = [];
    const specs = e.data.specs;
    for (let n = 0; n < specs.length; n++) {
      try {
        const res = simulate({ ...specs[n], framesPerStage: 1 }, {
          onProgress: (f, msg) => self.postMessage({ type: 'progress', id, f: (n + f) / specs.length, msg: `Run ${n + 1}/${specs.length} — ${msg}` }),
        });
        const m = res.metrics;
        const item = { ok: true, value: e.data.values[n], dry: m.dry, coverage: m.coverage, cure: m.cureMean, defects: m.defects.map((d) => d.title), wall: res.stats.wallSeconds };
        out.push(item);
        self.postMessage({ type: 'sweepItem', id, n, item });
      } catch (err) {
        const item = { ok: false, value: e.data.values[n], error: err.message };
        out.push(item);
        self.postMessage({ type: 'sweepItem', id, n, item });
      }
    }
    self.postMessage({ type: 'sweepDone', id, out });
  }
};
