// Minimal zero-dependency test harness.
const tests = [];
export function test(name, fn) { tests.push({ name, fn }); }
export function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
export function near(a, b, rtol, msg) {
  const err = Math.abs(a - b) / Math.max(Math.abs(b), 1e-300);
  if (!(err <= rtol)) throw new Error(`${msg || 'value'}: got ${a.toPrecision(5)}, expected ${b.toPrecision(5)} (rel err ${(err * 100).toFixed(2)}% > ${(rtol * 100).toFixed(1)}%)`);
  return err;
}
export async function run() {
  let pass = 0, fail = 0;
  const only = process.argv[2];
  for (const t of tests) {
    if (only && !t.name.includes(only)) continue;
    const t0 = performance.now();
    try {
      const info = await t.fn();
      pass++;
      console.log(`  ✓ ${t.name} (${(performance.now() - t0).toFixed(0)} ms)${info ? ' — ' + info : ''}`);
    } catch (e) {
      fail++;
      console.log(`  ✗ ${t.name}\n      ${e.stack?.split('\n').slice(0, 3).join('\n      ')}`);
    }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}
